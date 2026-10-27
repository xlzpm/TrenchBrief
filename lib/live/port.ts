export const DEFAULT_LIVE_SOCKET_PORT = "3001";

export function liveSocketPort(): number {
  const raw =
    process.env.LIVE_WS_PORT ||
    process.env.NEXT_PUBLIC_LIVE_WS_PORT ||
    DEFAULT_LIVE_SOCKET_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Number(DEFAULT_LIVE_SOCKET_PORT);
  }
  return port;
}

export function browserLiveSocketUrl(
  ca: string,
  page: { protocol: string; hostname: string },
): string {
  const port = process.env.NEXT_PUBLIC_LIVE_WS_PORT || DEFAULT_LIVE_SOCKET_PORT;
  const protocol = page.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${page.hostname}:${port}/live?ca=${encodeURIComponent(ca)}`;
}
