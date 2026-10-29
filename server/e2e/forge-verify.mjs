// Opt-in forge verification, against a local worker and a real forge.
//   .dev.vars: VERIFIED_FORGES=<host> and FORGE_AGENT_KEY=<64 hex>
//   npx wrangler dev --port <port> --persist-to <dir>      (from server/, migrations applied)
//   node e2e/forge-verify.mjs <port> <persist-dir> <host> <owner/repo> <sha>...
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [port, persist, host, slug, ...shas] = process.argv.slice(2);
if (!port || !persist || !host || !slug || !shas.length) {
  console.error('usage: node e2e/forge-verify.mjs <port> <persist-dir> <host> <owner/repo> <sha>...');
  process.exit(2);
}
const [owner, repo] = slug.split('/');
const base = `http://127.0.0.1:${port}`;
const secret = /^JWT_SECRET=(.*)$/m.exec(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8'))[1].replace(/^"|"$/g, '');
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'vibetime', '--local', '--persist-to', persist, '--command', sql, '--json'],
  { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;

function person() {
  const id = 700000 + Math.floor(Math.random() * 99999);
  d1(`INSERT INTO users (github_id, handle, created_at, last_seen_at) VALUES (${id}, 'f${id}', '2026-01-01', '2026-01-01')`);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, handle: `f${id}`, iat: now, exp: now + 3600 })}`;
  return { id, handle: `f${id}`, jwt: `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}` };
}

async function submit(who, forge) {
  const n = shas.length;
  const body = {
    id: randomUUID(), tool: 'claude', projectHash: randomBytes(6).toString('hex'),
    startedAt: new Date(Date.now() - 3600e3).toISOString(), endedAt: new Date().toISOString(), durationSeconds: 3600,
    commits: n, linesAdded: n * 60, linesRemoved: 0, filesTouched: n * 2, shipEvents: [new Date().toISOString().slice(0, 10)],
    ...(forge ? { forge } : {}),
  };
  const res = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who.jwt}` }, body: JSON.stringify(body) });
  if (res.status !== 200) throw new Error(`submit ${res.status} ${await res.text()}`);
  return body.id;
}

async function rowFor(id) {
  for (let i = 0; i < 40; i++) {
    const rows = d1(`SELECT * FROM forge_ships WHERE session_id = '${id}'`);
    if (rows.length) return rows[0];
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

const off = person();
const offId = await submit(off, null);
await new Promise((r) => setTimeout(r, 3000));
check('not opted in: no forge check', d1(`SELECT COUNT(*) AS n FROM forge_ships WHERE session_id = '${offId}'`)[0].n === 0);

const untrusted = person();
const untrustedId = await submit(untrusted, { host: 'evil.example', owner, repo, commits: shas });
await new Promise((r) => setTimeout(r, 3000));
check('host not in VERIFIED_FORGES: ignored', d1(`SELECT COUNT(*) AS n FROM forge_ships WHERE session_id = '${untrustedId}'`)[0].n === 0);

const on = person();
const onId = await submit(on, { host, owner, repo, commits: shas });
const row = await rowFor(onId);
check('opted in: forge answered and it was recorded', !!row, row ? JSON.stringify(row) : '');
check('forge verified the commits', row?.verified === 1);
check('op-log entry recorded', typeof row?.op_seq === 'number');

const page = await (await fetch(`${base}/@${on.handle}`)).text();
check('profile shows the verified ship', page.includes('forge-verified') && page.includes(`https://${host}/api/${owner}/${repo}/dg/oplog`));
const offPage = await (await fetch(`${base}/@${off.handle}`)).text();
check('profile without opt-in shows nothing', !offPage.includes('forge-verified'));

process.exit(failed ? 1 : 0);
