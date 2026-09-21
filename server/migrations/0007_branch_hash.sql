-- Concurrent sessions on one repo are indistinguishable from one branch counted
-- many times without this. Salted client-side, so it groups and never names.
-- Null for every existing row and for any client that does not send one.
ALTER TABLE sessions ADD COLUMN branch_hash TEXT;
