-- One row per commit a user has been credited with, whichever session and
-- machine reported it first. commit_id and author_id are keyed hashes the CLI
-- computes with a per-account key; the server never receives a commit sha.
CREATE TABLE commit_credits (
  user_github_id INTEGER NOT NULL,
  commit_id      TEXT NOT NULL,
  author_id      TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  committed_at   INTEGER NOT NULL,
  lines_added    INTEGER NOT NULL,
  lines_removed  INTEGER NOT NULL,
  files          INTEGER NOT NULL,
  credited_at    TEXT NOT NULL,
  PRIMARY KEY (user_github_id, commit_id)
);
CREATE INDEX idx_commit_credits_author ON commit_credits(user_github_id, author_id);
