import assert from "node:assert/strict";
import test from "node:test";

import {
  MENTION_LIMIT,
  cashtagForSymbol,
  isOfficialSource,
  linkedPostSubject,
  mentionSearchQuery,
  publicMentionQueries,
  readAccountVerification,
  selectTokenMentions,
  sourceStrength,
  sourceStrengthLabel,
  type AccountVerification,
} from "./token-attention";

const CA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SINCE = Date.parse("2026-10-26T00:00:00.000Z");

function post(overrides: {
  id: string;
  text: string;
  followers: number | null;
  likes?: number | null;
  username?: string;
  createdAt?: string;
  verification?: AccountVerification | null;
  identityVerified?: boolean | null;
  verifiedFollowers?: number | null;
}) {
  return {
    id: overrides.id,
    text: overrides.text,
    createdAt: overrides.createdAt ?? "2026-10-26T04:00:00.000Z",
    username: overrides.username ?? "ansem",
    followers: overrides.followers,
    likes: overrides.likes ?? 200,
    verification: overrides.verification ?? null,
    identityVerified: overrides.identityVerified ?? null,
    verifiedFollowers: overrides.verifiedFollowers ?? null,
  };
}

test("the search query keeps a specific ticker and drops a major one", () => {
  assert.equal(cashtagForSymbol("FIX"), "$FIX");
  assert.equal(cashtagForSymbol("$SOL"), null);
  assert.equal(cashtagForSymbol("AI"), null);
  assert.equal(cashtagForSymbol("ab"), null);
  assert.equal(
    mentionSearchQuery(CA, "FIX"),
    `("${CA}" OR $FIX) -is:retweet`,
  );
  assert.equal(mentionSearchQuery(CA, "SOL"), `"${CA}" -is:retweet`);
});

test("public search asks for the mint and a specific ticker separately", () => {
  assert.deepEqual(publicMentionQueries(CA, "FIX"), [
    `"${CA}" -is:retweet`,
    "$FIX -is:retweet",
  ]);
  assert.deepEqual(publicMentionQueries(CA, "SOL"), [`"${CA}" -is:retweet`]);
});

test("a linked account post stays only when it names this token", () => {
  const base = { ca: CA, symbol: "FIX", name: "Fixture Coin" };
  assert.equal(linkedPostSubject({ ...base, text: `send ${CA}` }), "contract");
  assert.equal(linkedPostSubject({ ...base, text: "ape $FIX" }), "ticker");
  assert.equal(linkedPostSubject({ ...base, text: "Fixture Coin is migrating" }), "account");
  assert.equal(linkedPostSubject({ ...base, text: "ANTHROPIC revenue mix" }), null);
  assert.equal(linkedPostSubject({ ...base, text: "$SOL only" }), null);
  assert.equal(linkedPostSubject({ ...base, symbol: "SOL", text: "buy $SOL" }), null);
});

test("mentions keep an official check or a post with at least 100 likes", () => {
  const events = selectTokenMentions({
    ca: CA,
    symbol: "FIX",
    sinceMs: SINCE,
    posts: [
      post({ id: "1", text: `buy ${CA}`, followers: 1_500 }),
      post({ id: "2", text: `send ${CA} now`, followers: 2_500 }),
      post({ id: "3", text: "look at $FIX", followers: 8_000 }),
      post({ id: "4", text: "$FIX is the one", followers: 12_000 }),
      post({ id: "5", text: "$FIXING is different", followers: 50_000 }),
      post({ id: "6", text: `RT @other ${CA}`, followers: 80_000 }),
      post({ id: "8", text: `fresh ${CA}`, followers: 90_000, likes: 99 }),
      post({
        id: "7",
        text: CA,
        followers: 90_000,
        createdAt: "2026-10-25T23:00:00.000Z",
      }),
    ],
  });

  assert.deepEqual(
    events.map((event) => (event.kind === "x_post" ? event.postId : "")),
    ["4", "3", "2", "1"],
  );
  const contract = events.find((event) => event.kind === "x_post" && event.postId === "2");
  const ticker = events.find((event) => event.kind === "x_post" && event.postId === "4");
  assert.equal(contract?.kind === "x_post" ? contract.about : "", "contract");
  assert.equal(ticker?.kind === "x_post" ? ticker.about : "", "ticker");
  assert.equal(contract?.kind === "x_post" ? contract.evidence[0]?.url : "", "https://x.com/ansem/status/2");
});

test("a business or government check is an official source without 100 likes", () => {
  assert.equal(readAccountVerification("organization"), "business");
  assert.equal(readAccountVerification("Business"), "business");
  assert.equal(readAccountVerification("Government"), "government");
  assert.equal(readAccountVerification("individual"), "blue");
  assert.equal(readAccountVerification("blue"), "blue");
  assert.equal(isOfficialSource({ verification: "blue", likes: 12 }), false);
  assert.equal(isOfficialSource({ verification: null, likes: 100 }), true);
  assert.equal(isOfficialSource({ verification: "business", likes: 0 }), true);

  const events = selectTokenMentions({
    ca: CA,
    symbol: "FIX",
    sinceMs: SINCE,
    posts: [
      post({ id: "1", text: `buy ${CA}`, followers: 40, likes: 3, verification: "business" }),
      post({ id: "2", text: "look at $FIX", followers: null, likes: null, verification: "government" }),
      post({ id: "3", text: `buy ${CA}`, followers: 90_000, likes: 12, verification: "blue" }),
      post({ id: "4", text: `buy ${CA}`, followers: 90_000, likes: 100, verification: "blue" }),
    ],
  });

  assert.deepEqual(
    events.map((event) => (event.kind === "x_post" ? event.postId : "")),
    ["4", "1", "2"],
  );
  const business = events.find((event) => event.kind === "x_post" && event.postId === "1");
  const government = events.find((event) => event.kind === "x_post" && event.postId === "2");
  const engaged = events.find((event) => event.kind === "x_post" && event.postId === "4");
  assert.equal(business?.kind === "x_post" ? business.verification : "", "business");
  assert.equal(government?.kind === "x_post" ? government.verification : "", "government");
  assert.equal(government?.kind === "x_post" ? government.followers : 0, null);
  assert.equal(engaged?.kind === "x_post" ? engaged.verification : "", null);
  assert.equal(engaged?.kind === "x_post" ? engaged.checked : false, true);
  assert.equal(
    engaged?.kind === "x_post" ? sourceStrengthLabel(engaged) : "",
    "Source strength 2/4: check, 15k+ followers",
  );
});

test("a check plus audience, identity, and verified followers is a strong source", () => {
  assert.equal(
    sourceStrength({
      verification: "blue",
      followers: 15_000,
      identityVerified: true,
      verifiedFollowers: 1_000,
    }),
    2,
  );
  assert.equal(
    sourceStrength({
      verification: "blue",
      followers: 15_001,
      identityVerified: true,
      verifiedFollowers: 1_001,
    }),
    4,
  );
  assert.equal(
    isOfficialSource({
      verification: "blue",
      likes: 12,
      followers: 15_001,
      identityVerified: true,
      verifiedFollowers: 1_001,
    }),
    true,
  );
  assert.equal(isOfficialSource({ verification: "none", likes: 12, followers: 90_000, identityVerified: true, verifiedFollowers: 5_000 }), false);

  const events = selectTokenMentions({
    ca: CA,
    symbol: "FIX",
    sinceMs: SINCE,
    posts: [
      post({ id: "1", text: CA, followers: 80_000, likes: 140 }),
      post({
        id: "2",
        text: CA,
        followers: 16_000,
        likes: 3,
        verification: "blue",
        identityVerified: true,
        verifiedFollowers: 1_200,
      }),
      post({
        id: "3",
        text: CA,
        followers: 40_000,
        likes: 8,
        verification: "blue",
        identityVerified: false,
        verifiedFollowers: 2_000,
      }),
    ],
  });

  assert.deepEqual(
    events.map((event) => (event.kind === "x_post" ? event.postId : "")),
    ["2", "1"],
  );
  const strong = events.find((event) => event.kind === "x_post" && event.postId === "2");
  assert.equal(strong?.kind === "x_post" ? strong.verification : "", null);
  assert.equal(strong?.kind === "x_post" ? strong.checked : false, true);
  assert.equal(strong?.kind === "x_post" ? strong.identityVerified : false, true);
  assert.equal(strong?.kind === "x_post" ? strong.verifiedFollowers : 0, 1_200);
  assert.equal(
    strong?.kind === "x_post" ? sourceStrengthLabel(strong) : "",
    "Source strength 4/4: check, 15k+ followers, ID verified, 1k+ verified followers",
  );
});

test("only the largest accounts are kept once the cap is hit", () => {
  const posts = Array.from({ length: MENTION_LIMIT + 3 }, (_, index) =>
    post({
      id: String(index + 1),
      text: CA,
      followers: 3_000 + index,
      likes: 200 + index,
      username: "caller",
    }),
  );
  const events = selectTokenMentions({ ca: CA, symbol: "FIX", sinceMs: SINCE, posts });
  assert.equal(events.length, MENTION_LIMIT);
  assert.equal(events[0]?.kind === "x_post" ? events[0].followers : 0, 3_000 + MENTION_LIMIT + 2);
});
