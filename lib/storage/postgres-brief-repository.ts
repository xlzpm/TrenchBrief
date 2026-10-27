import { Pool, type PoolClient } from "pg";
import { z } from "zod";

import { briefMigrationStatements } from "@/db/schema";
import { parseBrief, type Brief } from "@/lib/dto";

import { collectEvidenceLinks } from "./evidence";
import { BriefStoreError } from "./errors";
import type { BriefRepository, BriefWriteResult } from "./repository";

/** Postgres store. Rows are inserted once; database triggers reject later edits. */
export function createPostgresBriefRepository(connectionString: string): BriefRepository {
  const pool = new Pool(poolConfig(connectionString));
  pool.on("error", (error) => {
    console.error("Postgres pool error.", error.message);
  });

  let schema: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    schema ??= applySchema(pool).catch((error: unknown) => {
      schema = null;
      throw error;
    });
    return schema;
  };

  return {
    async close() {
      await pool.end();
    },

    async insert(brief): Promise<BriefWriteResult> {
      const parsed = parseBrief(brief);
      await ensureSchema();
      return withTransaction(pool, async (client) => {
        const inserted = await client.query<{ share_id: string }>(
          `INSERT INTO brief_versions (
             share_id, ca, period, generated_at, schema_version, payload
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (share_id) DO NOTHING
           RETURNING share_id`,
          [
            parsed.shareId,
            parsed.ca,
            parsed.period,
            parsed.generatedAt,
            parsed.schemaVersion,
            JSON.stringify(parsed),
          ],
        );
        if (inserted.rows.length === 0) {
          return { brief: await readStoredBrief(client, parsed.shareId), created: false };
        }
        await insertEvidence(client, parsed);
        return { brief: parsed, created: true };
      });
    },

    async findByShareId(shareId): Promise<Brief | null> {
      const parsed = z.uuid().safeParse(shareId.trim());
      if (!parsed.success) return null;
      await ensureSchema();
      const result = await pool.query<{ payload: unknown }>(
        "SELECT payload FROM brief_versions WHERE share_id = $1",
        [parsed.data],
      );
      const row = result.rows[0];
      if (!row) return null;
      return readPayload(row.payload);
    },
  };
}

function poolConfig(connectionString: string) {
  const cleaned = withoutChannelBinding(connectionString);
  const hostname = new URL(cleaned).hostname;
  const local =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return {
    connectionString: cleaned,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: local ? undefined : { rejectUnauthorized: false },
  };
}

/**
 * node-postgres does not implement libpq channel binding. Neon appends it,
 * and leaving it on the string makes the remote handshake fail.
 */
function withoutChannelBinding(connectionString: string): string {
  const query = connectionString.split("?")[1];
  if (!query) return connectionString;
  const base = connectionString.slice(0, connectionString.indexOf("?"));
  const params = query.split("&").filter((part) => part.length > 0 && !part.startsWith("channel_binding="));
  return params.length > 0 ? `${base}?${params.join("&")}` : base;
}

async function applySchema(pool: Pool): Promise<void> {
  for (const statement of briefMigrationStatements()) {
    await pool.query(statement);
  }
}

async function insertEvidence(client: PoolClient, brief: Brief): Promise<void> {
  const links = collectEvidenceLinks(brief);
  if (links.length === 0) return;
  const values: unknown[] = [];
  const tuples = links.map((link, index) => {
    const offset = index * 5;
    values.push(brief.shareId, link.id, link.source, link.url, link.label);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
  });
  await client.query(
    `INSERT INTO evidence_links (share_id, evidence_id, source, url, label)
     VALUES ${tuples.join(", ")}
     ON CONFLICT DO NOTHING`,
    values,
  );
}

async function readStoredBrief(client: PoolClient, shareId: string): Promise<Brief> {
  const existing = await client.query<{ payload: unknown }>(
    "SELECT payload FROM brief_versions WHERE share_id = $1",
    [shareId],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new BriefStoreError(
      "corrupt",
      "A brief version conflicted and then could not be read.",
    );
  }
  return readPayload(row.payload);
}

function readPayload(payload: unknown): Brief {
  try {
    const data = typeof payload === "string" ? JSON.parse(payload) : payload;
    return parseBrief(data);
  } catch (error) {
    throw new BriefStoreError("corrupt", "Stored brief could not be read.", {
      cause: error,
    });
  }
}

async function withTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Callers need the error that aborted the transaction.
    }
    throw error;
  } finally {
    client.release();
  }
}
