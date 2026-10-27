// Shared renderer for every view: on-page overlay, side panel, separate window and DevTools tab.
// Narrow containers get one card per slot; wide ones (760px+) get the classic table layout.
const MonitorView = (() => {
    const STAGES = [
        ['fetched', 'Fetched'],
        ['ad_response', 'Response'],
        ['rendering', 'Rendering'],
        ['rendered', 'Rendered'],
        ['viewed', 'Viewed'],
    ];
    const CREATIVE_URL = 'https://admanager.google.com/71347885#creatives/creative/detail/creative_id=';

    const css = `
        .monitor { container-type: inline-size; color: lightgreen; font: 12px/1.35 system-ui, sans-serif; text-align: left; }
        .monitor * { box-sizing: border-box; }
        .monitor button { cursor: pointer; font: inherit; }
        .monitor button:disabled { cursor: default; opacity: 0.4; }
        .monitor .page-url { color: #999; font-size: 11px; word-break: break-all; margin-bottom: 8px; }
        .monitor .message { padding: 12px; background: #222; color: #ccc; border-radius: 4px; }

        /* Red = not yet, blue = done, yellow = refreshed */
        .monitor .pending { background: red; color: white; }
        .monitor .done { background: blue; color: white; }
        .monitor .refreshed { background: yellow; color: black; }

        .monitor .timings { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; text-align: center; }
        .monitor .timings .half { flex: 1; padding: 6px; }
        .monitor .timings .value { font-size: 18px; }
        .monitor .label { font-size: 10px; opacity: 0.8; }
        .monitor .label:empty { display: none; }

        .monitor .slot-header { display: none; }
        .monitor .slot { background: #222; border-radius: 4px; padding: 6px; margin-bottom: 6px; }
        .monitor .slot-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; }
        .monitor .slot-name { flex: 1; min-width: 0; color: lightgreen; font-weight: 600; word-break: break-all; }
        .monitor a.slot-name { color: yellow; }
        .monitor .sizes { color: #aaa; font-size: 11px; }
        .monitor .format { background: #a0f; color: white; border-radius: 3px; padding: 0 4px; margin-right: 4px; white-space: nowrap; }
        .monitor .message + .message { margin-top: 4px; }
        .monitor .message.warning { background: #530; margin-bottom: 6px; }
        .monitor .bidders { margin: 4px 0; color: #ddd; word-break: break-word; }
        .monitor .bidders .winner { color: yellow; }
        .monitor .stages { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 2px; text-align: center; }
        .monitor .stages > div { padding: 2px 0; min-width: 0; }
        .monitor .stages .label, .monitor .stages .value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .monitor .stages .value { font-weight: 600; }

        .monitor .tabs { display: flex; gap: 2px; margin-bottom: 8px; border-bottom: 2px solid #555; }
        .monitor .tabs button { flex: 1; padding: 6px; border: 0; border-radius: 4px 4px 0 0; background: #2a2a2a; color: #aaa; }
        .monitor .tabs button.active { background: #555; color: white; font-weight: 600; }

        /* Delivery & refresh tab: one card per slot, one grid row per slot when wide */
        .monitor .refresh-settings { background: #222; color: #ccc; padding: 6px; margin-bottom: 8px; border-radius: 4px; }
        .monitor .rtable-header { display: none; }
        .monitor .rrow { background: #222; border-radius: 4px; padding: 6px; margin-bottom: 6px; color: #ddd; }
        .monitor .rrow > div { margin-bottom: 4px; word-break: break-word; }
        .monitor .rrow > div > .label { color: #888; opacity: 1; }
        .monitor .rrow a { color: yellow; }
        .monitor .key { color: #888; margin-right: 3px; }
        .monitor .muted { color: #777; }
        .monitor .chip { display: inline-block; border-radius: 3px; padding: 0 4px; margin: 2px 4px 0 0; font-size: 11px; }
        .monitor .chip.on { background: #063; color: white; }
        .monitor .chip.off { background: #a00; color: white; }
        .monitor .chip.force { background: #a80; color: white; }

        /* Wide: one grid for all slots, with 1px lines between the cells */
        @container (min-width: 760px) {
            .monitor .timings { flex-direction: row; }
            .monitor .slots {
                display: grid;
                grid-template-columns: 70px minmax(160px, 1.2fr) minmax(100px, 0.8fr) minmax(160px, 1.6fr) repeat(5, 84px);
                gap: 1px; background: #555; border: 1px solid #555;
            }
            .monitor .slot-header, .monitor .slot, .monitor .slot-head, .monitor .stages { display: contents; }
            .monitor .slot-header > div { background: #444; color: white; font-weight: 600; padding: 6px; text-align: center; }
            .monitor .slot-head > *, .monitor .bidders { background: #222; margin: 0; padding: 6px; display: flex; align-items: center; }
            .monitor .bidders { display: block; }
            .monitor .stages > div { display: flex; align-items: center; justify-content: center; padding: 6px; }
            .monitor .stages .label { display: none; }

            .monitor .rtable {
                display: grid;
                grid-template-columns: minmax(160px, 1.3fr) minmax(100px, 0.7fr) minmax(150px, 1fr) minmax(180px, 1.4fr) minmax(150px, 1fr) minmax(150px, 1fr);
                gap: 1px; background: #555; border: 1px solid #555;
            }
            .monitor .rtable-header, .monitor .rrow { display: contents; }
            .monitor .rtable-header > div { background: #444; color: white; font-weight: 600; padding: 6px; text-align: center; }
            .monitor .rrow > div { background: #222; margin: 0; padding: 6px; }
            .monitor .rrow > div > .label { display: none; }
        }
    `;

    // Last snapshot drawn into each root
    const lastRendered = new WeakMap();

    // Page data is always set as text, never as HTML
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function renderTimings(t) {
        const box = el('section', 'timings');

        const tcf = el('div', `half ${t.tcfReady != null ? 'done' : 'pending'}`);
        tcf.title = 'ms from dlt until __tcfapi reported consent ready (tcloaded or useractioncomplete). ≤ means consent was already ready when the monitor hooked in';
        tcf.append(
            el('div', 'label', 'TCF ready (dlt)'),
            el('div', 'value', t.tcfReady != null ? `${t.tcfApprox ? '≤ ' : ''}${t.tcfReady}` : '–'),
            el('div', 'label', t.tcfStatus || ''),
        );

        const gam = el('div', `half ${t.firstRequest != null ? 'done' : 'pending'}`);
        gam.title = 'GAM method: from dlt (domLoading). idt (pubads_impl loaded) + to first ad request = total';
        let gamText = '–';
        if (t.firstRequest != null) {
            gamText = t.tagLoaded != null
                ? `${t.tagLoaded} + ${t.firstRequest - t.tagLoaded} = ${t.firstRequest}`
                : `? + ? = ${t.firstRequest}`;
        }
        gam.append(el('div', 'label', 'GAM (dlt): tag loaded + gap = 1st ad request'), el('div', 'value', gamText));

        box.append(tcf, gam);
        return box;
    }

    function renderHeader() {
        const header = el('div', 'slot-header');
        ['jump', 'Ad Slot', 'Sizes', 'Bidders', ...STAGES.map(([, label]) => label)].forEach(text => header.append(el('div', null, text)));
        return header;
    }

    function renderSlot(slot, onJump) {
        const card = el('div', 'slot');

        const head = el('div', 'slot-head');
        const jump = el('button', null, 'to slot');
        if (slot.jumpable === false) {
            // Interstitials, anchors etc. live in a container GPT manages, not a div on the page
            jump.disabled = true;
            jump.title = 'GPT shows this slot itself; there is no slot div to scroll to';
        } else {
            jump.addEventListener('click', () => onJump(slot.id));
        }
        let name;
        if (slot.creativeId) {
            name = el('a', 'slot-name', slot.id);
            name.href = CREATIVE_URL + slot.creativeId;
            name.target = '_blank';
            name.title = `Creative ${slot.creativeId} in Ad Manager`;
        } else {
            name = el('span', 'slot-name', slot.id);
        }
        const sizes = el('span', 'sizes');
        if (slot.format) sizes.append(el('span', 'format', slot.format));
        sizes.append(slot.sizes);
        // Wrapped so the button sits in its own grid cell in the wide layout
        const jumpCell = el('div', 'jump-cell');
        jumpCell.append(jump);
        head.append(jumpCell, name, sizes);

        const bidders = el('div', 'bidders');
        if (slot.bidders.length) {
            slot.bidders.forEach((b, i) => {
                if (i) bidders.append(', ');
                bidders.append(el('span', b === slot.winner ? 'winner' : null, b));
            });
        } else {
            bidders.textContent = 'Bidders: none';
        }

        const stages = el('div', 'stages');
        STAGES.forEach(([key, label]) => {
            const value = slot.status[key];
            const cell = el('div', value == null ? 'pending' : value === 'Refreshed' ? 'refreshed' : 'done');
            cell.append(el('div', 'label', label), el('div', 'value', value ?? 'No'));
            stages.append(cell);
        });

        card.append(head, bidders, stages);
        return card;
    }

    // --- Delivery & refresh tab ------------------------------------------------------

    const seconds = ms => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s`;

    // A grid cell; the label only shows in the narrow card layout (the header names the column when wide)
    function cell(label, ...content) {
        const node = el('div');
        node.append(el('div', 'label', label), ...content);
        return node;
    }

    function line(...content) {
        const node = el('div');
        node.append(...content);
        return node;
    }

    function keyValue(key, value) {
        return line(el('span', 'key', key), value ?? '–');
    }

    function chip(className, text) {
        return el('span', `chip ${className}`, text);
    }

    function renderRefreshSettings(settings) {
        if (!settings) return el('div', 'message warning', 'JSGlobals.adConfig.AdSlotRules not found on this page, so no refresh rules to show');
        const box = el('div', 'refresh-settings');
        box.append(
            el('span', 'key', 'Site refresh'), settings.refresh ? chip('on', 'on') : chip('off', 'off'),
            el('span', 'key', ' default interval'), settings.intervalMS != null ? seconds(settings.intervalMS) : '–',
            el('span', 'key', ' · render margin'), settings.renderMarginPercent != null ? `${settings.renderMarginPercent}%` : '–',
            el('span', 'key', ' · mobile scaling'), String(settings.mobileScaling ?? '–'),
        );
        return box;
    }

    function renderRefreshHeader() {
        const header = el('div', 'rtable-header');
        ['Ad Slot', 'Expected refresh', 'Advertiser', 'Order (campaign)', 'Line item / creative / deal', 'Measured refresh']
            .forEach(text => header.append(el('div', null, text)));
        return header;
    }

    function renderRefreshRow(slot, settings) {
        const row = el('div', 'rrow');
        const rules = slot.rules;
        const d = slot.delivery;

        const name = line(el('span', 'slot-name', slot.id));
        if (slot.format) name.prepend(el('span', 'format', slot.format));
        // Matched slot rule: refresh on/off and its interval (0 means the site default)
        let slotRule = '';
        if (rules && !rules.slotKey) slotRule = line(el('span', 'muted', 'no slot rule matched'));
        else if (rules?.slot) {
            const interval = rules.slot.intervalMS ? seconds(rules.slot.intervalMS)
                : settings?.intervalMS ? `${seconds(settings.intervalMS)} (default)` : '';
            slotRule = line(el('span', 'key', `rule ${rules.slotKey}`), rules.slot.refresh ? `on · ${interval}` : 'off');
        }
        const slotCell = cell('Ad Slot', name, slotRule);

        let advertiser, order, ids;
        if (!d || d.empty) {
            const text = d?.empty ? 'No fill' : 'Waiting for render…';
            advertiser = el('span', 'muted', text);
            order = el('span', 'muted', text);
            ids = slot.deal ? keyValue('Deal', slot.deal) : el('span', 'muted', text);
        } else {
            advertiser = renderRuleOwner(rules?.advertiser, 'Advertiser', d.advertiserId, rule => [
                rule.forceRefresh && chip('force', 'force refresh (sponsorships refresh)'),
                rule.disableRefresh && chip('off', 'refresh disabled'),
                rule.customTimeout && chip('force', `custom timeout ${seconds(rule.customTimeoutMS || 0)}`),
            ]);
            order = renderRuleOwner(rules?.campaign, 'Order', d.orderId, rule => [
                rule.disableRefresh && chip('off', 'refresh disabled'),
                rule.customTimeout && chip('force', `custom timeout ${seconds(rule.customTimeoutMS || 0)}`),
            ]);
            const creative = d.creativeId != null ? el('a', null, String(d.creativeId)) : null;
            if (creative) {
                creative.href = CREATIVE_URL + d.creativeId;
                creative.target = '_blank';
                creative.title = 'Open in Ad Manager';
            }
            ids = el('div');
            ids.append(keyValue('Line item', d.lineItemId ?? d.sourceAgnosticLineItemId), keyValue('Creative', creative), keyValue('Deal', slot.deal));
        }

        row.append(
            slotCell,
            cell('Expected refresh', renderExpected(slot.expected)),
            cell('Advertiser', advertiser),
            cell('Order (campaign)', order),
            cell('Line item / creative / deal', ids),
            cell('Measured refresh', renderMeasuredRefresh(slot.refresh)),
        );
        return row;
    }

    // Name from AdSlotRules (or "not in rules"), the GAM id, and chips for the refresh flags that are set
    function renderRuleOwner(rule, idLabel, id, flags) {
        const box = el('div');
        if (id == null) {
            box.append(el('span', 'muted', '–'));
            return box;
        }
        box.append(rule ? line(rule.key) : line(el('span', 'muted', 'not in rules')), keyValue(idLabel, id));
        if (rule) {
            const set = flags(rule).filter(Boolean);
            box.append(set.length ? line(...set) : line(el('span', 'muted', 'no refresh overrides')));
        }
        return box;
    }

    // Verdict for the current ad, worked out by inject.js from AdSlotRules and the takeover check
    function renderExpected(expected) {
        if (!expected) return el('span', 'muted', '–');
        const box = el('div');
        if (expected.refresh === true) {
            box.append(line(chip('on', 'refresh'), expected.intervalMS ? seconds(expected.intervalMS) : ''));
        } else if (expected.refresh === false) {
            box.append(line(chip('off', 'no refresh')));
        }
        box.append(line(el('span', 'muted', expected.reason)));
        return box;
    }

    // Measured against the verdict for the ad that was replaced. Later than expected is normal (refresh
    // timers pause while the slot is out of view); a refresh that shouldn't happen, or comes early, is flagged
    function refreshWarning(entry) {
        const exp = entry.expected;
        if (exp?.refresh === false) return chip('off', `shouldn't have refreshed: ${exp.reason}`);
        if (exp?.refresh && exp.intervalMS && entry.from === 'view' && entry.ms < exp.intervalMS - 500) {
            return chip('force', `early, expected ${seconds(exp.intervalMS)}`);
        }
        return null;
    }

    // From the viewable event to the next ad request for the slot
    function renderMeasuredRefresh(r) {
        const box = el('div');
        if (!r) return box;
        const [last, ...earlier] = r.history;
        if (last) {
            box.append(line(el('span', 'value', seconds(last.ms)),
                el('span', 'muted', last.from === 'view' ? ' after view' : ' after request (never viewed)')));
            const warning = refreshWarning(last);
            if (warning) box.append(line(warning));
        }
        if (r.viewedAt) box.append(line(el('span', 'muted', 'viewed, waiting for refresh')));
        else if (!last) box.append(el('span', 'muted', 'not viewed yet'));
        if (r.count) box.append(keyValue('Refreshes', r.count));
        if (earlier.length) {
            const flagged = earlier.filter(refreshWarning).length;
            box.append(keyValue('Earlier', earlier.map(h => seconds(h.ms)).join(', ')));
            if (flagged) box.append(line(chip('off', `${flagged} earlier refresh${flagged > 1 ? 'es' : ''} broke the rules`)));
        }
        return box;
    }

    // Line items showing in more than one slot; they only refresh if the advertiser has force refresh
    function renderSponsorships(sponsorships) {
        const box = el('div', 'refresh-settings');
        box.append(el('span', 'key', 'Sponsorships'));
        if (!sponsorships?.length) {
            box.append(el('span', 'muted', 'none (no line item in more than one slot)'));
        }
        sponsorships?.forEach(sp => {
            box.append(line(
                sp.exempt ? chip('force', 'refreshes (force refresh)') : chip('off', 'refresh blocked'),
                `Line item ${sp.lineItemId} on ${sp.slotCount} slots · ${sp.name || 'advertiser not in rules'} (${sp.advertiserId})`,
            ));
        });
        return box;
    }

    // --- Rendering -----------------------------------------------------------------

    const TABS = [['slots', 'Slots'], ['refresh', 'Delivery & refresh']];
    // Selected tab and last render arguments per root, so a tab click can redraw straight away
    const selectedTab = new WeakMap();
    const lastArgs = new WeakMap();

    function renderTabs(root, current) {
        const bar = el('div', 'tabs');
        TABS.forEach(([key, label]) => {
            const button = el('button', key === current ? 'active' : null, label);
            button.addEventListener('click', () => {
                selectedTab.set(root, key);
                const [state, options] = lastArgs.get(root);
                render(root, state, options);
            });
            bar.append(button);
        });
        return bar;
    }

    // root must carry the "monitor" class
    function showMessage(root, text) {
        lastRendered.delete(root);
        root.replaceChildren(el('div', 'message', text));
    }

    function render(root, state, options) {
        if (!state) {
            showMessage(root, 'Waiting for the page…');
            return;
        }
        lastArgs.set(root, [state, options]);
        const tab = selectedTab.get(root) || 'slots';
        // Skip identical snapshots so polling views keep hover and selection
        const json = tab + JSON.stringify(state);
        if (lastRendered.get(root) === json) return;
        lastRendered.set(root, json);

        const children = [renderTabs(root, tab), el('div', 'page-url', state.url)];
        if (tab === 'slots') {
            children.push(renderTimings(state.timings));
            (state.unsupportedOop || []).forEach(({ path, format }) => {
                children.push(el('div', 'message warning', `${format} not created for ${path}: GPT says this page or device isn't eligible`));
            });
        } else {
            children.push(renderRefreshSettings(state.refreshSettings));
            if (state.refreshSettings) children.push(renderSponsorships(state.sponsorships));
        }

        if (!state.gptLoaded) {
            children.push(el('div', 'message', 'Waiting for GPT…'));
        } else if (!state.slots.length) {
            children.push(el('div', 'message', 'GPT loaded, no slots defined yet.'));
        } else if (tab === 'slots') {
            const table = el('div', 'slots');
            table.append(renderHeader(), ...state.slots.map(slot => renderSlot(slot, options.onJump)));
            children.push(table);
        } else {
            const table = el('div', 'rtable');
            table.append(renderRefreshHeader(), ...state.slots.map(slot => renderRefreshRow(slot, state.refreshSettings)));
            children.push(table);
        }
        root.replaceChildren(...children);
    }

    return { css, render, showMessage };
})();
