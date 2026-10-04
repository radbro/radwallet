/**
 * NFT artwork. The second — and last — file allowed to touch the network
 * outside the RPC layer, and like the indexer it does nothing until asked.
 *
 * Why it has to exist: `tokenURI` does not point at a picture. It points at a
 * METADATA DOCUMENT, and the picture is a field inside it:
 *
 *   tokenURI(874) -> https://radbro.xyz/api/tokens/metadata/874
 *                    { "name": "Radbro #874", "image": "https://…/da11…f1.png" }
 *
 * So showing art is two hops, not one — which is exactly why pointing an
 * <img src> straight at the tokenURI renders nothing at all.
 *
 * What it costs, and why it is a button rather than a default: both hops tell
 * the host your IP and which token you are looking at, and for an ipfs:// URI
 * the gateway learns the same. That is a small leak next to the indexer's, but
 * it is the same KIND of leak, so it gets the same treatment — off until the
 * user asks, per collection, per session.
 */

/** every entry point takes this, and returns empty without it */
export interface MediaGate {
  /** the user pressed the button. Nothing here runs on `false`. */
  allowed: boolean;
  /** which gateway stands in for ipfs://; the user can point this elsewhere */
  gateway?: string;
}

export const DEFAULT_GATEWAY = 'https://ipfs.io/ipfs/';

/**
 * Turn an ipfs:// URI into something a browser can load. Anything already
 * http(s) is left alone; anything else is refused rather than guessed at.
 */
export function toLoadableUrl(uri: string, gateway = DEFAULT_GATEWAY): string | null {
  const raw = (uri ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('ipfs://')) {
    return gateway + raw.slice('ipfs://'.length).replace(/^ipfs\//, '');
  }
  if (raw.startsWith('data:image/')) return raw; // already inline, no fetch
  if (/^https?:\/\//i.test(raw)) return raw;
  return null; // ar://, ipns://, relative paths — not ours to invent
}

/** pull the image out of a metadata document without trusting its shape */
export function imageFromMetadata(json: unknown, gateway = DEFAULT_GATEWAY): string | null {
  const doc = json as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') return null;
  // `image` is the standard; `image_url` and `imageUrl` show up in the wild
  for (const key of ['image', 'image_url', 'imageUrl']) {
    const v = doc[key];
    if (typeof v === 'string' && v.trim()) return toLoadableUrl(v, gateway);
  }
  return null;
}

/**
 * tokenURI -> a URL an <img> can actually display.
 *
 * Returns null rather than throwing: a broken or slow collection should leave
 * a blank tile, not take down the sheet around it.
 */
export async function resolveArt(tokenUri: string, gate: MediaGate): Promise<string | null> {
  if (!gate.allowed) return null;
  const gateway = gate.gateway ?? DEFAULT_GATEWAY;

  const metaUrl = toLoadableUrl(tokenUri, gateway);
  if (!metaUrl) return null;

  // some collections put a data: image straight in tokenURI (on-chain art);
  // there is nothing to fetch in that case
  if (metaUrl.startsWith('data:image/')) return metaUrl;

  try {
    const res = await fetch(metaUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const text = await res.text();
    // base64 data: URIs holding JSON are common for on-chain collections
    return imageFromMetadata(JSON.parse(text), gateway);
  } catch {
    return null;
  }
}
