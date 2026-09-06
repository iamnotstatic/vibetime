-- Per-day ship events: a session that ships across several days counts once
-- per day it shipped, not once on its end day. Backfilled from existing
-- shipped sessions as a single end-day event, which matches the old counting
-- exactly, so history is continuous.
CREATE TABLE ship_events (
  session_id TEXT NOT NULL,
  user_github_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (session_id, day)
);
CREATE INDEX idx_ship_events_user_day ON ship_events(user_github_id, day);
CREATE INDEX idx_ship_events_day ON ship_events(day);

INSERT INTO ship_events (session_id, user_github_id, day)
  SELECT id, user_github_id, date(ended_at) FROM sessions WHERE momentum = 'shipped';
