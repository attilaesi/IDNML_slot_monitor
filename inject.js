(function() {
    // Track page load origin (navigationStart or timeOrigin)
    const pageLoadOrigin = performance.timeOrigin || performance.timing.navigationStart;
    const nowAbs = () => pageLoadOrigin + performance.now();

    // GAM measures from dlt, which equals the browser's domLoading (first byte of the HTML)
    function sinceDlt(absTime) {
        const dlt = performance.timing.domLoading || performance.timing.responseStart;
        return Math.round(absTime - dlt);
    }

    // Ad lifecycle stages shown per slot, in order
    const STAGES = ['fetched', 'ad_response', 'rendering', 'rendered', 'viewed'];

    // Everything the side panel shows. Slot status values: missing = not yet, 'Refreshed', or the text to show
    const slots = {};
    const slotOrder = [];
    let gptLoaded = false;

    // Absolute times (ms since epoch) of the page-level milestones
    const milestones = { firstRequest: null, tcfReady: null, tcfStatus: null, tcfApprox: false };

    // 1) Send a snapshot to content.js, which relays it to the side panel (batched to one per 100ms)
    let publishTimer = null;
    function publish() {
        if (publishTimer) return;
        publishTimer = setTimeout(() => {
            publishTimer = null;
            window.postMessage({ source: 'idnml-monitor', state: snapshot() }, '*');
        }, 100);
    }

    function snapshot() {
        const timings = { tcfReady: null, tcfApprox: milestones.tcfApprox, tcfStatus: milestones.tcfStatus, tagLoaded: null, firstRequest: null };
        if (milestones.tcfReady) timings.tcfReady = sinceDlt(milestones.tcfReady);
        if (milestones.firstRequest) timings.firstRequest = sinceDlt(milestones.firstRequest);
        // idt: when GPT's main library finished loading
        const impl = performance.getEntriesByType('resource').find(e => e.name.includes('pubads_impl'));
        if (impl) timings.tagLoaded = sinceDlt(pageLoadOrigin + impl.responseEnd);
        return { url: location.href, gptLoaded, slots: slotOrder.map(id => slots[id]), timings };
    }

    function recordFirstRequest() {
        if (milestones.firstRequest) return;
        milestones.firstRequest = nowAbs();
        publish();
    }

    // 2) Watch for TCF consent being ready: tcloaded = stored consent, useractioncomplete = user clicked in the banner
    function watchTcf(attempts = 0) {
        if (typeof window.__tcfapi !== 'function') {
            if (attempts < 300) {
                setTimeout(() => watchTcf(attempts + 1), 50);
            } else {
                milestones.tcfStatus = 'no CMP';
                publish();
            }
            return;
        }
        const hookedAt = nowAbs();
        window.__tcfapi('addEventListener', 2, (tcData, success) => {
            if (!success || milestones.tcfReady) return;
            if (tcData.eventStatus === 'cmpuishown') {
                milestones.tcfStatus = 'banner shown';
                publish();
            } else if (tcData.eventStatus === 'tcloaded' || tcData.eventStatus === 'useractioncomplete') {
                milestones.tcfReady = nowAbs();
                // Fired straight after we hooked in: consent was already ready, so the real time is earlier
                milestones.tcfApprox = milestones.tcfReady - hookedAt < 20;
                milestones.tcfStatus = tcData.gdprApplies === false ? 'GDPR n/a'
                    : tcData.eventStatus === 'tcloaded' ? 'stored consent' : 'user clicked';
                publish();
            }
        });
    }
    watchTcf();

    // Clear global bidder tracking each load
    window.allBidders = new Set();

    // 3) Ensure pbjs is available
    function waitForPbjs() {
        if (!window.pbjs) {
            console.log("Attila: pbjs not ready, retry in 500ms.");
            setTimeout(waitForPbjs, 500);
            return;
        }
        if (typeof pbjs.getBidderCodes === 'function') {
            const codes = pbjs.getBidderCodes();
            codes.forEach(code => window.allBidders.add(code));
            console.log("Added all possible bidder codes:", codes);
        }
    }
    waitForPbjs();

    // 4) Ensure GPT is available (fallback in case the page replaces our googletag.cmd queue)
    function waitForGPT(callback) {
        let attempts = 0;
        const maxAttempts = 60;
        const interval = 500;
        const checker = setInterval(() => {
            if (window.googletag && window.googletag.pubadsReady) {
                clearInterval(checker);
                callback();
            } else {
                console.log(`Attila: googletag not ready, retry in ${interval}ms (Attempt ${++attempts}).`);
                if (attempts >= maxAttempts) clearInterval(checker);
            }
        }, interval);
    }

    // 5) Slot bookkeeping
    function formatSizes(slot) {
        return slot.getSizes().map(s => typeof s === 'string' ? s : `${s.getWidth()}x${s.getHeight()}`).join(', ');
    }

    function ensureSlot(slot) {
        const id = slot.getSlotElementId();
        if (!slots[id]) {
            slots[id] = { id, sizes: formatSizes(slot), bidders: [], winner: null, creativeId: null, status: {} };
            slotOrder.push(id);
        }
        return slots[id];
    }

    function setStatus(slot, stage, text = 'Yes') {
        ensureSlot(slot).status[stage] = text;
        publish();
    }

    function logAllSlotsTable() {
        const all = window.googletag.pubads().getSlots();
        const info = all.map(slot => ({ slotId: slot.getSlotElementId(), sizes: formatSizes(slot) }));
        console.log("=== Current GPT Slots ===");
        console.table(info);
    }

    // Pick up slots that are defined but not requested yet (lazy-loaded, infinite scroll)
    function syncSlots() {
        const before = slotOrder.length;
        window.googletag.pubads().getSlots().forEach(ensureSlot);
        if (slotOrder.length !== before) {
            logAllSlotsTable();
            publish();
        }
    }

    // 6) GPT listeners
    let listenersAttached = false;
    function attachGptListeners() {
        if (listenersAttached) return;
        listenersAttached = true;
        gptLoaded = true;
        console.log('Attila: GPT listeners attached');
        const pubads = window.googletag.pubads();

        pubads.addEventListener('slotRequested', event => {
            recordFirstRequest();
            const s = ensureSlot(event.slot);
            if (s.status.fetched) STAGES.forEach(stage => { s.status[stage] = 'Refreshed'; });
            setStatus(event.slot, 'fetched');
        });

        pubads.addEventListener('slotResponseReceived', event => {
            const s = ensureSlot(event.slot);
            const keys = event.slot.getTargetingKeys();
            const hasHB = keys.includes('hb_pb');
            const hasTAM = keys.includes('amznbid');
            let highestCpm = 0;
            s.bidders = [];
            s.winner = null;
            if (window.pbjs) {
                const resp = pbjs.getBidResponsesForAdUnitCode(s.id);
                (resp?.bids || []).forEach(b => {
                    if (b.cpm > highestCpm) { highestCpm = b.cpm; s.winner = b.bidder; }
                    if (!s.bidders.includes(b.bidder)) s.bidders.push(b.bidder);
                    window.allBidders.add(b.bidder);
                });
            }
            setStatus(event.slot, 'fetched', hasHB && hasTAM ? 'HB+TAM' : hasHB ? 'HB' : hasTAM ? 'TAM' : 'Yes');
            setStatus(event.slot, 'ad_response');
        });

        pubads.addEventListener('slotRenderEnded', event => {
            ensureSlot(event.slot).creativeId = event.creativeId || null;
            setStatus(event.slot, 'rendering');
        });

        pubads.addEventListener('slotOnload', event => setStatus(event.slot, 'rendered'));
        pubads.addEventListener('impressionViewable', event => setStatus(event.slot, 'viewed'));

        syncSlots();
        setInterval(syncSlots, 2000);
    }

    // cmd runs as soon as GPT loads, before any ad request, so the first request is never missed
    window.googletag = window.googletag || { cmd: [] };
    window.googletag.cmd.push(attachGptListeners);
    waitForGPT(attachGptListeners);

    // 7) Jump to a slot: scroll it into view and outline it for 3s
    function jump(id) {
        const el = document.getElementById(id);
        if (!el) {
            console.warn("No DOM element with ID:", id);
            return;
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'end' });
        const previousOutline = el.style.outline;
        el.style.outline = '3px solid red';
        setTimeout(() => { el.style.outline = previousOutline; }, 3000);
    }

    // Requests from the overlay, side panel and window (relayed by content.js)
    window.addEventListener('message', event => {
        if (event.source !== window || event.data?.source !== 'idnml-panel' || event.data.type !== 'jump') return;
        jump(event.data.id);
    });

    // The DevTools tab reads and drives the monitor through this
    window.__idnmlMonitor = { snapshot, jump };

    publish();
})();
