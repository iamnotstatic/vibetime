CREATE INDEX idx_sessions_leaderboard_ended
  ON sessions(momentum, ended_at, user_github_id);
