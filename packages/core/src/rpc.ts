/**
 * Rotating RPC pool. Privacy goal: no single endpoint ever observes the
 * user's complete address set. Each account is pinned to a pool slot by
 * address hash; the whole assignment can be rotated with one click, and the
 * pool itself is user-editable (bring your own node beats everything).
 */

export interface RpcPoolState {
  endpoints: string[];
  /** rotation offset — bumping it remaps every account to a new endpoint */
  epoch: number;
}

export const DEFAULT_ENDPOINTS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.flashbots.net',
];

export function defaultPool(): RpcPoolState {
  return { endpoints: [...DEFAULT_ENDPOINTS], epoch: 0 };
}

/**
 * Remove endpoints that a newer build has retired without discarding the
 * user's own nodes. If an old pool contained only retired defaults, restore
 * the current defaults so an upgrade cannot leave that chain unusable.
 */
export function retireEndpoints(
  pool: RpcPoolState,
  retired: readonly string[],
  fallback: readonly string[],
): RpcPoolState {
  const blocked = new Set(retired);
  const kept = pool.endpoints.filter((endpoint) => !blocked.has(endpoint));
  const endpoints = kept.length > 0 ? kept : [...fallback];
  return {
    endpoints,
    epoch: endpoints.length > 0 ? pool.epoch % endpoints.length : 0,
  };
}

/** Keep transport failures useful in a narrow wallet window without rendering
 * provider HTML (which may include request metadata or the user's IP). */
export function summarizeRpcError(error: unknown, maxLength = 180): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/\bStatus:\s*(\d{3})\b/i)
    ?? message.match(/\bHTTP\s+(\d{3})\b/i);
  if (status) return `HTTP ${status[1]}`;
  const oneLine = message.replace(/\s+/g, ' ').trim() || 'RPC request failed';
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(1, maxLength - 1))}…`;
}

/** localhost, in every spelling a browser accepts */
export function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === 'localhost' || h.endsWith('.localhost')
    || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Accept an endpoint the user typed, or refuse it. Null means refused.
 *
 * https to anywhere; http ONLY to loopback. Plaintext to a remote host hands
 * every address you look up to whatever sits on the wire, which is the one
 * thing this wallet exists to prevent — but a node on your own machine (anvil,
 * reth, a mainnet fork) never leaves the machine, and it is the endpoint with
 * the best privacy of any on the list. Refusing it was refusing the good case.
 */
export function normalizeEndpoint(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.protocol === 'http:' && !isLoopback(u.hostname)) return null;
  // 'http://127.0.0.1:8545' parses with a trailing slash; keep the display
  // identical to what was typed for the common case of a bare origin
  return u.pathname === '/' && !u.search && !u.hash ? u.href.replace(/\/$/, '') : u.href;
}

/**
 * Derive the documented WebSocket twin for a user-supplied Alchemy endpoint.
 * Restricting this to the known Alchemy host shape avoids guessing that an
 * arbitrary HTTPS provider exposes WebSockets at the same path.
 */
export function alchemyWebSocketEndpoint(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.g.alchemy.com')) return null;
  url.protocol = 'wss:';
  return url.href;
}

function addrSlot(address: string, n: number): number {
  // cheap stable hash over the hex address
  let h = 0;
  for (let i = 2; i < address.length; i++) {
    h = (h * 31 + address.charCodeAt(i)) >>> 0;
  }
  return h % n;
}

/** Endpoint this account talks to under the current epoch. */
export function endpointFor(pool: RpcPoolState, address: string): string {
  if (pool.endpoints.length === 0) throw new Error('RPC pool is empty');
  const slot = (addrSlot(address, pool.endpoints.length) + pool.epoch) % pool.endpoints.length;
  return pool.endpoints[slot];
}

/** One rotation: every account moves to the next endpoint in the pool. */
export function rotate(pool: RpcPoolState): RpcPoolState {
  return { ...pool, epoch: (pool.epoch + 1) % Math.max(1, pool.endpoints.length) };
}

/** How many distinct endpoints would see this set of addresses. */
export function coverage(pool: RpcPoolState, addresses: string[]): number {
  return new Set(addresses.map((a) => endpointFor(pool, a))).size;
}
