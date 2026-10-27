import assert from "node:assert/strict";
import test from "node:test";

import { tokenImageSources } from "./token-image";

const PUMP = "3c5KPG4oDQs3USrhTto7a8awuNTiRYVSiJhgxzXUpump";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PUMP_CDN = `https://images.pump.fun/coin-image/${PUMP}`;

test("pump mints with a blocked logo host use the pump image CDN", () => {
  assert.deepEqual(
    tokenImageSources(PUMP, "https://m.rapidlaunch.io/images/cxwPwfx4g.jpg"),
    [PUMP_CDN],
  );
  assert.deepEqual(
    tokenImageSources(
      PUMP,
      "https://ipfs.io/ipfs/bafybeicmr7boj7avgmn2mwi2cqgsn25bq2sg4j7hy4x2yqv76vkwmhd6oy",
    ),
    [PUMP_CDN],
  );
  assert.deepEqual(tokenImageSources(PUMP, null), [PUMP_CDN]);
});

test("a working provider logo stays first and the pump CDN is the fallback", () => {
  const dex = "https://cdn.dexscreener.com/cms/images/gQZbXgXhDmK7Efsl";
  assert.deepEqual(tokenImageSources(PUMP, dex), [dex, PUMP_CDN]);
  assert.deepEqual(tokenImageSources(USDC, "https://example.com/usdc.png"), [
    "https://example.com/usdc.png",
  ]);
  assert.deepEqual(tokenImageSources(USDC, null), []);
});
