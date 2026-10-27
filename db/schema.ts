import { readFileSync } from "node:fs";
import path from "node:path";

const MIGRATION_PATH = path.join(
  process.cwd(),
  "db",
  "migrations",
  "001_brief_versions.sql",
);

let cachedStatements: string[] | null = null;

/**
 * Statements applied before a Postgres brief repository is used.
 * The migration file is the source of truth and can also be run with psql.
 * Versions are insert-only: triggers reject UPDATE and DELETE.
 */
export function briefMigrationStatements(): string[] {
  if (cachedStatements) return cachedStatements;
  const sql = readFileSync(MIGRATION_PATH, "utf8").replace(/\r\n/g, "\n");
  cachedStatements = sql
    .split(/\n{2,}/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  return cachedStatements;
}
