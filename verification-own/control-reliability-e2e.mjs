// Local, credential-free Chrome acceptance. Does not start or call a DSH service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { apply } from '../lib/index.js';
import { createBrowserStateStore } from '../runtime/ego-linux/src/browser-state.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const home = join(root, 'evidence', `chrome-${randomUUID()}`);
await mkdir(home, { recursive: true });
process.env.DSH_HOME = home;
process.env.DSH_EGO_ISOLATED_RUNTIME = '1';
process.env.EGO_LINUX_HEADLESS = '1';
const sessionId = 'reliability-fixture', tools = new Map(), routes = new Map(), receipts = [];
let runtimeEnv, loseNextReceipt = false, scopedScript;
const reader = text => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) });
function subprocess(spec) {
  runtimeEnv = spec.env;
  if (spec.stdio.stdin.data.includes('taskSpaces.useOrCreate(')) scopedScript = spec.stdio.stdin.data;
  let stdout = '', stderr = '';
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: 'pipe' });
  const abort = () => child.kill();
  spec.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 45_000);
  child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
  child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  const drop = loseNextReceipt; loseNextReceipt = false;
  const collected = {};
  const done = new Promise((doneResolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer); spec.signal?.removeEventListener('abort', abort);
      if (drop && exitCode === 0) { stdout = ''; stderr = 'fixture: transport receipt lost after successful input'; exitCode = 1; }
      collected.stdout = reader(stdout); collected.stderr = reader(stderr);
      receipts.push({ argv: spec.argv.slice(1, 3), exitCode, signal, preflight: stderr.includes('@@DSH_ACTION_FAILURE@@'), lostReceipt: drop });
      doneResolve({ exitCode, signal });
    });
  });
  child.stdin.end(spec.stdio.stdin.data);
  return { done, collected };
}
const ctx = {
  tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
  sessions: { get: id => id === sessionId ? { id } : undefined },
  subprocess: { spawn: subprocess },
  get(name) {
    if (name === 'sessions') return ctx.sessions;
    if (name === 'webServer') return { register({ path, handler }) { routes.set(path, handler); return () => {}; } };
    if (name === 'connection') return { requestRejection: () => undefined };
  },
  inject(_names, callback) { callback(ctx); },
  on() { return () => {}; },
  effect(job) { job(); },
};
apply(ctx, { chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
const exec = { agent: { session: { id: sessionId } }, signal: new AbortController().signal };
const invoke = (name, args = {}) => tools.get(name).execute(args, exec);
async function route(path, body) {
  const req = { method: body ? 'POST' : 'GET', url: `${path}?sessionId=${sessionId}`, socket: { remoteAddress: '127.0.0.1' },
    headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
  let status, text;
  const res = { setHeader() {}, writeHead(code) { status = code; }, end(data) { text = data; } };
  await routes.get(path)(req, res);
  return { status, ...JSON.parse(text) };
}
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>Control reliability fixture</title><button id="cancel-a" onclick="document.title=\'clicked-once\'">取消</button><button id="cancel-b">取消</button><input aria-label="凭证"><input aria-label="凭证">');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/`;
const stateFile = join(home, 'plugins', 'ego-browser', 'runtime', 'local', 'ego-lite-linux', 'browser.json');
const ownerFile = join(home, 'plugins', 'ego-browser', 'runtime', 'profile', '.dsh-browser-owner.json');
const store = createBrowserStateStore({ stateFile, ownerFile, scoped: true });
const cli = fileURLToPath(new URL('../runtime/ego-linux/bin/ego-browser.mjs', import.meta.url));
let owner, passed = false;
try {
  await invoke('ego_navigate', { url });
  owner = JSON.parse(await readFile(ownerFile, 'utf8')).state;
  assert.notEqual(resolve(owner.profileDir), resolve('C:\\Users\\Hexua\\.dsh\\plugins\\ego-browser\\runtime\\profile'));
  for (const [tool, args] of [
    ['ego_click', { selector: 'loc=role:button[name="取消"]' }],
    ['ego_hover', { selector: 'loc=role:button[name="取消"]' }],
    ['ego_fill', { selector: 'loc=role:textbox[name="凭证"]', text: 'fixture-only' }],
  ]) {
    const before = receipts.length;
    await assert.rejects(invoke(tool, args), /matched 2 elements/);
    assert.equal(receipts.length, before + 1, 'no implicit replay');
    assert.equal(receipts.at(-1).preflight, true);
    assert.equal((await route('/api/ego/control/status')).control.state, 'idle');
    await invoke('ego_page_info');
  }
  await invoke('ego_click', { selector: '#cancel-a' });
  assert.equal((await invoke('ego_page_info')).page.title, 'clicked-once');
  // A later locator error must not certify a script that already sent input.
  const space = scopedScript.match(/taskSpaces\.useOrCreate\(("[^"]*")\)/)[1];
  const multiple = subprocess({ argv: [process.execPath, cli, 'nodejs'], env: { ...runtimeEnv, DSH_EGO_ACTION_RECEIPT: randomUUID() },
    stdio: { stdin: { data: `const task = await taskSpaces.useOrCreate(${space}); await taskSpaces.switch(task.id);\n`
      + `await page.locator('#cancel-a').click(); await page.locator('loc=role:button[name="取消"]').click();\n` } } });
  assert.equal((await multiple.done).exitCode, 1);
  assert.equal(multiple.collected.stderr.readFrom(0).text.includes('@@DSH_ACTION_FAILURE@@'), false);
  // Upgrade compatibility: verify a live legacy browser before backfilling its owner.
  await rm(ownerFile);
  await invoke('ego_page_info');
  assert.equal(JSON.parse(await readFile(ownerFile, 'utf8')).state.pid, owner.pid);
  // Lose a receipt AFTER real input. The Host must retain the unsafe fence.
  loseNextReceipt = true;
  await assert.rejects(invoke('ego_click', { selector: '#cancel-b' }), /receipt lost/);
  const before = receipts.length;
  await assert.rejects(invoke('ego_snapshot'), /agent-control-blocked/);
  assert.equal(receipts.length, before);
  const status = await route('/api/ego/control/status');
  assert.equal(status.control.recoveryRequired, true);
  await rm(stateFile);
  // The same explicit recovery route now succeeds using the durable owner.
  const recovery = await route('/api/ego/control/recover', { sessionId, clientId: 'fixture-device', requestId: randomUUID(),
    hostGeneration: status.hostGeneration, leaseEpoch: status.control.leaseEpoch });
  assert.equal(recovery.status, 200, JSON.stringify(recovery));
  assert.equal(recovery.control.state, 'human');
  assert.equal(recovery.control.recoveryRequired, false);
  assert.notEqual(recovery.hostGeneration, status.hostGeneration);
  await assert.rejects(readFile(ownerFile), { code: 'ENOENT' });
  await assert.rejects(fetch(`http://127.0.0.1:${owner.port}/json/version`, { signal: AbortSignal.timeout(1500) }));
  // No identity is still a hard refusal; a forged foreign PID may never be stopped.
  let result = subprocess({ argv: [process.execPath, cli, '--stop', '--require-state'], env: runtimeEnv, stdio: { stdin: { data: '' } } });
  assert.equal((await result.done).exitCode, 1);
  await store.write({ ...owner, pid: process.pid, binary: process.execPath });
  result = subprocess({ argv: [process.execPath, cli, '--stop', '--require-state'], env: runtimeEnv, stdio: { stdin: { data: '' } } });
  assert.equal((await result.done).exitCode, 1);
  assert.match(result.collected.stderr.readFrom(0).text, /runtime-state-ownership-unverified/);
  assert.equal(process.kill(process.pid, 0), true);
  await store.forget();
  passed = true;
  const receipt = { passed, home, profile: owner.profileDir, checks: ['duplicate-click-no-pause', 'duplicate-hover-no-pause', 'duplicate-fill-no-pause',
    'corrected-click', 'prior-input-refuses-preflight-proof', 'verified-legacy-backfill', 'lost-input-receipt-stays-paused', 'deleted-browser-json-explicit-recovery',
    'generation-rotation', 'old-endpoint-gone', 'missing-identity-refused', 'foreign-live-pid-refused'], subprocesses: receipts };
  await writeFile(join(root, 'evidence', 'chrome-acceptance.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ passed, checks: receipt.checks.length, receipt: join(root, 'evidence', 'chrome-acceptance.json') }));
} finally {
  if (!passed && owner && runtimeEnv) {
    // Restore only this fixture's captured identity, then use the owned stop checks.
    await store.write(owner);
    const stop = subprocess({ argv: [process.execPath, cli, '--stop', '--require-state'], env: runtimeEnv, stdio: { stdin: { data: '' } } });
    await stop.done;
  }
  server.closeAllConnections(); await new Promise(done => server.close(done));
}
