// Opt-in integration acceptance: real rc.2 Core Agent, real isolated Chrome,
// plugin HTTP routes and the client Conversation bridge. The model is local
// and scripted; this never calls a production Host or external provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConversationBridge, createScopedTransport } from '../src/client/rc2-bridge.ts';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(process.env.DSH_EGO_VERIFY_PACKAGE || source);
const evidence = resolve(process.env.DSH_EGO_VERIFY_EVIDENCE || join(source, '../../evidence'));
const home = join(evidence, `handoff-${randomUUID()}`);
await mkdir(home, { recursive: true });
process.env.DSH_HOME = home;
process.env.DSH_EGO_ISOLATED_RUNTIME = '1';
process.env.EGO_LINUX_HEADLESS = '1';
const require = createRequire(join(process.env.DSH_EGO_CORE_MODULE_ROOT || dirname(source), '__ego_acceptance__.cjs'));
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter, createUserMessage, CallId } = await load('@deepseek-ai/dsh-llm');
const { default: SessionStore, SessionId } = await load('@deepseek-ai/dsh-session');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const { default: ToolRuntime } = await load('@deepseek-ai/dsh-tools');
const { default: AgentRegistry } = await load('@deepseek-ai/dsh-agent');
const { default: AgentLoop } = await load('@deepseek-ai/dsh-agent-loop');
const { apply } = await import(pathToFileURL(join(packageRoot, 'lib/index.js')).href);

const checks = [], routes = new Map(), tools = new Map(), disposers = [], subprocesses = [];
const entered = Promise.withResolvers(), firstReply = Promise.withResolvers();
const calls = [];
async function within(promise, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture activity timed out')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function textResponse(text) {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } }, { type: 'finish', reason: { kind: 'stop' } }];
}
class LocalAdapter extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(options) {
    calls.push(options);
    if (calls.length === 1) {
      entered.resolve();
      await Promise.race([firstReply.promise, new Promise((_, reject) => {
        if (options.signal.aborted) return reject(new Error('fixture cancelled'));
        options.signal.addEventListener('abort', () => reject(new Error('fixture cancelled')), { once: true });
      })]);
      yield* textResponse('Current reply completed');
    } else if (calls.length === 2) {
      const id = CallId('handoff-click-once'), args = JSON.stringify({ selector: '#continue-button' });
      yield* [{ type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id, name: 'ego_click', argumentsDelta: args },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'ego_click', arguments: args } },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }, { type: 'finish', reason: { kind: 'tool-calls' } }];
    } else if (calls.length === 3) yield* textResponse('Browser continuation completed');
    else throw new Error('Unexpected extra model request');
  }
}

const core = new Context();
for (const plugin of [LlmRuntime, SessionStore, SystemPrompt, ToolRuntime, AgentRegistry]) await core.plugin(plugin);
await core.plugin(AgentLoop, { agents: [] });
core.llm.registerAdapter(['ego-local-test'], new LocalAdapter());
const sessionId = `ego-handoff-${randomUUID()}`;
const agent = core.agentLoop.create(SessionId(sessionId), { provider: 'ego-local-test', model: 'scripted' });
let runtimeEnv, owner, passed = false, admissions = 0;
const reader = text => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) });
function subprocess(spec) {
  runtimeEnv = spec.env;
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: 'pipe' });
  let stdout = '', stderr = '';
  const abort = () => child.kill();
  const timer = setTimeout(abort, 45_000);
  spec.signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const collected = {};
  const done = new Promise((doneResolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer); spec.signal?.removeEventListener('abort', abort);
      collected.stdout = reader(stdout); collected.stderr = reader(stderr);
      subprocesses.push({ command: spec.argv.slice(1, 3), exitCode, signal });
      doneResolve({ exitCode, signal });
    });
  });
  child.stdin.end(spec.stdio.stdin.data);
  return { done, collected };
}
const context = {
  sessions: core.sessions, agents: core.agents,
  tools: { register(tool) { tools.set(tool.name, tool); return core.tools.register(tool); } },
  subprocess: { spawn: subprocess },
  get(name) {
    if (name === 'sessions') return core.sessions;
    if (name === 'agents') return core.agents;
    if (name === 'connection') return { requestRejection: () => undefined };
    if (name === 'webServer') return { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } };
  },
  inject(_names, callback) { callback(context); },
  on(name, callback) { return core.on(name, callback); },
  effect(job) { const dispose = job(); if (typeof dispose === 'function') disposers.push(dispose); },
};
apply(context, { chromePath: process.env.DSH_EGO_VERIFY_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
const server = createServer(async (req, res) => {
  if (req.url === '/fixture') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>clicked-0</title><button id="continue-button" onclick="document.title=\'clicked-\'+(++window.clicks)">Continue</button><script>window.clicks=0</script>');
    return;
  }
  const handler = routes.get(new URL(req.url, 'http://fixture').pathname);
  if (!handler) { res.writeHead(404); res.end(); return; }
  await handler(req, res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const transport = createScopedTransport({ sessionId }, (path, options) => fetch(base + path, options), { clientId: 'isolated-test-device' });
const invoke = (name, args = {}) => tools.get(name).execute(args, { agent, signal: new AbortController().signal });
const face = {
  sessionId,
  async prompt(content, mode) {
    admissions++;
    const message = createUserMessage({ content, source: { kind: 'user' } });
    if (mode === 'queue') agent.followup(message); else agent.steer(message);
    return { ok: true };
  },
  async cancel() { agent.cancel({ kind: 'user' }); await agent.whenIdle(); return { ok: true }; },
};
const bridge = createConversationBridge({ binding: id => id === sessionId ? { sessionId, session: face } : undefined }, transport);
const stateFile = join(home, 'plugins/ego-browser/runtime/local/ego-lite-linux/browser.json');
const cli = join(packageRoot, 'runtime/ego-linux/bin/ego-browser.mjs');
try {
  await invoke('ego_navigate', { url: base + '/fixture' });
  owner = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.ok(resolve(owner.profileDir).startsWith(home + '\\') || resolve(owner.profileDir).startsWith(home + '/'));
  checks.push('real-chrome-dedicated-fixture-profile');
  const status = await transport.get('/api/ego/control/status');
  const human = await bridge.takeOver(randomUUID(), status.hostGeneration, status.control.leaseEpoch);
  assert.equal(human.control.state, 'human'); assert.equal(human.control.held, true);
  checks.push('real-client-takeover-and-core-cancel');
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Wait for the fixture reply' }], source: { kind: 'user' } }));
  await within(entered.promise);
  assert.equal(agent.status, 'running');
  const currentPage = (await transport.post('/api/ego/context', { leaseEpoch: human.control.leaseEpoch, hostGeneration: human.hostGeneration })).context;
  const continuation = { leaseEpoch: human.control.leaseEpoch, hostGeneration: human.hostGeneration };
  const page = { ...continuation, targetId: currentPage.targetId };
  await assert.rejects(bridge.submit('busy-then-retry', 'queue', continuation, page), /continuation-agent-busy/);
  const refused = await transport.get('/api/ego/control/status');
  assert.equal(refused.control.state, 'human'); assert.equal(refused.control.recoveryRequired, false);
  assert.equal(admissions, 0); assert.equal(calls.length, 1);
  checks.push('real-running-agent-refuses-handoff-without-admission', 'busy-refusal-retains-human-control');
  await assert.rejects(invoke('ego_click', { selector: '#continue-button' }), /agent-control-blocked/);
  checks.push('no-browser-input-before-explicit-handoff');
  firstReply.resolve(); await within(agent.whenIdle());
  assert.equal(agent.status, 'idle');
  // The panel deletes a pre-admission intent on refusal and makes a new ID
  // on the next explicit click. Replaying the old Host request keeps its receipt.
  await assert.rejects(bridge.submit('busy-then-retry', 'queue', continuation, page), /continuation-agent-busy/);
  assert.equal(admissions, 0);
  checks.push('old-busy-request-keeps-original-receipt');
  const accepted = await bridge.submit('explicit-idle-retry', 'queue', continuation, page);
  assert.equal(accepted.accepted, true);
  await within(agent.whenIdle());
  assert.equal(calls.length, 3); assert.equal(admissions, 1);
  const pageInfo = await invoke('ego_page_info');
  assert.equal(pageInfo.page.title, 'clicked-1');
  checks.push('new-explicit-retry-after-core-turn-settles', 'real-core-agent-resumes-real-browser-tool', 'continued-click-applied-once');
  const turnStarts = agent.session.events.filter(event => event.type === 'turn/start');
  assert.equal(turnStarts.length, 2);
  const before = agent.session.events.length;
  assert.equal((await bridge.submit('explicit-idle-retry', 'queue', continuation, page)).accepted, true);
  assert.equal(admissions, 1); assert.equal(agent.session.events.length, before); assert.equal(calls.length, 3);
  assert.equal((await transport.get('/api/ego/control/status')).control.state, 'idle');
  checks.push('duplicate-submit-does-not-create-another-turn', 'browser-control-converges-to-idle');
  const stop = subprocess({ argv: [process.execPath, cli, '--stop', '--require-state'], env: runtimeEnv, stdio: { stdin: { data: '' } } });
  assert.equal((await stop.done).exitCode, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${owner.port}/json/version`, { signal: AbortSignal.timeout(1500) }));
  checks.push('strict-owned-fixture-browser-cleanup');
  passed = true;
  const receipt = { passed, packageRoot, packageVersion: JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version,
    coreAgentLoop: require.resolve('@deepseek-ai/dsh-agent-loop'), home, checks, modelRequests: calls.length, admissions, turns: turnStarts.length, subprocesses,
    limitation: 'No native browser panel or production Conversation was manipulated; transport Session admission uses the real isolated Core Agent.' };
  await writeFile(join(evidence, 'main-conversation-handoff-acceptance.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ passed, checks: checks.length, modelRequests: calls.length, admissions, receipt: join(evidence, 'main-conversation-handoff-acceptance.json') }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, checks, error: error?.stack || String(error) }));
  throw error;
} finally {
  firstReply.resolve();
  agent.cancel({ kind: 'disposed' }); await agent.whenIdle();
  if (!passed && owner && runtimeEnv) {
    const stop = subprocess({ argv: [process.execPath, cli, '--stop', '--require-state'], env: runtimeEnv, stdio: { stdin: { data: '' } } });
    await stop.done;
  }
  for (const dispose of disposers.reverse()) await dispose();
  await core.fiber.dispose();
  server.closeAllConnections(); await new Promise(done => server.close(done));
}
