import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBrief, type Brief } from "../dto";
import { collectEvidenceLinks } from "./evidence";
import { defaultBriefDirectory, createFileBriefRepository } from "./file-brief-repository";
import { loadStoredBrief, storeBriefVersion } from "./brief-repository";
import type { BriefRepository } from "./repository";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CAPTURED_AT = "2026-10-26T05:00:00.000Z";
const SHARE_A = "11111111-1111-4111-8111-111111111111";
const SHARE_B = "22222222-2222-4222-8222-222222222222";

const priceEvidence = {
  id: "ev-price",
  source: "birdeye" as const,
  url: `https://birdeye.so/token/${CA}`,
  label: "Birdeye",
};

function summaryPoint(id: string, text: string, eventId: string | null) {
  return {
    id,
    text: `${text} Observed at ${CAPTURED_AT}. Source: ${priceEvidence.label}.`,
    occurredAt: CAPTURED_AT,
    eventId,
    evidence: [priceEvidence],
  };
}

function sampleBrief(shareId: string, name = "USD Coin"): Brief {
  return parseBrief({
    schemaVersion: 1,
    shareId,
    ca: CA,
    period: "24h",
    generatedAt: CAPTURED_AT,
    snapshot: {
      ca: CA,
      name,
      symbol: "USDC",
      imageUrl: "https://example.com/usdc.png",
      priceUsd: 1,
      liquidityUsd: 1_000_000,
      volumeUsd: { "1h": 10, "6h": 20, "12h": 30, "24h": 40 },
      website: "https://www.circle.com",
      socials: { xHandle: "circle", xUrl: "https://x.com/circle" },
      capturedAt: CAPTURED_AT,
    },
    summary: [
      summaryPoint("s1", "Price held near one dollar.", "evt-price"),
      summaryPoint("s2", "Liquidity stayed above one million dollars.", null),
      summaryPoint("s3", "No separate volume event was recorded.", null),
    ],
    events: [
      {
        id: "evt-price",
        ca: CA,
        kind: "price",
        occurredAt: CAPTURED_AT,
        title: "Price moved",
        evidence: [priceEvidence],
        previousUsd: 0.99,
        currentUsd: 1,
        changePct: 1.01,
      },
    ],
  });
}

test("local versions live under data/briefs", () => {
  assert.equal(defaultBriefDirectory(), path.join(process.cwd(), "data", "briefs"));
});

test("evidence links are stored once per id and url", () => {
  const links = collectEvidenceLinks(sampleBrief(SHARE_A));
  assert.equal(links.length, 1);
  assert.equal(links[0]?.id, priceEvidence.id);
  assert.equal(links[0]?.url, priceEvidence.url);
});

test("a saved brief can be opened again and does not change", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trench-briefs-"));
  try {
    const repository = createFileBriefRepository(directory);
    const created = await repository.insert(sampleBrief(SHARE_A, "USD Coin"));
    assert.equal(created.created, true);
    assert.equal(created.brief.snapshot.name, "USD Coin");

    const again = await repository.insert(sampleBrief(SHARE_A, "Tether"));
    assert.equal(again.created, false);
    assert.equal(again.brief.snapshot.name, "USD Coin");

    const found = await repository.findByShareId(SHARE_A.toUpperCase());
    assert.equal(found?.snapshot.name, "USD Coin");
    assert.equal(found?.shareId, SHARE_A);

    const other = await repository.insert(sampleBrief(SHARE_B));
    assert.equal(other.created, true);
    assert.equal((await repository.findByShareId(SHARE_A))?.snapshot.name, "USD Coin");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a public id must be a uuid before the store is read", async () => {
  let reads = 0;
  const repository: BriefRepository = {
    async insert() {
      throw new Error("insert should not run");
    },
    async findByShareId() {
      reads += 1;
      return null;
    },
  };
  assert.equal(await loadStoredBrief("../package.json", repository), null);
  assert.equal(await loadStoredBrief("not-a-uuid", repository), null);
  assert.equal(reads, 0);
});

test("a missing share id reads as empty", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trench-briefs-"));
  try {
    const repository = createFileBriefRepository(directory);
    assert.equal(await repository.findByShareId(SHARE_B), null);
    assert.equal(await repository.findByShareId("../package.json"), null);
    assert.equal(await repository.findByShareId("not-a-uuid"), null);
    assert.equal(await loadStoredBrief(SHARE_B, repository), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishing returns the brief that was stored", async () => {
  const stored = sampleBrief(SHARE_A, "USD Coin");
  const result = await storeBriefVersion(sampleBrief(SHARE_A, "Tether"), {
    async insert() {
      return { brief: stored, created: false };
    },
    async findByShareId() {
      return stored;
    },
  });
  assert.equal(result.saved, true);
  assert.equal(result.brief.snapshot.name, "USD Coin");
});

test("storage failures keep the live brief", async () => {
  const brief = sampleBrief(SHARE_A);
  const original = console.error;
  console.error = () => {};
  try {
    const result = await storeBriefVersion(brief, {
      async insert() {
        throw new Error("disk full");
      },
      async findByShareId() {
        return null;
      },
    });
    assert.equal(result.saved, false);
    assert.equal(result.brief, brief);
  } finally {
    console.error = original;
  }
});
