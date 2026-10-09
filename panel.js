// One monitor page for three views, picked by ?mode=
//   sidepanel (default): follows the active tab of the window the panel is in
//   window:              follows the active tab of the last focused browser window
//   devtools:            follows the inspected tab
const mode = new URLSearchParams(location.search).get('mode') || 'sidepanel';
const root = document.getElementById('monitor');

const styleTag = document.createElement('style');
styleTag.textContent = MonitorView.css;
document.head.append(styleTag);

const show = (state, onJump) => MonitorView.render(root, state, { onJump });
const showMessage = (text) => MonitorView.showMessage(root, text);

if (mode === 'devtools') {
    // DevTools pages can't rely on the tabs API, so read the page's state directly
    const evalInPage = (code, callback) => chrome.devtools.inspectedWindow.eval(code, callback);
    const jump = (id) => evalInPage(`window.__idnmlMonitor && window.__idnmlMonitor.jump(${JSON.stringify(id)})`);

    function poll() {
        evalInPage('window.__idnmlMonitor ? window.__idnmlMonitor.snapshot() : null', (state, error) => {
            if (error || !state) showMessage('Monitor is not running on this page. Enable it in the toolbar popup and reload the page.');
            else show(state, jump);
        });
    }
    poll();
    setInterval(poll, 500);
} else {
    let activeTabId = null;
    const jump = (id) => chrome.tabs.sendMessage(activeTabId, { type: 'jump', id }).catch(() => {});

    function requestState() {
        if (activeTabId == null) {
            showMessage('No active tab.');
            return;
        }
        chrome.tabs.sendMessage(activeTabId, { type: 'getState' })
            .then(resp => {
                if (resp?.enabled === false) showMessage('Monitor is off. Enable it in the toolbar popup, then reload the page.');
                else show(resp?.state, jump);
            })
            .catch(() => showMessage('This page is not monitored (not a listed site, or loaded before the extension). Reload it if it should be.'));
    }

    async function trackActiveTab() {
        let tab;
        if (mode === 'window') {
            const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
            [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
        } else {
            [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        }
        activeTabId = tab?.id ?? null;
        requestState();
    }

    chrome.tabs.onActivated.addListener(trackActiveTab);
    if (mode === 'window') {
        chrome.windows.onFocusChanged.addListener((windowId) => {
            if (windowId !== chrome.windows.WINDOW_ID_NONE) trackActiveTab();
        });
    }

    chrome.tabs.onUpdated.addListener((tabId, info) => {
        if (tabId !== activeTabId) return;
        if (info.status === 'loading') showMessage('Loading…');
        if (info.status === 'complete') requestState();
    });

    // Live snapshots relayed by content.js
    chrome.runtime.onMessage.addListener((msg, sender) => {
        if (msg.type === 'state' && sender.tab?.id === activeTabId) show(msg.state, jump);
    });

    trackActiveTab();
}
