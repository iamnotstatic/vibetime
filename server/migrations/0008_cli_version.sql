-- Which CLI produced a session's numbers. The header arrives on every request
-- and was only ever read by the auth route, so the leaderboard could not say
-- how much of itself was measured under which counting rules.
-- Null for every existing row and for any client that sends nothing usable.
ALTER TABLE sessions ADD COLUMN cli_version TEXT;
