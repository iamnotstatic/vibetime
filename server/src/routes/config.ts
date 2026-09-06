import { json } from '../http.js';

// Client tunables. The CLI ships baked-in copies of these values and treats
// this endpoint as an override, clamped to sane ranges on the client, so a
// change here reaches installed CLIs without an npm release. Roughly 30% of
// installs never update; this endpoint is the only lever we have for them.
const CLIENT_TUNABLES = {
  // wrap.ts: how often the wrapper polls git state during a session
  pollIntervalMs: 30_000,
  // wrap.ts: how often an in-progress session resubmits to the server
  inProgressSubmitIntervalMs: 5 * 60_000,
  // db.ts: idle gap after which session time stops accruing (also the hook
  // clean-reopen bound and the grace-rescore window)
  inactivityTimeoutMs: 30 * 60 * 1000,
};

export function clientConfig(): Response {
  return json(CLIENT_TUNABLES, {
    headers: { 'cache-control': 'public, max-age=300' },
  });
}
