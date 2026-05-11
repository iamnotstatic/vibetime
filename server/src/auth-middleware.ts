import type { Env } from './env.js';
import { verifyJwt, type JwtPayload } from './jwt.js';

export async function requireAuth(request: Request, env: Env): Promise<JwtPayload | Response> {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return new Response(JSON.stringify({ error: 'missing bearer token' }), { status: 401, headers: { 'content-type': 'application/json' } });
  const payload = await verifyJwt(match[1], env.JWT_SECRET);
  if (!payload) return new Response(JSON.stringify({ error: 'invalid or expired token' }), { status: 401, headers: { 'content-type': 'application/json' } });
  return payload;
}
