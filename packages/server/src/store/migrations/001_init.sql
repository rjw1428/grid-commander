CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  status_since INTEGER NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS units_project ON units(project_id);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  turn_id TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS orders_unit ON orders(unit_id, submitted_at, position, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_json TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  reply_to TEXT,
  relayed_from TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS messages_from ON messages(from_id, created_at);

CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  delivered_at INTEGER,
  read_at INTEGER,
  how TEXT,
  PRIMARY KEY (message_id, unit_id)
);
CREATE INDEX IF NOT EXISTS deliveries_unit ON message_deliveries(unit_id, delivered_at, read_at);

CREATE TABLE IF NOT EXISTS transcript (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool_use_id TEXT,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transcript_unit ON transcript(unit_id, at, seq);
CREATE INDEX IF NOT EXISTS transcript_tool ON transcript(unit_id, tool_use_id);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  unit_id TEXT,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER
);
CREATE INDEX IF NOT EXISTS alerts_open ON alerts(dismissed_at, created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
