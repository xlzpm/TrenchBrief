import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { BRIEF_MIGRATION_SQL, briefMigrationStatements } from "./schema";

test("brief versions and their evidence links are insert-only", () => {
  const file = readFileSync(
    path.join(process.cwd(), "db", "migrations", "001_brief_versions.sql"),
    "utf8",
  );
  assert.equal(
    BRIEF_MIGRATION_SQL.replace(/\r\n/g, "\n").trim(),
    file.replace(/\r\n/g, "\n").trim(),
  );
  const statements = briefMigrationStatements();
  const sql = statements.join("\n");

  assert.equal(statements.length, 8);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS brief_versions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS evidence_links/);
  assert.match(sql, /REFERENCES brief_versions \(share_id\)/);
  assert.match(sql, /brief_versions_ca_period_generated_at_idx/);
  assert.match(sql, /brief versions are immutable/);
  assert.equal(
    statements.some((statement) => /^(UPDATE|DELETE)\b/i.test(statement)),
    false,
  );
});
