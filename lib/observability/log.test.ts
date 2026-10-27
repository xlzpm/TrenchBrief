import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "./log";
import { clientKeyDigest, clientKeyFromHeaders, withRequestId } from "./request";

test("logs are one JSON object and secrets are redacted", () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  logger.info("brief.ready", {
    ca: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    token: "super-secret-token",
    note: "Authorization: Bearer super-secret-token",
    detail: "api_key=super-secret-token",
  });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, string>;
  assert.equal(entry.level, "info");
  assert.equal(entry.event, "brief.ready");
  assert.equal(entry.token, "[redacted]");
  assert.equal(entry.note.includes("super-secret-token"), false);
  assert.match(entry.note, /Bearer \[redacted\]/);
  assert.match(entry.detail, /api_key=\[redacted\]/);
  assert.equal(typeof entry.ts, "string");
});

test("request ids and client keys stay log-safe", () => {
  const headers = new Headers({ "x-request-id": "req-123456" });
  assert.equal(withRequestId(headers, () => "generated-id"), "req-123456");
  assert.equal(headers.get("x-request-id"), "req-123456");

  const rejected = new Headers({ "x-request-id": "bad id" });
  assert.equal(withRequestId(rejected, () => "generated-id"), "generated-id");
  assert.equal(rejected.get("x-request-id"), "generated-id");

  assert.equal(
    clientKeyFromHeaders(
      new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }),
    ),
    "203.0.113.5",
  );
  assert.equal(
    clientKeyFromHeaders(new Headers({ "x-real-ip": "2001:db8::1" })),
    "2001:db8::1",
  );
  assert.equal(clientKeyFromHeaders(new Headers()), "local");
  assert.equal(clientKeyDigest("203.0.113.5"), clientKeyDigest("203.0.113.5"));
  assert.equal(clientKeyDigest("203.0.113.5").length, 12);
  assert.notEqual(clientKeyDigest("203.0.113.5"), clientKeyDigest("203.0.113.6"));
});
