chrome.action.onClicked.addListener((tab) => {
    chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["inject.js"]
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggleMonitor') {
    console.log("Toggle monitor message received. Monitor is now:", request.enabled);
    // You can do something here if you want, or just leave it empty.
  }
});