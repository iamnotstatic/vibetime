export interface Env {
  DB: D1Database;
  GITHUB_CLIENT_ID: string;
  JWT_SECRET: string;
  // Optional: without it no commit key is issued, clients send no commit facts,
  // and submissions are scored on their totals as before.
  COMMIT_KEY_SECRET?: string;
}
