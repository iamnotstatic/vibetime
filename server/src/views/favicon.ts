// The ◆ from the README, white on the leaderboard's background.
// Same as assets/favicon.svg.
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0a0a0a"/><path d="M32 12 52 32 32 52 12 32Z" fill="#fff"/></svg>';

export function faviconResponse(): Response {
  return new Response(FAVICON_SVG, {
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=86400',
    },
  });
}
