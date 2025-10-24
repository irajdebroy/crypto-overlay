chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    testingMode: false,
    fakeProfit: 0
  });
});

// Listen for popup changes
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "setTestingMode") {
    chrome.storage.local.set({ testingMode: message.value });
  }
  if (message.type === "resetFakeProfit") {
    chrome.storage.local.set({ fakeProfit: 0 });
  }
});
