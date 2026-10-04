// RADWALLET inpage provider — EIP-1193 + EIP-6963.
// Injected into every page; does nothing until the dapp calls it.
(() => {
  let nextId = 1;
  const inflight = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.target !== 'radwallet-inpage') return;
    if (ev.data.event) {
      (listeners[ev.data.event] || []).forEach((cb) => { try { cb(ev.data.data); } catch {} });
      return;
    }
    const p = inflight.get(ev.data.id);
    if (!p) return;
    inflight.delete(ev.data.id);
    if (ev.data.error) {
      // EIP-1193 errors carry a CODE, and dapps branch on it: 4001 means the
      // user said no (don't retry), 4902 means the chain is unknown (offer to
      // add it). A message-only rejection reads as an unexplained failure and
      // stalls the handshake, so the code is relayed all the way from the
      // background.
      const err = new Error(ev.data.error);
      if (typeof ev.data.code === 'number') err.code = ev.data.code;
      p.reject(err);
    } else p.resolve(ev.data.result);
  });

  /**
   * IS THERE A DAPP ON THIS PAGE?
   *
   * There is no such thing as a "web3 domain", and a bundled allowlist of
   * known dapps would be both wrong and a tracker's shopping list. But this
   * script IS the provider, so it can watch for the page's own code using it —
   * the only signal that actually means anything. Three ways a page reveals
   * itself, in descending certainty:
   *
   *   rpc       — it called request(). Definitive.
   *   discovery — it dispatched eip6963:requestProvider, or subscribed with
   *               on(). Only wallet-connecting code does either.
   *   probe     — it merely read window.ethereum. Weakest: a handful of
   *               non-wallet scripts sniff for it.
   *
   * Measured against real pages: translate.google.com, wikipedia and HN never
   * touch it at all, while aave, opensea, app.ens.domains and the dapp this
   * was reported against all announce on load. So this cleanly separates a
   * site worth offering CONNECT for from one that would just be noise.
   */
  let sawDapp = null;
  const dappIs = (how) => {
    // first sighting wins: 'rpc' outranks the rest and is never downgraded
    if (sawDapp === 'rpc' || sawDapp === how) return;
    sawDapp = sawDapp && how !== 'rpc' ? sawDapp : how;
    window.postMessage({ target: 'radwallet-content', dapp: sawDapp }, '*');
  };

  const listeners = {};
  const provider = {
    isRadwallet: true,
    isMetaMask: false, // we are not the orange fox
    request({ method, params }) {
      dappIs('rpc');
      return new Promise((resolve, reject) => {
        const id = nextId++;
        inflight.set(id, { resolve, reject });
        window.postMessage({ target: 'radwallet-content', id, method, params }, '*');
      });
    },
    on(event, cb) {
      dappIs('discovery');
      (listeners[event] = listeners[event] || []).push(cb);
      return provider;
    },
    removeListener(event, cb) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== cb);
      return provider;
    },
    // legacy
    enable() {
      return provider.request({ method: 'eth_requestAccounts' });
    },
  };

  // EIP-6963 multi-wallet discovery
  const info = {
    uuid: crypto.randomUUID(),
    name: 'RADWALLET',
    icon:
      'data:image/svg+xml;base64,' +
      btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#000"/><text x="48" y="60" font-family="Courier New,monospace" font-weight="bold" font-size="40" fill="#ffe000" text-anchor="middle">R</text></svg>',
      ),
    rdns: 'xyz.radbro.radwallet',
  };
  const announce = () => {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }),
    );
  };
  window.addEventListener('eip6963:requestProvider', () => {
    dappIs('discovery');
    announce();
  });
  announce();

  // claim window.ethereum only if nobody else has. A getter rather than a
  // value, so that reading it counts as a sighting — same non-configurable
  // property from the page's point of view.
  if (!window.ethereum) {
    try {
      Object.defineProperty(window, 'ethereum', {
        configurable: false,
        get() { dappIs('probe'); return provider; },
      });
    } catch {
      window.ethereum = provider;
    }
  }
})();
