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
        .monitor .bidders { margin: 4px 0; color: #ddd; word-break: break-word; }
        .monitor .bidders .winner { color: yellow; }
        .monitor .stages { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 2px; text-align: center; }
        .monitor .stages > div { padding: 2px 0; min-width: 0; }
        .monitor .stages .label, .monitor .stages .value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .monitor .stages .value { font-weight: 600; }

        @container (min-width: 760px) {
            .monitor .timings { flex-direction: row; }
            .monitor .slot-header, .monitor .slot {
                display: grid;
                grid-template-columns: 70px minmax(160px, 1.2fr) minmax(100px, 0.8fr) minmax(160px, 1.6fr) repeat(5, 84px);
                gap: 2px; margin: 0 0 2px; padding: 0; border-radius: 0; background: none;
            }
            .monitor .slot-header > div { background: #444; color: white; font-weight: 600; padding: 6px; text-align: center; }
            .monitor .slot-head, .monitor .stages { display: contents; }
            .monitor .slot-head > :not(button), .monitor .bidders { background: #222; margin: 0; padding: 6px; display: flex; align-items: center; }
            .monitor .slot-head > button { margin: 4px; }
            .monitor .bidders { display: block; }
            .monitor .stages > div { display: flex; align-items: center; justify-content: center; padding: 6px; }
            .monitor .stages .label { display: none; }
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
        jump.addEventListener('click', () => onJump(slot.id));
        let name;
        if (slot.creativeId) {
            name = el('a', 'slot-name', slot.id);
            name.href = CREATIVE_URL + slot.creativeId;
            name.target = '_blank';
            name.title = `Creative ${slot.creativeId} in Ad Manager`;
        } else {
            name = el('span', 'slot-name', slot.id);
        }
        head.append(jump, name, el('span', 'sizes', slot.sizes));

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

    // root must carry the "monitor" class
    function showMessage(root, text) {
        lastRendered.delete(root);
        root.replaceChildren(el('div', 'message', text));
    }

    function render(root, state, { onJump }) {
        if (!state) {
            showMessage(root, 'Waiting for the page…');
            return;
        }
        // Skip identical snapshots so polling views keep hover and selection
        const json = JSON.stringify(state);
        if (lastRendered.get(root) === json) return;
        lastRendered.set(root, json);

        const children = [el('div', 'page-url', state.url), renderTimings(state.timings)];
        if (!state.gptLoaded) {
            children.push(el('div', 'message', 'Waiting for GPT…'));
        } else if (!state.slots.length) {
            children.push(el('div', 'message', 'GPT loaded, no slots defined yet.'));
        } else {
            children.push(renderHeader());
            state.slots.forEach(slot => children.push(renderSlot(slot, onJump)));
        }
        root.replaceChildren(...children);
    }

    return { css, render, showMessage };
})();
