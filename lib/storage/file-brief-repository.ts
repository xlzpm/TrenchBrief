import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { parseBrief, type Brief } from "@/lib/dto";

import { BriefStoreError } from "./errors";
import type { BriefRepository, BriefWriteResult } from "./repository";

export function defaultBriefDirectory(): string {
  return path.join(process.cwd(), "data", "briefs");
}

/** One JSON file per share id. The first write wins. */
export function createFileBriefRepository(directory: string): BriefRepository {
  const root = path.resolve(directory);

  return {
    async insert(brief): Promise<BriefWriteResult> {
      const parsed = parseBrief(brief);
      const file = resolveBriefPath(root, parsed.shareId);
      if (!file) {
        throw new BriefStoreError("invalid", "Brief share id is not a UUID.");
      }
      await mkdir(root, { recursive: true });
      try {
        await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx" });
        return { brief: parsed, created: true };
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        return { brief: await readBriefFile(file), created: false };
      }
    },

    async findByShareId(shareId): Promise<Brief | null> {
      const file = resolveBriefPath(root, shareId);
      if (!file) return null;
      try {
        return await readBriefFile(file);
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
      }
    },
  };
}

function resolveBriefPath(root: string, shareId: string): string | null {
  const parsed = z.uuid().safeParse(shareId.trim());
  if (!parsed.success) return null;
  const file = path.resolve(root, `${parsed.data.toLowerCase()}.json`);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return file;
}

async function readBriefFile(file: string): Promise<Brief> {
  try {
    return parseBrief(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw error;
    throw new BriefStoreError("corrupt", "Stored brief could not be read.", {
      cause: error,
    });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
