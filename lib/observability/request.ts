import { createHash, randomUUID } from "node:crypto";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,80}$/;

/** Keeps an inbound id when it is safe to log, otherwise assigns a new one. */
export function requestIdFromHeaders(
  headers: Headers,
  createId: () => string = randomUUID,
): string {
  const incoming = headers.get("x-request-id")?.trim() ?? "";
  return REQUEST_ID.test(incoming) ? incoming : createId();
}

/** Copies a safe id onto a mutable header set. Incoming request headers are read-only. */
export function withRequestId(
  headers: Headers,
  createId: () => string = randomUUID,
): string {
  const requestId = requestIdFromHeaders(headers, createId);
  headers.set("x-request-id", requestId);
  return requestId;
}

/**
 * The first forwarded address is the client. The value is trimmed to a
 * single token so a crafted header cannot break a log line or a Redis key.
 */
export function clientKeyFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip")?.trim() || "local";
  const cleaned = candidate.replace(/[^\w.:-]/g, "").slice(0, 64);
  return cleaned || "local";
}

/** Logs identify a client without storing the raw address. */
export function clientKeyDigest(clientKey: string): string {
  return createHash("sha256").update(clientKey).digest("hex").slice(0, 12);
}
