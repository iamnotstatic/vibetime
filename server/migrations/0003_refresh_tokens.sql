-- Refresh tokens for the v0.7 auth flow: short-lived access JWTs (7d) are
-- renewed by exchanging a long-lived refresh token. Only the SHA-256 hash of
-- the token is stored, so a database leak can't mint sessions.
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_github_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_github_id);
