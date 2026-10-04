/**
 * Browser-extension compatibility layer — Chrome/Chromium MV3 and Firefox MV3.
 *
 * Two browsers, two dialects. The rules we follow everywhere else in the app:
 *
 *   1. ALWAYS talk to the `chrome` namespace with CALLBACKS. Firefox aliases
 *      `chrome` for compatibility, but that alias is callback-only — a bare
 *      `chrome.storage.local.get(k).then(...)` works in Chrome and explodes in
 *      Firefox. `call()` below turns either dialect into a promise.
 *   2. The promise-style `browser` namespace exists ONLY in Firefox, so it
 *      doubles as our engine sniff (`IS_FIREFOX`).
 *   3. Anything genuinely divergent (today: the proxy API used for Tor
 *      routing) gets an explicit fork here, not at the call site.
 *
 * No network, no storage of its own — this file is plumbing.
 */
declare const chrome: any;

const g = globalThis as any;

/** callback-style extension namespace, present in both browsers */
export const ext: any = typeof chrome !== 'undefined' ? chrome : undefined;

/** promise-style namespace — Firefox only */
const gecko: any = g.browser?.runtime?.id ? g.browser : undefined;

/** true when we are running inside the extension (not the PWA/demo build) */
export const IS_EXTENSION = !!(ext?.runtime?.id && ext?.storage?.local);

/** true on Firefox, where MV3 uses an event page and a different proxy API */
export const IS_FIREFOX = !!gecko;

/**
 * Run a callback-style extension API as a promise. Tolerates implementations
 * that return a promise instead of invoking the callback (Chrome does this
 * when the callback is omitted; some polyfills do it always).
 */
export function call<T>(fn: (cb: (value: T) => void) => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      const err = ext?.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(value);
    };
    const returned = fn(done) as any;
    if (returned && typeof returned.then === 'function') {
      returned.then((v: T) => { if (!settled) { settled = true; resolve(v); } }, reject);
    }
  });
}

// ------------------------------------------------------------- notification --
/** Browser/OS notifications are extension-only and require the manifest permission. */
export const HAS_NOTIFICATIONS = !!ext?.notifications?.create;

/**
 * Put one privacy-minimal message in the browser's system notification tray.
 * Keep the callback dialect here: promise-style chrome.notifications calls
 * work in Chromium and throw in Firefox, just like chrome.storage.
 */
export function showBrowserNotification(
  id: string,
  title: string,
  message: string,
): Promise<string | null> {
  if (!HAS_NOTIFICATIONS) return Promise.resolve(null);
  return call<string | undefined>((cb) => ext.notifications.create(id, {
    type: 'basic',
    iconUrl: ext.runtime.getURL('icons/icon-192.png'),
    title,
    message,
  }, cb)).then((created) => created ?? null);
}

// ------------------------------------------------------------------ storage --
export const store = {
  /** read one key; resolves to undefined when unset */
  get<T = any>(key: string): Promise<T | undefined> {
    return call<Record<string, T>>((cb) => ext.storage.local.get(key, cb)).then((r) => r?.[key]);
  },
  set(items: Record<string, unknown>): Promise<void> {
    return call<void>((cb) => ext.storage.local.set(items, cb));
  },
};

/**
 * A network selected from a wallet-owned surface must reach connected pages as
 * EIP-1193 `chainChanged`, just like a switch they approved from a dapp. The
 * background owns the broadcast because it can reach each content script
 * without giving the wallet UI any page privileges.
 */
export function publishWalletChainSelection(chainId: number): void {
  if (!ext?.runtime?.sendMessage || !Number.isSafeInteger(chainId)) return;
  ext.runtime.sendMessage(
    { type: 'wallet-select-chain', chainId },
    () => void ext.runtime.lastError,
  );
}

// -------------------------------------------------------------------- proxy --
/**
 * Tor routing: same PAC script, two very different APIs.
 *   Chrome  — `proxy.settings` takes the PAC source inline (`pac_script`).
 *   Firefox — `proxy.settings` only takes a PAC *URL* (`autoConfig`), so the
 *             script is handed over as a data: URL.
 * Neither browser lets a proxy setting be read back verbatim, so `isTorOn()`
 * just checks that the mode is ours.
 */
export const HAS_PROXY_API = !!ext?.proxy?.settings;

const PAC_DATA_PREFIX = 'data:application/x-ns-proxy-autoconfig;base64,';

export async function isTorOn(): Promise<boolean> {
  if (!HAS_PROXY_API) return false;
  const d = await call<any>((cb) => ext.proxy.settings.get({}, cb));
  return IS_FIREFOX
    ? d?.value?.proxyType === 'autoConfig' && String(d?.value?.autoConfigUrl ?? '').startsWith(PAC_DATA_PREFIX)
    : d?.value?.mode === 'pac_script';
}

export async function setTorPac(pac: string): Promise<void> {
  if (!HAS_PROXY_API) throw new Error('this build has no proxy API');
  if (IS_FIREFOX) {
    // Firefox rejects inline PAC data; hand it the same script as a data: URL.
    const url = PAC_DATA_PREFIX + btoa(pac);
    await gecko.proxy.settings.set({ value: { proxyType: 'autoConfig', autoConfigUrl: url } });
    return;
  }
  await call<void>((cb) =>
    ext.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' }, cb),
  );
}

// ------------------------------------------------------------------ sidebar --
/**
 * Dock the wallet into the browser's side panel / sidebar instead of the
 * popup. Two browsers, two entirely different mechanisms:
 *
 *   Chrome  — `side_panel` manifest key + the `sidePanel` API. There is no
 *             close() in the API, but the panel hosts our own page, so
 *             window.close() from inside it does the job.
 *   Firefox — `sidebar_action` manifest key + `sidebarAction.open/close`.
 *             Firefox also gives the sidebar its own toolbar button for free.
 *
 * Both `open` calls must happen INSIDE a user gesture, so nothing here is
 * allowed to await before calling them — the window id is primed at boot.
 */
export const HAS_SIDEBAR = !!(ext?.sidePanel?.open || gecko?.sidebarAction);

/** Chrome only: the toolbar button can be repointed at the panel. */
export const CAN_REBIND_ACTION = !!ext?.sidePanel?.setPanelBehavior;

let windowId: number | undefined;

/** cache the current window id so openSidebar() never has to await */
export function primeSidebar(): void {
  if (!ext?.windows?.getCurrent) return;
  try {
    ext.windows.getCurrent((w: { id?: number }) => { windowId = w?.id; });
  } catch { /* no windows API in this context */ }
}

export function openSidebar(): void {
  if (gecko?.sidebarAction) {
    void gecko.sidebarAction.open();
    return;
  }
  // Chrome: windowId is optional in theory, required in practice from a popup
  ext.sidePanel.open(windowId === undefined ? {} : { windowId });
}

/**
 * Close it from the inside. Firefox has a real API; Chrome does not, but the
 * panel is our own page. Returns false when the caller has to tell the user
 * to close it by hand.
 */
export function closeSidebar(): boolean {
  if (gecko?.sidebarAction) {
    void gecko.sidebarAction.close();
    return true;
  }
  try {
    window.close();
    return true;
  } catch {
    return false;
  }
}

/** Chrome only: make the toolbar button open the panel instead of the popup. */
export function setActionOpensSidebar(on: boolean): Promise<void> {
  if (!CAN_REBIND_ACTION) return Promise.resolve();
  return call<void>((cb) => ext.sidePanel.setPanelBehavior({ openPanelOnActionClick: on }, cb));
}

export async function clearTorPac(): Promise<void> {
  if (!HAS_PROXY_API) return;
  if (IS_FIREFOX) {
    await gecko.proxy.settings.clear({});
    return;
  }
  await call<void>((cb) => ext.proxy.settings.clear({ scope: 'regular' }, cb));
}

// ------------------------------------------------------------- active tab --
/**
 * The origin of the site you are looking at, or null.
 *
 * We do NOT read tab URLs. Reading them requires either the `tabs` permission
 * or host permissions — the right to see every page you have open — which is
 * far too much to pay for a convenience button. Instead the wallet asks its
 * OWN content script, which is already on the page and knows its own origin
 * for free. `tabs.query` hands back tab ids without any permission at all, and
 * messaging our own content script needs none either.
 *
 * The upshot: this works from the popup AND from the docked sidebar, and the
 * extension asks for no tab permissions whatsoever. (Verified: an extension
 * page with no activeTab grant gets a clean origin back this way.)
 */
/**
 * How the page revealed itself as a dapp, if it did — see inpage.js. `null`
 * means nothing on the page has ever touched the provider, which is what a
 * page like translate.google.com looks like.
 */
export type DappSighting = 'rpc' | 'discovery' | 'probe' | null;
export interface ActiveTab { origin: string; dapp: DappSighting }

function askTab(tabId: number): Promise<ActiveTab | null> {
  return call<{ origin?: string; dapp?: DappSighting } | undefined>((cb) =>
    ext.tabs.sendMessage(tabId, { type: 'who-are-you' }, cb),
  ).then((r) => (r?.origin ? { origin: r.origin, dapp: r.dapp ?? null } : null)).catch(() => null);
}

export async function activeTab(): Promise<ActiveTab | null> {
  if (!ext?.tabs?.query || !ext?.tabs?.sendMessage) return null;
  // the side panel belongs to a window but is not a tab, so currentWindow is
  // right there; the fallbacks cover a popup that has lost focus
  const queries = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true },
  ];
  const tried = new Set<number>();
  for (const q of queries) {
    const tabs = await call<Array<{ id?: number }>>((cb) => ext.tabs.query(q, cb)).catch(() => []);
    for (const t of tabs ?? []) {
      if (t.id === undefined || tried.has(t.id)) continue;
      tried.add(t.id);
      // pages without our content script (chrome://, about:, the wallet
      // itself) simply do not answer, which is the filter we want
      const answer = await askTab(t.id);
      if (answer && /^https?:\/\//.test(answer.origin)) return answer;
    }
  }
  return null;
}

/**
 * Call back whenever the active tab changes or navigates.
 *
 * Both events fire with NO `tabs` permission, and `changeInfo.url` is stripped
 * out when you lack it — verified. So these tell the wallet WHEN to look
 * again, never WHAT you are looking at; the origin still comes from asking our
 * own content script. Returns an unsubscribe.
 *
 * Only useful while docked: a popup closes the moment you switch tabs.
 */
export function onTabChanged(fn: () => void): () => void {
  if (!ext?.tabs?.onActivated) return () => {};
  // a single navigation fires several updates (loading, then complete), so
  // coalesce rather than interrogating the page three times
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ping = () => {
    clearTimeout(timer);
    timer = setTimeout(fn, 150);
  };
  ext.tabs.onActivated.addListener(ping);
  ext.tabs.onUpdated?.addListener(ping);
  return () => {
    clearTimeout(timer);
    try {
      ext.tabs.onActivated.removeListener(ping);
      ext.tabs.onUpdated?.removeListener(ping);
    } catch { /* already gone */ }
  };
}

/** Keep every open wallet surface honest when a dapp-approved switch lands. */
export function onWalletChainChanged(fn: (chainId: number) => void): () => void {
  if (!ext?.runtime?.onMessage) return () => {};
  const listener = (msg: any) => {
    if (msg?.type === 'wallet-chain-changed' && Number.isInteger(msg.chainId)) fn(msg.chainId);
  };
  ext.runtime.onMessage.addListener(listener);
  return () => {
    try { ext.runtime.onMessage.removeListener(listener); } catch { /* already gone */ }
  };
}

/** Keep open wallet surfaces in sync when an approved site swap adds scan targets. */
export function onWalletTokensTracked(
  fn: (chainId: number, tokens: Array<{
    address: `0x${string}`; symbol: string; name: string; decimals: number;
  }>) => void,
): () => void {
  if (!ext?.runtime?.onMessage) return () => {};
  const listener = (msg: any) => {
    if (msg?.type === 'wallet-tokens-tracked' && Number.isInteger(msg.chainId)
      && Array.isArray(msg.tokens)) fn(msg.chainId, msg.tokens);
  };
  ext.runtime.onMessage.addListener(listener);
  return () => {
    try { ext.runtime.onMessage.removeListener(listener); } catch { /* already gone */ }
  };
}

/** Refresh open wallet surfaces after any transaction approved outside them. */
export function onWalletTransaction(fn: (chainId: number, hash: string) => void): () => void {
  if (!ext?.runtime?.onMessage) return () => {};
  const listener = (msg: any) => {
    if (msg?.type === 'wallet-transaction-broadcast' && Number.isInteger(msg.chainId)) {
      fn(msg.chainId, typeof msg.hash === 'string' ? msg.hash : '');
    }
  };
  ext.runtime.onMessage.addListener(listener);
  return () => {
    try { ext.runtime.onMessage.removeListener(listener); } catch { /* already gone */ }
  };
}

/** Use the background worker's failover-backed receipt result in open wallet pages. */
export function onWalletTransactionConfirmed(
  fn: (chainId: number, hash: string, status: 'confirmed' | 'failed') => void,
): () => void {
  if (!ext?.runtime?.onMessage) return () => {};
  const listener = (msg: any) => {
    if (msg?.type === 'wallet-transaction-confirmed' && Number.isInteger(msg.chainId)
      && typeof msg.hash === 'string' && (msg.status === 'confirmed' || msg.status === 'failed')) {
      fn(msg.chainId, msg.hash, msg.status);
    }
  };
  ext.runtime.onMessage.addListener(listener);
  return () => {
    try { ext.runtime.onMessage.removeListener(listener); } catch { /* already gone */ }
  };
}
