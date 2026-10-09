import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (platform, account_id)
);

-- Um post por (conexão, post_id da rede). Os números aqui são os mais recentes,
-- sempre substituídos, nunca somados.
CREATE TABLE IF NOT EXISTS posts (
  connection_id TEXT NOT NULL REFERENCES connections (id),
  post_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  views INTEGER NOT NULL,
  likes INTEGER NOT NULL,
  comments INTEGER NOT NULL,
  observed_at TEXT,
  first_seen_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  PRIMARY KEY (connection_id, post_id)
);

-- Histórico: uma linha por leitura que mudou os números (ou trouxe nova medição).
CREATE TABLE IF NOT EXISTS metric_snapshots (
  connection_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  snapshot_key TEXT NOT NULL,
  views INTEGER NOT NULL,
  likes INTEGER NOT NULL,
  comments INTEGER NOT NULL,
  observed_at TEXT,
  fetched_at TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  PRIMARY KEY (connection_id, post_id, snapshot_key)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections (id),
  window_since TEXT NOT NULL,
  window_until TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'rate_limited')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  provider_calls INTEGER NOT NULL DEFAULT 0,
  posts_received INTEGER NOT NULL DEFAULT 0,
  posts_new INTEGER NOT NULL DEFAULT 0,
  posts_updated INTEGER NOT NULL DEFAULT 0,
  posts_unchanged INTEGER NOT NULL DEFAULT 0,
  attempts_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  retry_at TEXT
);

-- No máximo um sync rodando por conexão.
CREATE UNIQUE INDEX IF NOT EXISTS one_running_sync ON sync_runs (connection_id) WHERE status = 'running';
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
