-- Who was credited with each piece of work, so it counts once however many
-- sessions, machines or rewrites report it. Every id here is a keyed hash the
-- CLI computes with a per-account key; the server never receives a commit sha,
-- a tree sha, an email or a file name.
--
-- A piece of work is its project, author, author time and line counts, which a
-- rebase, amend or cherry-pick keeps while the commit id changes. The first
-- session to report a piece of work owns it, and keeps it through rewrites.
CREATE TABLE work_credits (
  user_github_id INTEGER NOT NULL,
  work_key       TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  credited_at    TEXT NOT NULL,
  PRIMARY KEY (user_github_id, work_key)
);

-- Every commit id reported, with the piece of work it belongs to and the tree
-- it produced. A commit keeps the work it was first filed under, so the same
-- commit seen in two projects (a fork and its upstream) is still one piece of
-- work. The tree is how a squash of an up-to-date branch is recognised: it
-- produces the same tree as the branch's last commit.
CREATE TABLE commit_credits (
  user_github_id INTEGER NOT NULL,
  commit_id      TEXT NOT NULL,
  work_key       TEXT NOT NULL,
  tree_id        TEXT NOT NULL,
  project_hash   TEXT NOT NULL,
  committed_at   INTEGER NOT NULL,
  lines_added    INTEGER NOT NULL,
  lines_removed  INTEGER NOT NULL,
  files          INTEGER NOT NULL,
  PRIMARY KEY (user_github_id, commit_id)
);
CREATE INDEX idx_commit_credits_tree ON commit_credits(user_github_id, project_hash, tree_id);
