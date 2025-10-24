document.addEventListener("DOMContentLoaded", async () => {
  const toggleTesting = document.getElementById("toggleTesting");
  const resetProfit = document.getElementById("resetProfit");

  chrome.storage.local.get(["testingMode"], (data) => {
    toggleTesting.checked = data.testingMode || false;
  });

  toggleTesting.addEventListener("change", () => {
    chrome.runtime.sendMessage({
      type: "setTestingMode",
      value: toggleTesting.checked
    });
  });

  resetProfit.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "resetFakeProfit" });
  });
});
