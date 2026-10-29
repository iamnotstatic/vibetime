import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Keep the wrapped tool alive: an upload at finalization would mask a missing
// retry in its poller. The child loads shorter timings only in this fixture.
test('a running unshipped wrapper retries finished work before its tool exits', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'vibe-wrap-pending-'));
  const id = randomUUID();
  const endedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
  writeFileSync(join(home, 'sessions.json'), JSON.stringify({ sessions: [{
    id, tool: 'claude', project: 'previous', branch: 'main',
    startedAt: new Date(Date.now() - 4 * 3600_000).toISOString(), endedAt,
    durationSeconds: 3600, commits: 1, linesAdded: 80, linesRemoved: 0,
    filesTouched: 1, momentum: 'shipped', exitCode: 0,
  }] }));
  const b64 = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  const jwt = `${b64({ alg: 'HS256' })}.${b64({ sub: 1, exp: Math.floor(Date.now() / 1000) + 864000 })}.stub`;
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ jwt, handle: 't', issuedAt: new Date().toISOString() }));
  writeFileSync(join(home, 'remote-config.json'), JSON.stringify({ fetchedAt: new Date().toISOString() }));
  let child;
  let exited = false;
  let uploads = 0;
  let delivered;
  const received = new Promise((resolve) => { delivered = resolve; });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (body.id === id) {
        uploads++;
        assert.equal(exited, false, 'the settled queue must drain while the tool runs');
        delivered();
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, submittedAt: new Date().toISOString() }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const tunables = new URL('../dist/remote-config.js', import.meta.url).href;
  const wrap = new URL('../dist/wrap.js', import.meta.url).href;
  const script = `
    const { TUNABLES } = await import(${JSON.stringify(tunables)});
    TUNABLES.pollIntervalMs = 100;
    TUNABLES.inProgressSubmitIntervalMs = 60000;
    const { wrapTool } = await import(${JSON.stringify(wrap)});
    await wrapTool(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  `;
  const env = { ...process.env, VIBE_DIR: home, VIBE_API: `http://127.0.0.1:${server.address().port}` };
  delete env.VIBE_SESSION;
  child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: home, env, stdio: 'ignore' });
  const closed = new Promise((resolve) => child.on('close', () => { exited = true; resolve(); }));
  t.after(async () => { if (!exited) child.kill('SIGTERM'); await closed; });
  // Last, so it runs after the wrapper has stopped writing into home.
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let timer;
  try {
    await Promise.race([received, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('settled work was not sent by the running wrapper')), 8000); })]);
  } finally { clearTimeout(timer); }
  // Let later polls run: a successful queue item must not upload again.
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(uploads, 1);
  const stored = JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions.find((s) => s.id === id);
  assert.ok(stored.submittedAt);
});

test('a child exiting during a background flush still uploads its final session', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'vibe-wrap-final-flush-'));
  const queued = randomUUID();
  const exitFile = join(home, 'exit-tool');
  writeFileSync(join(home, 'sessions.json'), JSON.stringify({ sessions: [{
    id: queued, tool: 'claude', project: 'previous', branch: 'main',
    startedAt: new Date(Date.now() - 14400000).toISOString(), endedAt: new Date(Date.now() - 10800000).toISOString(),
    durationSeconds: 3600, commits: 1, linesAdded: 80, linesRemoved: 0,
    filesTouched: 1, momentum: 'shipped', exitCode: 0,
  }] }));
  const b64 = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ jwt: `${b64({ alg: 'HS256' })}.${b64({ sub: 1, exp: Math.floor(Date.now() / 1000) + 864000 })}.stub`, handle: 't', issuedAt: new Date().toISOString() }));
  writeFileSync(join(home, 'remote-config.json'), JSON.stringify({ fetchedAt: new Date().toISOString() }));
  const posts = [];
  let child;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const sent = JSON.parse(raw);
      posts.push(sent);
      if (sent.id === queued) child.send('finish');
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, submittedAt: new Date().toISOString() }));
      }, 300);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const tunables = new URL('../dist/remote-config.js', import.meta.url).href;
  const wrap = new URL('../dist/wrap.js', import.meta.url).href;
  const script = `
    import { writeFileSync } from 'node:fs';
    const RealDate = Date;
    let offset = 0;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); }
      static now() { return RealDate.now() + offset; }
    };
    process.on('message', () => { offset = 120000; writeFileSync(${JSON.stringify(exitFile)}, 'exit'); });
    const { TUNABLES } = await import(${JSON.stringify(tunables)});
    TUNABLES.pollIntervalMs = 100;
    const { wrapTool } = await import(${JSON.stringify(wrap)});
    await wrapTool(process.execPath, ['-e', ${JSON.stringify(`const fs=require('fs'); setInterval(()=>{ if(fs.existsSync(${JSON.stringify(exitFile)})) process.exit(0); },20);`)}]);
  `;
  const env = { ...process.env, VIBE_DIR: home, VIBE_API: `http://127.0.0.1:${server.address().port}` };
  delete env.VIBE_SESSION;
  child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: home, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGKILL');
    await gone;
  });
  // Last, so it runs after the wrapper has stopped writing into home.
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('wrapper failed to finalize')), 8000);
    child.on('close', (status) => { clearTimeout(timeout); resolve(status); });
  });
  assert.equal(code, 0, stderr);
  assert.equal(posts.filter((s) => s.id === queued).length, 1);
  const final = posts.find((s) => s.id !== queued);
  assert.ok(final, 'final snapshot uploaded after the background drain released its lock');
  assert.ok(final.durationSeconds >= 60);
  const stored = JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions.find((s) => s.id === final.id);
  assert.equal(stored.exitCode, 0);
  assert.ok(stored.submittedAt);
});
