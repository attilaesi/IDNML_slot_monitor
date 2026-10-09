// Settings as of this page load; null until storage has been read
let settings = null;
let injected = false;
// Latest snapshot from inject.js, so views opened later can catch up
let latestState = null;
// On-page overlay elements, while shown
let overlay = null;

loadSettings((loaded) => {
    settings = loaded;
    if (settings.monitorEnabled) {
        injected = true;
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("inject.js");
        script.onload = function () {
            this.remove(); // Clean up after execution
        };
        (document.head || document.documentElement).appendChild(script);
    }
    updateOverlay();
});

// Overlay tick box and position apply straight away; enabling the monitor itself needs a reload
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !settings) return;
    if (changes.views) settings.views = { ...DEFAULT_VIEWS, ...changes.views.newValue };
    if (changes.overlayPosition) settings.overlayPosition = changes.overlayPosition.newValue;
    if (changes.views || changes.overlayPosition) updateOverlay();
});

function jumpToSlot(id) {
    window.postMessage({ source: "idnml-panel", type: "jump", id }, "*");
}

// --- On-page overlay (in a shadow root so page CSS can't touch it) -----------

function createOverlay() {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
        <style>
            ${MonitorView.css}
            .overlay { position: fixed; overflow-y: auto; z-index: 2147483647;
                       background: rgba(0, 0, 0, 0.85); padding: 8px; box-sizing: border-box; }
            .overlay.top { top: 0; left: 0; right: 0; max-height: 50vh; }
            .overlay.bottom { bottom: 0; left: 0; right: 0; max-height: 50vh; }
            .overlay.left { top: 0; bottom: 0; left: 0; width: min(440px, 50vw); }
            .overlay.right { top: 0; bottom: 0; right: 0; width: min(440px, 50vw); }
            .overlay.collapsed { bottom: auto; top: auto; max-height: none; width: auto; }
            .overlay.collapsed.top, .overlay.collapsed.left, .overlay.collapsed.right { top: 0; }
            .overlay.collapsed.bottom { bottom: 0; }
            .overlay.collapsed .monitor { display: none; }
            .bar { margin-bottom: 6px; }
            .bar button { cursor: pointer; }
        </style>
        <div class="overlay">
            <div class="bar"><button>Toggle</button></div>
            <div class="monitor"></div>
        </div>`;
    const panel = shadow.querySelector(".overlay");
    shadow.querySelector(".bar button").addEventListener("click", () => panel.classList.toggle("collapsed"));
    document.documentElement.appendChild(host);
    return { host, panel, root: shadow.querySelector(".monitor") };
}

function updateOverlay() {
    const wanted = injected && settings.views.overlay;
    if (wanted && !overlay) overlay = createOverlay();
    if (!wanted && overlay) {
        overlay.host.remove();
        overlay = null;
    }
    if (!overlay) return;
    OVERLAY_POSITIONS.forEach((pos) => overlay.panel.classList.toggle(pos, pos === settings.overlayPosition));
    MonitorView.render(overlay.root, latestState, { onJump: jumpToSlot });
}

// --- Messaging ------------------------------------------------------------------

// Snapshots from inject.js (page world): draw the overlay and relay to the extension's views
window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "idnml-monitor") return;
    latestState = event.data.state;
    if (overlay) MonitorView.render(overlay.root, latestState, { onJump: jumpToSlot });
    try {
        chrome.runtime.sendMessage({ type: "state", state: latestState }).catch(() => {}); // no view open
    } catch (e) {
        // Extension was reloaded; this content script is orphaned until the page reloads
    }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "getState") {
        sendResponse({ enabled: settings ? settings.monitorEnabled : null, state: latestState });
    } else if (msg.type === "jump") {
        jumpToSlot(msg.id);
    }
});
