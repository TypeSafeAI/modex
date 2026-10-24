import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
const output = new URL('./native-events.jsonl', import.meta.url);
const receiptFile = new URL('./native-receipt.json', import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'modex-lm1-roundtrip-'));
const fixture = join(root, 'fixture');
mkdirSync(fixture);
mkdirSync(join(root, 'codex'));
writeFileSync(join(fixture, 'sentinel.txt'), 'LM1_TOOL_SENTINEL_829173\n');
const config = ['model_provider="lm1_strata"', 'model_providers.lm1_strata.name="LM1 Strata probe"', 'model_providers.lm1_strata.base_url="http://127.0.0.1:18501/v1"', 'model_providers.lm1_strata.wire_api="responses"', 'model_providers.lm1_strata.requires_openai_auth=false', 'model_providers.lm1_strata.supports_websockets=false', 'web_search="disabled"', 'model_context_window=32768', 'model_auto_compact_token_limit=28000', 'features.multi_agent=false', 'features.multi_agent_v2=false'];
const child = spawn('/opt/homebrew/bin/codex', ['app-server', ...config.flatMap(x => ['-c', x])], { cwd: fixture, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, 'codex') }, stdio: ['pipe', 'pipe', 'pipe'] });
function ownedSleeps() {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).trim().split('\n').map(l => l.trim().split(/\s+/, 3));
    const owned = new Set([String(child.pid)]);
    for (let i = 0; i < 10; i++)
        for (const [pid, parent] of rows)
            if (owned.has(parent))
                owned.add(pid);
    return rows.filter(([pid, , comm]) => owned.has(pid) && comm?.endsWith('sleep')).map(([pid]) => Number(pid));
}
let stopPoll;
const pending = new Map();
let serial = 0;
let phase = 'setup';
let turnDone;
let interruptSent = false;
let threadId;
let turnId;
const commands = new Set();
const events = [];
const send = x => child.stdin.write(JSON.stringify(x) + '\n');
function request(method, params, timeout = 20000) { return new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, timeout); pending.set(id, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: x => { clearTimeout(timer); reject(x); } }); send({ id, method, params }); }); }
createInterface({ input: child.stdout }).on('line', line => {
    let msg;
    try {
        msg = JSON.parse(line);
    }
    catch {
        return;
    }
    appendFileSync(output, JSON.stringify({ phase, ...msg }) + '\n');
    events.push({ phase, ...msg });
    if (msg.id !== undefined && !msg.method) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (p)
            msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        return;
    }
    if (msg.id !== undefined && msg.method) {
        const command = msg.params?.command;
        const allowed = ["/bin/zsh -lc 'cat ./sentinel.txt'", "/bin/zsh -lc 'cat sentinel.txt'", "/bin/zsh -lc 'printf LM1_STOP_STARTED; sleep 30'"];
        if (msg.method === 'item/commandExecution/requestApproval' && allowed.includes(command) && resolve(msg.params.cwd) === resolve(fixture) && !msg.params.additionalPermissions) {
            send({ id: msg.id, result: { decision: 'accept' } });
            if (phase === 'stop' && !stopPoll)
                stopPoll = setInterval(() => { const pids = ownedSleeps(); if (pids.length && !interruptSent) {
                    interruptSent = true;
                    clearInterval(stopPoll);
                    receipt.observedRunningSleepPids = pids;
                    request('turn/interrupt', { threadId, turnId }).catch(e => console.error(e.message));
                } }, 250);
        }
        else
            send({ id: msg.id, result: { decision: 'cancel' } });
        return;
    }
    if (msg.method === 'turn/started')
        turnId = msg.params.turn.id;
    if (msg.method === 'item/started' && msg.params.item?.type === 'commandExecution') {
        commands.add(msg.params.item.id);
    }
    if (phase === 'stop' && msg.method === 'item/commandExecution/outputDelta' && msg.params.delta?.includes('LM1_STOP_STARTED') && !interruptSent) {
        interruptSent = true;
        setTimeout(() => request('turn/interrupt', { threadId, turnId }).catch(e => console.error(e.message)), 400);
    }
    if (msg.method === 'turn/completed')
        turnDone?.(msg.params.turn);
});
child.stderr.on('data', d => appendFileSync(new URL('./native-stderr.log', import.meta.url), d));
async function turn(name, prompt) { phase = name; commands.clear(); return new Promise(async (resolve, reject) => { const timer = setTimeout(() => { turnDone = null; reject(new Error(name + ' observation timeout; do not replay')); }, 180000); turnDone = t => { clearTimeout(timer); turnDone = null; resolve(t); }; try {
    await request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], model: 'qwen3.8-flash-next-iq3_s', effort: 'low', sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'untrusted' });
}
catch (e) {
    clearTimeout(timer);
    reject(e);
} }); }
const receipt = { root, config, model: 'qwen3.8-flash-next-iq3_s', results: [] };
try {
    receipt.initialize = await request('initialize', { clientInfo: { name: 'modex_lm1_probe', version: '0.0.1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const r = await request('thread/start', { cwd: fixture, model: receipt.model, modelProvider: 'lm1_strata', allowProviderModelFallback: false, approvalPolicy: 'untrusted', sandbox: 'read-only', ephemeral: true });
    threadId = r.thread.id;
    receipt.selected = { model: r.model, provider: r.modelProvider };
    const first = await turn('read', 'Run the native shell tool to read ./sentinel.txt. Do not edit any files or use network. Report the exact contents after reading it.');
    receipt.results.push({ phase: 'read', turn: first });
    const readItems = events.filter(e => e.phase === 'read' && e.method === 'item/completed' && e.params.item?.type === 'commandExecution').map(e => e.params.item);
    if (first.status !== 'completed' || !readItems.some(i => i.exitCode === 0 && i.aggregatedOutput?.includes('LM1_TOOL_SENTINEL_829173')))
        throw new Error('No observed successful native sentinel read');
    const stopped = await turn('stop', 'Run exactly this harmless shell command: printf LM1_STOP_STARTED; sleep 30. Do not run any other command, edit files or use network.');
    receipt.results.push({ phase: 'stop', turn: stopped, interruptSent });
    if (!interruptSent || stopped.status !== 'interrupted')
        throw new Error('Stop not observed after native command start');
    const list = await request('thread/backgroundTerminals/list', { threadId });
    receipt.terminalsBefore = list;
    for (const t of list.data ?? [])
        if (commands.has(t.itemId) && t.processId)
            await request('thread/backgroundTerminals/terminate', { threadId, processId: t.processId });
    receipt.terminalsAfter = await request('thread/backgroundTerminals/list', { threadId });
    if ((receipt.terminalsAfter.data ?? []).some(t => commands.has(t.itemId)))
        throw new Error('Owned background command remains; continuation unsafe');
    receipt.sleepPidsAfterStop = ownedSleeps();
    if (receipt.sleepPidsAfterStop.length)
        throw new Error('Owned sleep still running; continuation unsafe');
    const continued = await turn('continue', 'The previous sleep was deliberately interrupted. Do not repeat it. Run the native shell tool to read ./sentinel.txt again and report its exact contents. Do not edit files or use network.');
    receipt.results.push({ phase: 'continue', turn: continued });
    const resumed = events.filter(e => e.phase === 'continue' && e.method === 'item/completed' && e.params.item?.type === 'commandExecution').map(e => e.params.item);
    if (continued.status !== 'completed' || !resumed.some(i => i.exitCode === 0 && i.aggregatedOutput?.includes('LM1_TOOL_SENTINEL_829173')))
        throw new Error('Continuation lacked observed native read');
    receipt.status = 'passed';
}
catch (e) {
    receipt.status = 'unverified';
    receipt.error = e.message;
    process.exitCode = 1;
}
finally {
    clearInterval(stopPoll);
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ status: receipt.status, error: receipt.error, results: receipt.results.map(x => ({ phase: x.phase, status: x.turn.status })) }));
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
}
