-- Opt-in forge verification. A session only lands here when its user turned
-- on `vibe config set forge <host>` and the host is in VERIFIED_FORGES: the
-- server asked that forge to check the session's commits, and this is what it
-- answered. `op_seq` is the entry in the forge repo's public op-log.
CREATE TABLE forge_ships (
  session_id     TEXT PRIMARY KEY,
  user_github_id INTEGER NOT NULL,
  forge          TEXT NOT NULL,
  repo           TEXT NOT NULL,
  commits        INTEGER NOT NULL,
  verified       INTEGER NOT NULL,
  ship           INTEGER NOT NULL,
  files          INTEGER,
  op_seq         INTEGER,
  checked_at     TEXT NOT NULL
);
CREATE INDEX idx_forge_ships_user ON forge_ships(user_github_id, ship);
