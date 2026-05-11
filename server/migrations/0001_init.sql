CREATE TABLE users (
  github_id    INTEGER PRIMARY KEY,
  handle       TEXT NOT NULL,
  avatar_url   TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  user_github_id   INTEGER NOT NULL REFERENCES users(github_id),
  tool             TEXT NOT NULL,
  project_hash     TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  ended_at         TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  commits          INTEGER NOT NULL,
  lines_added      INTEGER NOT NULL,
  lines_removed    INTEGER NOT NULL,
  files_touched    INTEGER NOT NULL,
  momentum         TEXT NOT NULL,
  submitted_at     TEXT NOT NULL
);

CREATE INDEX idx_sessions_leaderboard
  ON sessions(momentum, started_at, user_github_id);
CREATE INDEX idx_sessions_user
  ON sessions(user_github_id, started_at);

CREATE TABLE submission_log (
  user_github_id INTEGER NOT NULL,
  at             INTEGER NOT NULL
);
CREATE INDEX idx_submission_log_user ON submission_log(user_github_id, at);
