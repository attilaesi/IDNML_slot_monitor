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
    // Out-of-page slots GPT refused to create (defineOutOfPageSlot returned null): { path, format }
    const unsupportedOop = [];

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
        // Read on every snapshot: the site's ad config can arrive after the monitor starts
        const rules = adSlotRules();
        const sponsored = sponsorships(rules);
        return {
            url: location.href, gptLoaded, unsupportedOop, timings,
            refreshSettings: rules ? rules.settings || {} : null,
            sponsorships: sponsored,
            slots: slotOrder.map(id => {
                const slotRules = rulesFor(id, rules);
                return { ...slots[id], rules: slotRules, expected: expectedRefresh(id, slotRules, rules, sponsored) };
            }),
        };
    }

    // --- The site's refresh rules: JSGlobals.adConfig.AdSlotRules { settings, slots, advertisers, campaigns } ---

    function adSlotRules() {
        try {
            return window.JSGlobals?.adConfig?.AdSlotRules || null;
        } catch (e) {
            return null;
        }
    }

    // Which AdSlotRules.slots key a slot uses (e.g. mpu1). Tries the element id, the ad unit path and the
    // targeting values: an exact match first, then the longest key that ends one of them after a separator
    // (dfp-ad-mpu1-m -> mpu1-m, not m)
    function matchSlotKey(id, keys) {
        const gptSlot = gptSlots[id];
        const candidates = [id];
        if (gptSlot) {
            candidates.push(...gptSlot.getAdUnitPath().split('/').reverse());
            gptSlot.getTargetingKeys().forEach(k => candidates.push(...gptSlot.getTargeting(k)));
        }
        const strings = candidates.filter(c => typeof c === 'string' && c);
        const exact = strings.find(c => keys.includes(c));
        if (exact) return exact;
        let best = null;
        strings.forEach(c => keys.forEach(k => {
            const before = c[c.length - k.length - 1];
            if (c.length > k.length && c.endsWith(k) && /[^a-z0-9]/i.test(before) && (!best || k.length > best.length)) best = k;
        }));
        return best;
    }

    function rulesFor(id, rules) {
        if (!rules) return null;
        const slotKey = matchSlotKey(id, Object.keys(rules.slots || {}));
        const d = slots[id].delivery;
        return {
            slotKey,
            slot: slotKey ? rules.slots[slotKey] : null,
            advertiser: d?.advertiserId != null ? rules.advertisers?.[d.advertiserId] || null : null,
            campaign: d?.orderId != null ? rules.campaigns?.[d.orderId] || null : null,
        };
    }

    // Sponsorship: the same line item showing in more than one slot. Those slots only refresh if the
    // advertiser has forceRefresh. Uses GPT's own lineItemId, so AdX/backfill (no line item) never counts
    function sponsorships(rules) {
        const byLineItem = {};
        slotOrder.forEach(id => {
            const d = slots[id].delivery;
            if (!d || d.empty || d.lineItemId == null) return;
            (byLineItem[d.lineItemId] = byLineItem[d.lineItemId] || []).push(d);
        });
        return Object.entries(byLineItem).filter(([, ds]) => ds.length > 1).map(([lineItemId, ds]) => {
            const advertiserId = ds[0].advertiserId;
            const rule = rules?.advertisers?.[advertiserId];
            return { lineItemId: Number(lineItemId), advertiserId, name: rule?.key || null, exempt: !!rule?.forceRefresh, slotCount: ds.length };
        });
    }

    // Whether the slot's current ad should refresh: { refresh: true/false/null (unknown), reason, intervalMS }.
    // Refresh needs the site and slot on and no disableRefresh on advertiser or campaign (disable beats force);
    // a sponsorship also needs forceRefresh on the advertiser
    function expectedRefresh(id, slotRules, rules, sponsored) {
        if (!rules) return null;
        const settings = rules.settings || {};
        const off = reason => ({ refresh: false, reason });
        if (settings.refresh === false) return off('site refresh off');
        if (!slotRules.slot) return { refresh: null, reason: 'no slot rule matched' };
        if (!slotRules.slot.refresh) return off('slot rule off');
        const d = slots[id].delivery;
        if (!d) return { refresh: null, reason: 'waiting for render' };
        if (!d.empty) {
            if (slotRules.advertiser?.disableRefresh) return off('advertiser has refresh disabled');
            if (slotRules.campaign?.disableRefresh) return off('order has refresh disabled');
            const sponsorship = sponsored.find(sp => sp.lineItemId === d.lineItemId);
            if (sponsorship && !sponsorship.exempt) return off(`sponsorship (line item on ${sponsorship.slotCount} slots)`);
        }
        // Interval: campaign custom timeout, then the advertiser's, then the slot's, then the site default.
        // A custom timeout only counts when ticked and above 0
        for (const [rule, reason] of [[slotRules.campaign, 'order custom timeout'], [slotRules.advertiser, 'advertiser custom timeout']]) {
            if (rule?.customTimeout && rule.customTimeoutMS) return { refresh: true, intervalMS: rule.customTimeoutMS, reason };
        }
        if (slotRules.slot.intervalMS) return { refresh: true, intervalMS: slotRules.slot.intervalMS, reason: 'slot rule' };
        return { refresh: true, intervalMS: settings.intervalMS || null, reason: 'site default' };
    }

    // The verdict for the ad that is being replaced, worked out just before its refresh request
    function expectedBeforeRefresh(id) {
        const rules = adSlotRules();
        return rules ? expectedRefresh(id, rulesFor(id, rules), rules, sponsorships(rules)) : null;
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
    // Out-of-page slots usually have no sizes
    function formatSizes(slot) {
        return (slot.getSizes() || []).map(s => typeof s === 'string' ? s : `${s.getWidth()}x${s.getHeight()}`).join(', ');
    }

    // Live GPT slot objects by element id (not sent to the views); the latest wins if the page redefines a slot
    const gptSlots = {};

    function ensureSlot(slot) {
        const id = slot.getSlotElementId();
        gptSlots[id] = slot;
        if (!slots[id]) {
            // GPT generates gpt_unit_ ids for out-of-page slots that have no div of their own
            const gptManaged = id.startsWith('gpt_unit_');
            slots[id] = { id, sizes: formatSizes(slot), format: gptManaged ? 'Out-of-page' : null, jumpable: !gptManaged,
                          bidders: [], winner: null, creativeId: null, deal: null, delivery: null, status: {},
                          // Absolute times of the latest request and view; history = last 5 measured gaps, newest first
                          refresh: { requestedAt: null, viewedAt: null, count: 0, history: [] } };
            slotOrder.push(id);
        }
        return slots[id];
    }

    // OutOfPageFormat.INTERSTITIAL -> 'Interstitial', TOP_ANCHOR -> 'Top anchor', ...
    function oopFormatName(formatOrDiv) {
        if (typeof formatOrDiv !== 'number') return 'Out-of-page';
        const entry = Object.entries(window.googletag.enums?.OutOfPageFormat || {}).find(([, v]) => v === formatOrDiv);
        if (!entry) return `Out-of-page (${formatOrDiv})`;
        const words = entry[0].toLowerCase().replace(/_/g, ' ');
        return words[0].toUpperCase() + words.slice(1);
    }

    // Record the format of every out-of-page slot (interstitial, anchor, rewarded...) and flag ones GPT won't create
    function wrapDefineOutOfPageSlot() {
        const original = window.googletag.defineOutOfPageSlot;
        if (typeof original !== 'function' || original.__idnmlWrapped) return;
        const wrapped = function(adUnitPath, formatOrDiv) {
            const slot = original.apply(this, arguments);
            const format = oopFormatName(formatOrDiv);
            if (slot) {
                ensureSlot(slot).format = format;
            } else {
                unsupportedOop.push({ path: adUnitPath, format });
                console.log(`Attila: GPT did not create ${format} slot ${adUnitPath} (page or device not eligible)`);
            }
            publish();
            return slot;
        };
        wrapped.__idnmlWrapped = true;
        window.googletag.defineOutOfPageSlot = wrapped;
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
        wrapDefineOutOfPageSlot();
        const pubads = window.googletag.pubads();

        pubads.addEventListener('slotRequested', event => {
            recordFirstRequest();
            const s = ensureSlot(event.slot);
            const now = nowAbs();
            const r = s.refresh;
            if (s.status.fetched) {
                STAGES.forEach(stage => { s.status[stage] = 'Refreshed'; });
                // Actual refresh time: from the viewable event, or from the last request if it was never viewed
                const from = r.viewedAt ? 'view' : 'request';
                const expected = expectedBeforeRefresh(s.id);
                r.history.unshift({ ms: Math.round(now - (r.viewedAt || r.requestedAt)), from, expected });
                r.history.length = Math.min(r.history.length, 5);
                r.count++;
            }
            r.requestedAt = now;
            r.viewedAt = null;
            setStatus(event.slot, 'fetched');
        });

        pubads.addEventListener('slotResponseReceived', event => {
            const s = ensureSlot(event.slot);
            const keys = event.slot.getTargetingKeys();
            const hasHB = keys.includes('hb_pb');
            const hasTAM = keys.includes('amznbid');
            // Prebid sets hb_deal (or hb_deal_<bidder>) when the bid came through a deal; GAM's own deals aren't exposed to the page
            const dealKey = keys.find(k => k.startsWith('hb_deal'));
            s.deal = dealKey ? event.slot.getTargeting(dealKey)[0] || null : null;
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
            const s = ensureSlot(event.slot);
            s.creativeId = event.creativeId || null;
            // GPT only gives IDs, not names. AdX/backfill has no line item or creative of its own; the views
            // fall back to the source-agnostic IDs for display, the sponsorship check only uses lineItemId
            s.delivery = event.isEmpty ? { empty: true } : {
                advertiserId: event.advertiserId ?? null,
                orderId: event.campaignId ?? null,
                lineItemId: event.lineItemId ?? null,
                sourceAgnosticLineItemId: event.sourceAgnosticLineItemId ?? null,
                creativeId: event.creativeId ?? event.sourceAgnosticCreativeId ?? null,
            };
            setStatus(event.slot, 'rendering');
        });

        pubads.addEventListener('slotOnload', event => setStatus(event.slot, 'rendered'));
        pubads.addEventListener('impressionViewable', event => {
            const r = ensureSlot(event.slot).refresh;
            if (!r.viewedAt) r.viewedAt = nowAbs();
            setStatus(event.slot, 'viewed');
        });

        syncSlots();
        setInterval(syncSlots, 2000);
    }

    // cmd runs as soon as GPT loads, before any ad request, so the first request is never missed.
    // While GPT is still loading cmd is a plain array: go to the front so we run before the page defines its slots
    window.googletag = window.googletag || { cmd: [] };
    window.googletag.cmd = window.googletag.cmd || [];
    if (Array.isArray(window.googletag.cmd)) window.googletag.cmd.unshift(attachGptListeners);
    else window.googletag.cmd.push(attachGptListeners);
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
