importScripts("settings.js");

// The toolbar icon opens the settings popup; the side panel is opened from its tick box.
// A monitor window doesn't survive a browser restart or extension reload, so untick it.
function syncViews() {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
    chrome.storage.local.remove("monitorWindowId");
    loadSettings((settings) => {
        chrome.sidePanel.setOptions({ enabled: settings.views.sidePanel });
        chrome.storage.local.set({ views: { ...settings.views, window: false } });
    });
}
chrome.runtime.onInstalled.addListener(syncViews);
chrome.runtime.onStartup.addListener(syncViews);

// Separate monitor window: open/close on request, and untick when the user closes it
async function openMonitorWindow() {
    const { monitorWindowId } = await chrome.storage.local.get("monitorWindowId");
    if (monitorWindowId != null) {
        const existing = await chrome.windows.get(monitorWindowId).catch(() => null);
        if (existing) {
            chrome.windows.update(monitorWindowId, { focused: true });
            return;
        }
    }
    const win = await chrome.windows.create({ url: "panel.html?mode=window", type: "popup", width: 1200, height: 600 });
    await chrome.storage.local.set({ monitorWindowId: win.id });
}

async function closeMonitorWindow() {
    const { monitorWindowId } = await chrome.storage.local.get("monitorWindowId");
    if (monitorWindowId != null) await chrome.windows.remove(monitorWindowId).catch(() => {});
    await chrome.storage.local.remove("monitorWindowId");
}

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "openMonitorWindow") openMonitorWindow();
    else if (msg.type === "closeMonitorWindow") closeMonitorWindow();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
    const { monitorWindowId } = await chrome.storage.local.get("monitorWindowId");
    if (windowId !== monitorWindowId) return;
    await chrome.storage.local.remove("monitorWindowId");
    loadSettings((settings) => chrome.storage.local.set({ views: { ...settings.views, window: false } }));
});
