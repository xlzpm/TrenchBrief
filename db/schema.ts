let cachedStatements: string[] | null = null;

/**
 * Same text as db/migrations/001_brief_versions.sql.
 * The string lives in this module so a Vercel function can create the tables
 * without reading the SQL file from disk. The file stays for psql.
 * Versions are insert-only: triggers reject UPDATE and DELETE.
 */
export const BRIEF_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS brief_versions (
  share_id uuid PRIMARY KEY,
  ca text NOT NULL CHECK (ca ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  period text NOT NULL CHECK (period IN ('1h', '6h', '12h', '24h')),
  generated_at timestamptz NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence_links (
  share_id uuid NOT NULL REFERENCES brief_versions (share_id),
  evidence_id text NOT NULL CHECK (char_length(evidence_id) > 0),
  source text NOT NULL CHECK (source IN ('birdeye', 'dexscreener', 'jupiter', 'x', 'website')),
  url text NOT NULL CHECK (char_length(url) > 0),
  label text NOT NULL CHECK (char_length(label) > 0),
  PRIMARY KEY (share_id, evidence_id, url)
);

CREATE INDEX IF NOT EXISTS brief_versions_ca_period_generated_at_idx
  ON brief_versions (ca, period, generated_at DESC);

CREATE OR REPLACE FUNCTION brief_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'brief versions are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brief_versions_no_update ON brief_versions;

CREATE TRIGGER brief_versions_no_update
  BEFORE UPDATE OR DELETE ON brief_versions
  FOR EACH ROW EXECUTE FUNCTION brief_versions_reject_mutation();

DROP TRIGGER IF EXISTS evidence_links_no_update ON evidence_links;

CREATE TRIGGER evidence_links_no_update
  BEFORE UPDATE OR DELETE ON evidence_links
  FOR EACH ROW EXECUTE FUNCTION brief_versions_reject_mutation();
`;

/** Statements applied before a Postgres brief repository is used. */
export function briefMigrationStatements(): string[] {
  if (cachedStatements) return cachedStatements;
  cachedStatements = BRIEF_MIGRATION_SQL.replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  return cachedStatements;
}
