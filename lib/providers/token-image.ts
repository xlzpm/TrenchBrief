/**
 * Jupiter often stores a pump.fun coin image on a host that refuses
 * browser embeds (RapidLaunch, public IPFS gateways). images.pump.fun
 * serves the same logo for those mints.
 */
const UNRELIABLE_HOST_SUFFIXES = [
  "rapidlaunch.io",
  "ipfs.io",
  "cf-ipfs.com",
  "cloudflare-ipfs.com",
  "pinata.cloud",
  "nftstorage.link",
  "w3s.link",
  "dweb.link",
] as const;

export function pumpCoinImageUrl(ca: string): string {
  return `https://images.pump.fun/coin-image/${encodeURIComponent(ca)}`;
}

export function isUnreliableImageHost(imageUrl: string): boolean {
  try {
    const host = new URL(imageUrl).hostname.toLowerCase();
    return UNRELIABLE_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

/** Ordered logo URLs to try in the browser. Empty means show the symbol mark. */
export function tokenImageSources(ca: string, imageUrl: string | null): string[] {
  const pump = ca.endsWith("pump") ? pumpCoinImageUrl(ca) : null;
  if (!imageUrl) return pump ? [pump] : [];
  if (pump && (imageUrl === pump || isUnreliableImageHost(imageUrl))) return [pump];
  if (pump) return [imageUrl, pump];
  return [imageUrl];
}
