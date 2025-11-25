chrome.storage.local.get(["monitorEnabled"], (result) => {
    if (result.monitorEnabled) {
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("inject.js");
        script.onload = function () {
            this.remove(); // Clean up after execution
        };
        (document.head || document.documentElement).appendChild(script);
    }
});