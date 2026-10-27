import type { IncomingMessage } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket as UpstreamSocket, type RawData, type WebSocket } from "ws";

import { env } from "@/lib/env";
import { solanaAddressSchema } from "@/lib/dto";
import { log } from "@/lib/observability/log";
import { e2eFixturesEnabled, fixtureMarket } from "@/lib/providers/fixture";

import { liveSocketPort } from "./port";
import { createMarketStream, type LiveClient, type MarketStream } from "./stream";
import type { LiveStatsFrame } from "./stats";

const BIRDEYE_SOCKET = "wss://public-api.birdeye.so/socket/solana";
const BIRDEYE_ORIGIN = "ws://public-api.birdeye.so";
let missingKeyWarned = false;

type LiveSlot = {
  version: symbol;
  ready: Promise<void>;
  close: () => Promise<void>;
};

const globalLive = globalThis as typeof globalThis & {
  __trenchLive?: LiveSlot;
};

const moduleVersion = Symbol("trench-live");

export function ensureLiveSocket(): Promise<void> {
  const current = globalLive.__trenchLive;
  if (current?.version === moduleVersion) return current.ready;

  const previous = current?.close() ?? Promise.resolve();
  let closeStarted: () => Promise<void> = () => Promise.resolve();
  const ready = previous
    .then(() => listen())
    .then((started) => {
      closeStarted = started.close;
    })
    .catch((error: unknown) => {
      if (globalLive.__trenchLive?.version === moduleVersion) {
        delete globalLive.__trenchLive;
      }
      log.warn("live.bind_failed", {
        message: error instanceof Error ? error.message : "Live socket failed to start.",
      });
    });
  globalLive.__trenchLive = {
    version: moduleVersion,
    ready,
    close: () => ready.then(() => closeStarted(), () => undefined),
  };
  return ready;
}

function listen(): Promise<{ close: () => Promise<void> }> {
  const httpServer = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ server: httpServer });
  const stream = createMarketStream({ connect: openBirdeye });
  sockets.on("connection", (socket, request) => acceptClient(stream, socket, request));

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      sockets.close();
      reject(error);
    };
    httpServer.once("error", onError);
    httpServer.listen(liveSocketPort(), () => {
      httpServer.off("error", onError);
      log.info("live.listening", { port: liveSocketPort() });
      resolve({
        close: () => closeServers(httpServer, sockets, stream),
      });
    });
  });
}

function acceptClient(stream: MarketStream, socket: WebSocket, request: IncomingMessage) {
  const url = requestUrl(request);
  if (!url || url.pathname !== "/live") {
    socket.close(1008, "Unsupported path");
    return;
  }
  if (!originAllowed(request.headers.origin)) {
    socket.close(1008, "Origin is not allowed");
    return;
  }
  const address = solanaAddressSchema.safeParse(url.searchParams.get("ca") ?? "");
  if (!address.success) {
    socket.close(1008, "Enter a Solana contract address.");
    return;
  }

  if (e2eFixturesEnabled()) {
    send(socket, JSON.stringify({ type: "status", live: true }));
    send(socket, JSON.stringify(fixtureFrame(address.data)));
    return;
  }

  const client: LiveClient = {
    send: (payload) => send(socket, payload),
  };
  const unsubscribe = stream.subscribe(address.data, client);
  socket.on("close", unsubscribe);
  socket.on("error", unsubscribe);
}

function openBirdeye(handlers: {
  onOpen: () => void;
  onMessage: (raw: string) => void;
  onClose: () => void;
}) {
  const apiKey = env.BIRDEYE_API_KEY;
  if (!apiKey) {
    if (!missingKeyWarned) {
      missingKeyWarned = true;
      log.warn("live.birdeye_unconfigured", {
        message: "Set BIRDEYE_API_KEY to stream price, market cap, liquidity, and volume.",
      });
    }
    return null;
  }
  const socket = new UpstreamSocket(`${BIRDEYE_SOCKET}?x-api-key=${encodeURIComponent(apiKey)}`, "echo-protocol", {
    headers: {
      Origin: BIRDEYE_ORIGIN,
      "Sec-WebSocket-Origin": BIRDEYE_ORIGIN,
    },
  });
  socket.on("open", () => handlers.onOpen());
  socket.on("message", (data) => {
    handlers.onMessage(rawText(data));
  });
  socket.on("close", () => handlers.onClose());
  socket.on("error", (error) => {
    log.warn("live.upstream_error", {
      message: redact(error.message, apiKey),
    });
  });
  return {
    send: (payload: string) => {
      if (socket.readyState === UpstreamSocket.OPEN) socket.send(payload);
    },
    close: () => socket.close(),
  };
}

function fixtureFrame(ca: string): LiveStatsFrame {
  const snapshot = fixtureMarket(ca).snapshot;
  const frame: LiveStatsFrame = {
    type: "stats",
    ca,
    capturedAt: snapshot.capturedAt,
  };
  if (snapshot.priceUsd != null) frame.priceUsd = snapshot.priceUsd;
  if (snapshot.marketCapUsd != null) frame.marketCapUsd = snapshot.marketCapUsd;
  if (snapshot.liquidityUsd != null) frame.liquidityUsd = snapshot.liquidityUsd;
  const volumeUsd: NonNullable<LiveStatsFrame["volumeUsd"]> = {};
  for (const period of ["1h", "6h", "24h"] as const) {
    const amount = snapshot.volumeUsd[period];
    if (amount != null) volumeUsd[period] = amount;
  }
  if (Object.keys(volumeUsd).length > 0) frame.volumeUsd = volumeUsd;
  return frame;
}

function send(socket: WebSocket, payload: string) {
  if (socket.readyState === UpstreamSocket.OPEN) socket.send(payload);
}

function requestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    const appHost = new URL(env.NEXT_PUBLIC_APP_URL).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === appHost;
  } catch {
    return false;
  }
}

function rawText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (Buffer.isBuffer(data)) return data.toString();
  return Buffer.from(data).toString();
}

function redact(message: string, secret: string): string {
  return message.replaceAll(secret, "[redacted]").slice(0, 300);
}

function closeServers(
  httpServer: HttpServer,
  sockets: WebSocketServer,
  stream: MarketStream,
): Promise<void> {
  stream.close();
  for (const client of sockets.clients) client.close();
  sockets.close();
  return new Promise((resolve) => {
    httpServer.close(() => resolve());
  });
}
