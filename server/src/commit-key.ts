// Derived rather than stored, so there is no key table to migrate, lose or
// leak: the same account always gets the same key, on every machine, which is
// what lets two machines report one commit under one id. Bumping the version
// starts every account on a fresh key; ids from the old one stop matching.
export const COMMIT_KEY_VERSION = 1;

export async function commitKeyFor(secret: string | undefined, uid: number): Promise<string | null> {
  if (!secret) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`commit-key:v${COMMIT_KEY_VERSION}:${uid}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
