import type { EvidenceLink } from "../dto/common";
import type { TokenSnapshot } from "../dto/token-snapshot";

export type SourcedSnapshot = {
  snapshot: TokenSnapshot;
  evidence: EvidenceLink;
};

export type MarketSnapshotResult = {
  snapshot: TokenSnapshot;
  evidence: EvidenceLink[];
};
