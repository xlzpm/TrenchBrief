import {
  liveFrameFromBirdeye,
  subscribeTokenStats,
  unsubscribeTokenStats,
  type LiveServerFrame,
} from "./stats";

const MAX_ADDRESSES = 100;
const MAX_MESSAGE_CHARS = 1_000_000;

export type LiveClient = {
  send: (payload: string) => void;
};

type Upstream = {
  send: (payload: string) => void;
  close: () => void;
};

type ConnectHandlers = {
  onOpen: () => void;
  onMessage: (raw: string) => void;
  onClose: () => void;
};

export type MarketStream = {
  subscribe: (ca: string, client: LiveClient) => () => void;
  close: () => void;
};

/**
 * One upstream socket for every browser watching a token.
 * Birdeye replaces the previous token-stats subscription, so each change
 * sends the full address list. An explicit unsubscribe covers the case
 * where a new subscribe only adds addresses.
 */
export function createMarketStream(options: {
  connect: (handlers: ConnectHandlers) => Upstream | null;
  now?: () => Date;
  schedule?: (delayMs: number, run: () => void) => void;
}): MarketStream {
  const counts = new Map<string, number>();
  const clients = new Map<LiveClient, string>();
  let upstream: Upstream | null = null;
  let open = false;
  let closing = false;
  let attempt = 0;
  let stopped = false;
  let reconnecting = false;

  const schedule =
    options.schedule ??
    ((delayMs, run) => {
      setTimeout(run, delayMs);
    });

  function addresses(): string[] {
    return [...counts.keys()].sort();
  }

  function sendJson(client: LiveClient, frame: LiveServerFrame) {
    client.send(JSON.stringify(frame));
  }

  function broadcast(ca: string | null, frame: LiveServerFrame) {
    const payload = JSON.stringify(frame);
    const failed: LiveClient[] = [];
    for (const [client, subscribed] of clients) {
      if (ca != null && subscribed !== ca) continue;
      try {
        client.send(payload);
      } catch {
        failed.push(client);
      }
    }
    for (const client of failed) forget(client);
    if (failed.length > 0) publish();
  }

  function forget(client: LiveClient) {
    const ca = clients.get(client);
    if (!ca) return;
    clients.delete(client);
    const next = (counts.get(ca) ?? 1) - 1;
    if (next <= 0) counts.delete(ca);
    else counts.set(ca, next);
  }

  function publish() {
    const list = addresses();
    if (list.length === 0) {
      if (upstream) {
        closing = true;
        upstream.close();
      }
      upstream = null;
      open = false;
      return;
    }
    if (!upstream) {
      connect();
      return;
    }
    if (open) upstream.send(JSON.stringify(subscribeTokenStats(list)));
  }

  function connect() {
    if (stopped || upstream || addresses().length === 0) return;
    const socket = options.connect({
      onOpen: () => {
        if (stopped || upstream !== socket) return;
        open = true;
        attempt = 0;
        const list = addresses();
        if (list.length > 0) socket?.send(JSON.stringify(subscribeTokenStats(list)));
        broadcast(null, { type: "status", live: true });
      },
      onMessage: (raw) => {
        if (raw.length > MAX_MESSAGE_CHARS) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        const frame = liveFrameFromBirdeye(parsed, options.now?.() ?? new Date());
        if (!frame) return;
        broadcast(frame.ca, frame);
      },
      onClose: () => {
        if (upstream === socket) upstream = null;
        const wasClosing = closing;
        closing = false;
        open = false;
        if (wasClosing || stopped) return;
        broadcast(null, { type: "status", live: false });
        scheduleReconnect();
      },
    });
    upstream = socket;
    if (!socket) broadcast(null, { type: "status", live: false });
  }

  function scheduleReconnect() {
    if (stopped || reconnecting || addresses().length === 0) return;
    reconnecting = true;
    const delay = Math.min(1_000 * 2 ** attempt, 15_000);
    attempt += 1;
    schedule(delay, () => {
      reconnecting = false;
      if (!stopped && !upstream && addresses().length > 0) connect();
    });
  }

  return {
    subscribe(ca, client) {
      if (!counts.has(ca) && counts.size >= MAX_ADDRESSES) {
        sendJson(client, { type: "status", live: false });
        return () => undefined;
      }
      clients.set(client, ca);
      counts.set(ca, (counts.get(ca) ?? 0) + 1);
      sendJson(client, { type: "status", live: open });
      publish();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const subscribed = clients.get(client) === ca;
        const lastForToken = subscribed && (counts.get(ca) ?? 0) <= 1;
        forget(client);
        if (lastForToken && open && upstream && counts.size > 0) {
          upstream.send(JSON.stringify(unsubscribeTokenStats(ca)));
        }
        publish();
      };
    },
    close() {
      stopped = true;
      closing = upstream != null;
      clients.clear();
      counts.clear();
      open = false;
      upstream?.close();
      upstream = null;
    },
  };
}
