// The CLI release clients are nudged toward, and why. Bump all three together
// in the PR that follows an npm publish: the reason is shown only next to the
// version it was written for, so a stale one can never describe a newer
// release. Keep it short, plain ASCII, and about what changes for the user.
// The site shows it in a what's-new card for two weeks from releasedAt.
export const CLI_RECOMMENDED = {
  version: '0.16.0',
  reason: 'tracks Cursor again and keeps desktop hooks working',
  releasedAt: '2026-10-29',
};
