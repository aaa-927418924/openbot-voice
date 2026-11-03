(() => {
  const fallback = document.getElementById("startup-fallback");
  const detail = document.getElementById("startup-fallback-detail");
  const retry = document.getElementById("startup-fallback-retry");
  function showStartupFailure() {
    if (!fallback?.isConnected) return;
    if (detail) detail.textContent = "画面を読み込めませんでした。再読み込みしてください。";
    if (retry) retry.hidden = false;
  }

  if (retry) retry.addEventListener("click", () => location.reload());
  window.addEventListener("error", showStartupFailure);
  window.addEventListener("unhandledrejection", showStartupFailure);
  setTimeout(showStartupFailure, 20_000);
})();
