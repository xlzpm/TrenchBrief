import { cache } from "react";
import { z } from "zod";

import type { Brief } from "@/lib/dto";
import { env } from "@/lib/env";

import {
  createFileBriefRepository,
  defaultBriefDirectory,
} from "./file-brief-repository";
import { createPostgresBriefRepository } from "./postgres-brief-repository";
import type { BriefRepository } from "./repository";

const moduleVersion = Symbol("trench-brief-repository");

type RepositorySlot = {
  version: symbol;
  repository: BriefRepository;
};

const globalStore = globalThis as typeof globalThis & {
  trenchBriefRepository?: unknown;
};

function isRepositorySlot(value: unknown): value is RepositorySlot {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value) || !("repository" in value)) return false;
  const repository = value.repository;
  return typeof repository === "object" && repository !== null;
}

/**
 * Postgres when DATABASE_URL is set, otherwise one JSON file per brief
 * under data/briefs. Either store keeps the first write for a share id.
 * A reloaded module gets a new slot, so publish uses the current brief schema
 * instead of the validator captured when the process first stored a brief.
 */
export function getBriefRepository(): BriefRepository {
  const current = globalStore.trenchBriefRepository;
  if (isRepositorySlot(current) && current.version === moduleVersion) {
    return current.repository;
  }

  const repository = env.DATABASE_URL
    ? createPostgresBriefRepository(env.DATABASE_URL)
    : createFileBriefRepository(defaultBriefDirectory());
  globalStore.trenchBriefRepository = { version: moduleVersion, repository };
  if (isRepositorySlot(current)) void current.repository.close?.();
  return repository;
}

export async function storeBriefVersion(
  brief: Brief,
  repository: BriefRepository,
): Promise<{ brief: Brief; saved: boolean }> {
  try {
    const stored = await repository.insert(brief);
    return { brief: stored.brief, saved: true };
  } catch (error) {
    console.error(
      `Unable to store brief ${brief.shareId}.`,
      error instanceof Error ? error.message : error,
    );
    return { brief, saved: false };
  }
}

export function publishBriefVersion(
  brief: Brief,
): Promise<{ brief: Brief; saved: boolean }> {
  return storeBriefVersion(brief, getBriefRepository());
}

export async function loadStoredBrief(
  shareId: string,
  repository: BriefRepository,
): Promise<Brief | null> {
  const parsed = z.uuid().safeParse(shareId.trim());
  if (!parsed.success) return null;
  return repository.findByShareId(parsed.data);
}

export const readBriefVersion = cache(async (shareId: string): Promise<Brief | null> => {
  return loadStoredBrief(shareId, getBriefRepository());
});

export type { BriefRepository, BriefWriteResult } from "./repository";
export { defaultBriefDirectory } from "./file-brief-repository";
