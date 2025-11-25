(function() {
    // Track page load origin (navigationStart or timeOrigin)
    const pageLoadOrigin = performance.timeOrigin || performance.timing.navigationStart;
    let gptInitAbsolute = null;
    let gptInitRelative = null;

    // Clear global bidder tracking each load
    window.allBidders = new Set();

    // 1) Ensure pbjs is available
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

    // 2) Ensure GPT is available
    function waitForGPT(callback) {
        let attempts = 0;
        const maxAttempts = 30;
        const interval = 500;
        const checker = setInterval(() => {
            if (window.googletag && window.googletag.pubadsReady) {
                clearInterval(checker);
                callback(window.googletag.pubads().getSlots());
            } else {
                console.log(`Attila: googletag not ready, retry in ${interval}ms (Attempt ${++attempts}).`);
                if (attempts >= maxAttempts) clearInterval(checker);
            }
        }, interval);
    }

    // 3) Update a slot’s status cell
    function updateSlotStatus(slotId, state, hasHB = false, hasTAM = false) {
        const elem = document.getElementById(`${slotId}-${state}`);
        if (!elem) return;
        elem.classList.remove("refreshed");
        elem.classList.add("activated");
        if (state === "fetched") {
            elem.innerText = hasHB && hasTAM ? 'HB+TAM' : hasHB ? 'HB' : hasTAM ? 'TAM' : 'Yes';
        } else {
            elem.innerText = "Yes";
        }
    }

    // Track known slots
    const knownSlotIds = new Set();

    // 4) Log slots in console
    function logAllSlotsTable() {
        const all = window.googletag.pubads().getSlots();
        const info = all.map(slot => ({
            slotId: slot.getSlotElementId(),
            sizes: slot.getSizes().map(s => `${s.getWidth()}x${s.getHeight()}`).join(", ")
        }));
        console.log("=== Current GPT Slots ===");
        console.table(info);
    }

    // 5) Create a table row
    function createTableRow(slot) {
        const id = slot.getSlotElementId();
        const sizes = slot.getSizes().map(s => `${s.getWidth()}x${s.getHeight()}`).join(', ');
        return `
      <tr>
        <td><button id="${id}-jumpButton" data-slotid="${id}">to slot</button></td>    
        <td class="slot-size" id="${id}-slotNameCell">${id}</td>
        <td class="slot-name">${sizes}</td>
        <td id="${id}-bidders">None</td>
        <td id="${id}-fetched">No</td>
        <td id="${id}-ad_response">No</td>
        <td id="${id}-rendering">No</td>
        <td id="${id}-rendered">No</td>
        <td id="${id}-viewed">No</td>
        <td id="${id}-fetchTime">–</td>
      </tr>`;
    }

    // 6) Jump-to-slot listener
    function attachJumpListener(id) {
        const btn = document.getElementById(`${id}-jumpButton`);
        if (!btn) return;
        btn.addEventListener('click', () => {
            const el = document.getElementById(id);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'end' });
                el.classList.add('slot-highlight');
                setTimeout(() => el.classList.remove('slot-highlight'), 3000);
            } else {
                console.warn("No DOM element with ID:", id);
            }
        });
    }

    // 7) Build initial floating table
    function buildInitialTable(slots) {
        const rows = slots.map(s => {
            const id = s.getSlotElementId();
            knownSlotIds.add(id);
            return createTableRow(s);
        }).join('');
        logAllSlotsTable();

        const style = `
      <style>
        .status-panel { color: lightgreen; position: fixed; width: 100%; max-height: 50%; left: 0; right: 0; top: 0; background: rgba(0,0,0,0.8); z-index: 1000; cursor: pointer; padding: 10px; overflow-y: auto; }
        .status-panel.collapsed { height: 40px; overflow: hidden; }
        .status-panel th, .status-panel td { padding: 6px; text-align: center; white-space: nowrap; }
        .status-panel th { background: #444; color: white; }
        .status-panel td.activated { background-color: blue !important; color: white; }
        .status-panel td.refreshed { background-color: yellow !important; color: black; }
        .status-panel td.slow { background-color: orange !important; color: black; }
        .status-panel td:not(.slot-name):not(.slot-size) { background-color: red; }
        .slot-highlight { outline: 3px solid red; transition: outline 0.3s ease-in-out; }
      </style>`;

        const panel = `
      <div class="status-panel">
        <button onclick="togglePanel()">Toggle</button>
        <table>
          <thead>
            <tr>
              <th>jump</th><th>Ad Slot</th><th>Slot Size</th><th>Bidder</th><th>Fetched?</th><th>Responded?</th><th>Rendering?</th><th>Rendered?</th><th>Viewed?</th><th>Fetch Time (ms)</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

        document.body.insertAdjacentHTML('beforebegin', style + panel);
        window.togglePanel = () => document.querySelector('.status-panel').classList.toggle('collapsed');
        slots.forEach(s => attachJumpListener(s.getSlotElementId()));
    }

    // 8) Watch for new slots
    function watchForNewSlots() {
        setTimeout(() => {
            const slots = window.googletag.pubads().getSlots();
            let added = false;
            slots.forEach(s => {
                const id = s.getSlotElementId();
                if (!knownSlotIds.has(id)) {
                    knownSlotIds.add(id);
                    const tbody = document.querySelector('.status-panel table tbody');
                    if (tbody) {
                        tbody.insertAdjacentHTML('beforeend', createTableRow(s));
                        attachJumpListener(id);
                        added = true;
                    }
                }
            });
            if (added) logAllSlotsTable();
            watchForNewSlots();
        }, 2000);
    }

    // 9) Handle refreshed
    function slotRefreshed(id) {
        ['fetched', 'ad_response', 'rendering', 'rendered', 'viewed'].forEach(state => {
            const el = document.getElementById(`${id}-${state}`);
            if (el) {
                el.classList.remove("activated", "slow");
                el.classList.add("refreshed");
                el.innerText = "Refreshed";
            }
        });
    }

    // 10) Initialize GPT listeners
    waitForGPT(slots => {
        console.log(`Attila: Slots initialized (${slots.length} found)`);
        gptInitAbsolute = Date.now();
        gptInitRelative = Math.round(gptInitAbsolute - pageLoadOrigin);
        buildInitialTable(slots);
        watchForNewSlots();

        const firstFetch = {};
        window.googletag.pubads().addEventListener('slotRequested', event => {
            const id = event.slot.getSlotElementId();
            const now = Date.now();
            if (!firstFetch[id]) {
                firstFetch[id] = true;
                const fetchRel = Math.round(now - gptInitAbsolute);
                const totalRel = Math.round(now - pageLoadOrigin);
                const cell = document.getElementById(`${id}-fetchTime`);
                if (cell) cell.innerText = `${gptInitRelative} + ${fetchRel} = ${totalRel}`;
            }
            if (document.getElementById(`${id}-fetched`)?.classList.contains('activated')) {
                slotRefreshed(id);
            }
            updateSlotStatus(id, 'fetched');
        });

        window.googletag.pubads().addEventListener('slotRenderEnded', event => {
            const id = event.slot.getSlotElementId();
            updateSlotStatus(id, 'rendering');
            const cid = event.creativeId;
            if (cid) {
                const cell = document.getElementById(`${id}-slotNameCell`);
                if (cell) cell.innerHTML = `<a href="https://admanager.google.com/71347885#creatives/creative/detail/creative_id=${cid}" target="_blank" style="color:yellow;">${id}</a>`;
            }
        });

        window.googletag.pubads().addEventListener('slotResponseReceived', event => {
            const id = event.slot.getSlotElementId();
            const hasHB = event.slot.getTargetingKeys().includes('hb_pb');
            const hasTAM = event.slot.getTargetingKeys().includes('amznbid');
            let highestCpm = 0, highestBidder = null;
            let disp = 'None';
            if (window.pbjs) {
                const resp = pbjs.getBidResponsesForAdUnitCode(id);
                if (resp?.bids?.length) {
                    const order = [];
                    resp.bids.forEach(b => {
                        if (b.cpm > highestCpm) { highestCpm = b.cpm; highestBidder = b.bidder; }
                        if (!order.includes(b.bidder)) order.push(b.bidder);
                        window.allBidders.add(b.bidder);
                    });
                    disp = order.map(n => n === highestBidder ? `<span style="color:yellow;">${n}</span>` : n).join(', ');
                }
            }
            document.getElementById(`${id}-bidders`).innerHTML = disp;
            updateSlotStatus(id, 'fetched', hasHB, hasTAM);
            updateSlotStatus(id, 'ad_response');
        });

        window.googletag.pubads().addEventListener('slotOnload', event =>
            updateSlotStatus(event.slot.getSlotElementId(), 'rendered')
        );
        window.googletag.pubads().addEventListener('impressionViewable', event =>
            updateSlotStatus(event.slot.getSlotElementId(), 'viewed')
        );
    });
})();
