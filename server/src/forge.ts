import type { Env } from './env.js';

// Opt-in forge verification. A CLI with `vibe config set forge <host>` sends a
// `forge` field naming the forge repo and the raw commit shas a session was
// credited with. If the host is one this server trusts (VERIFIED_FORGES), the
// server asks the forge to check them via its /dg/ship endpoint: the forge
// finds each commit, recomputes the changed files itself, applies the ship bar
// and appends the verdict to the repo's public, hash-chained op-log. The CLI
// never talks to the forge; this server is the only caller.

const MAX_COMMITS = 64;
const SHA_RE = /^[0-9a-f]{40}$/i;
const SLUG_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SEED_RE = /^[0-9a-f]{64}$/i;
const TIMEOUT_MS = 8000;

export interface ForgeClaim {
  host: string;
  owner: string;
  repo: string;
  commits: string[];
}

export interface ForgeSession {
  id: string;
  tool: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
}

interface ShipVerdict {
  verified: boolean;
  ship: boolean;
  stats?: { files?: number | null };
  op_seq?: number | null;
}

function trustedHosts(env: Env): Set<string> {
  if (!env.FORGE_AGENT_KEY || !SEED_RE.test(env.FORGE_AGENT_KEY)) return new Set();
  return new Set((env.VERIFIED_FORGES ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
}

// Never a 400, like commitFacts: anything off is dropped and the session is
// scored exactly as if the field were absent.
export function parseForge(raw: unknown, env: Env): ForgeClaim | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = (raw as Record<string, unknown>).forge;
  if (typeof f !== 'object' || f === null) return null;
  const { host, owner, repo, commits } = f as Record<string, unknown>;
  if (typeof host !== 'string' || !trustedHosts(env).has(host.toLowerCase())) return null;
  if (typeof owner !== 'string' || !SLUG_RE.test(owner)) return null;
  if (typeof repo !== 'string' || !SLUG_RE.test(repo)) return null;
  if (!Array.isArray(commits) || commits.length === 0 || commits.length > MAX_COMMITS) return null;
  if (!commits.every((c) => typeof c === 'string' && SHA_RE.test(c))) return null;
  return { host: host.toLowerCase(), owner, repo, commits: [...new Set(commits.map((c: string) => c.toLowerCase()))] };
}

// --- the server's forge identity --------------------------------------------
// A did:key ed25519 agent derived from FORGE_AGENT_KEY. Forges register agents
// permissionlessly by public key, so the first check registers it.

interface Agent {
  did: string;
  pubkeyHex: string;
  key: CryptoKey;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (input: string | Uint8Array) =>
  toHex(await crypto.subtle.digest('SHA-256', typeof input === 'string' ? new TextEncoder().encode(input) : input));

async function agentFor(seedHex: string): Promise<Agent> {
  // PKCS8 for a bare ed25519 seed: a fixed 16-byte header, then the seed.
  const pkcs8 = new Uint8Array([...fromHex('302e020100300506032b657004220420'), ...fromHex(seedHex)]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']) as CryptoKey;
  const jwk = await crypto.subtle.exportKey('jwk', key) as JsonWebKey;
  const pub = Uint8Array.from(atob(jwk.x!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return { did: `did:key:z${b58(new Uint8Array([0xed, 0x01, ...pub]))}`, pubkeyHex: toHex(pub), key };
}

// The forge's dg1 envelope: sign the hex sha256 of the canonical request.
async function signedPost(host: string, path: string, body: string, agent: Agent): Promise<Response> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const canonical = `dg1\n${agent.did}\n${ts}\n${nonce}\nPOST\n${path}\n${await sha256Hex(body)}`;
  const sig = await crypto.subtle.sign('Ed25519', agent.key, new TextEncoder().encode(await sha256Hex(canonical)));
  return fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dg-did': agent.did,
      'x-dg-ts': ts,
      'x-dg-nonce': nonce,
      'x-dg-sig': toHex(sig),
      'x-dg-model': 'vibetime-server',
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function register(host: string, agent: Agent): Promise<void> {
  const res = await fetch(`https://${host}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey: agent.pubkeyHex, label: 'vibetime', model: 'vibetime-server' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 409) throw new Error(`forge register ${res.status}`);
}

/**
 * Asks the forge to verify a session's commits and records its answer. Runs
 * after the submit has been answered, and every failure is logged and dropped:
 * scoring never waits on, or depends on, a forge.
 */
export async function verifyForgeShip(env: Env, uid: number, session: ForgeSession, claim: ForgeClaim): Promise<void> {
  try {
    // A session is re-checked only when it names more commits than last time,
    // so resubmits of the same work cost the forge nothing.
    const prior = await env.DB.prepare(`SELECT commits FROM forge_ships WHERE session_id = ?`)
      .bind(session.id).first<{ commits: number }>();
    if (prior && prior.commits >= claim.commits.length) return;

    const agent = await agentFor(env.FORGE_AGENT_KEY!);
    const path = `/api/${encodeURIComponent(claim.owner)}/${encodeURIComponent(claim.repo)}/dg/ship`;
    const body = JSON.stringify({
      session_id: session.id,
      tool: session.tool,
      started_at: session.startedAt,
      ended_at: session.endedAt,
      duration_seconds: Math.round(session.durationSeconds),
      commits: claim.commits,
      claimed: { lines_added: session.linesAdded, lines_removed: session.linesRemoved, files_touched: session.filesTouched },
    });

    let res = await signedPost(claim.host, path, body, agent);
    if (res.status === 401 || res.status === 403) {
      await register(claim.host, agent);
      res = await signedPost(claim.host, path, body, agent);
    }
    if (!res.ok) {
      console.warn(`forge check failed: ${claim.host} ${res.status}`);
      return;
    }
    const verdict = await res.json() as ShipVerdict;
    await env.DB.prepare(
      `INSERT INTO forge_ships (session_id, user_github_id, forge, repo, commits, verified, ship, files, op_seq, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         forge = excluded.forge, repo = excluded.repo, commits = excluded.commits,
         verified = excluded.verified, ship = excluded.ship, files = excluded.files,
         op_seq = excluded.op_seq, checked_at = excluded.checked_at
       WHERE forge_ships.user_github_id = excluded.user_github_id`,
    ).bind(
      session.id, uid, claim.host, `${claim.owner}/${claim.repo}`, claim.commits.length,
      verdict.verified ? 1 : 0, verdict.verified && verdict.ship ? 1 : 0,
      typeof verdict.stats?.files === 'number' ? verdict.stats.files : null,
      typeof verdict.op_seq === 'number' ? verdict.op_seq : null,
      new Date().toISOString(),
    ).run();
  } catch (e) {
    console.warn(`forge check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
