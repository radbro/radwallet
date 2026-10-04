// RADWALLET content script: inject the inpage provider, relay messages.
(function inject() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inpage.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

// whether the page's own code has touched the provider — see inpage.js. Held
// here rather than in the background because it is per-page state and the
// background would need `tabs` to keep it straight.
var dapp = null;

window.addEventListener('message', (ev) => {
  if (ev.source !== window || !ev.data || ev.data.target !== 'radwallet-content') return;
  if (ev.data.dapp) { dapp = ev.data.dapp; return; }
  const { id, method, params } = ev.data;
  chrome.runtime.sendMessage({ type: 'rpc-request', method, params }, (resp) => {
    window.postMessage(
      {
        target: 'radwallet-inpage',
        id,
        result: resp && resp.result,
        error: (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message),
        code: resp && resp.code,
      },
      '*',
    );
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // The wallet asks the page who it is, rather than reading tab URLs itself.
  // A content script knows its own origin for free, so this needs no `tabs`
  // permission and no host permissions — and it works when the wallet is
  // docked, where there is no activeTab grant at all.
  if (msg && msg.type === 'who-are-you') {
    sendResponse({ origin: window.location.origin, dapp: dapp });
    return;
  }
  if (msg && msg.type === 'chain-changed') {
    window.postMessage({ target: 'radwallet-inpage', event: 'chainChanged', data: msg.chainId }, '*');
  }
  // the wallet can connect or switch accounts on its own, without the page
  // ever calling eth_requestAccounts — dapps learn about it the standard way
  if (msg && msg.type === 'accounts-changed') {
    // the background broadcasts to every tab and lets each one decide: it has
    // no `tabs` permission to read URLs with, and this page knows its own
    // origin without asking anyone
    if (msg.origin !== window.location.origin) return;
    window.postMessage({ target: 'radwallet-inpage', event: 'accountsChanged', data: msg.accounts }, '*');
  }
});
