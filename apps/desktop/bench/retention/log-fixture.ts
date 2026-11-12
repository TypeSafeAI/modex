import fs from "node:fs";
import path from "node:path";
export const CHUNK = "x".repeat(64 * 1024 - 1) + "\n";
export const CHUNKS = 48;
export const PREVIEW = 256 * 1024;
// Canonical synthetic CLI plus local counter observations; never executes the emitted shell command.
export function fakeCodex(dir: string): string {
  const cli = path.join(dir, "codex-stream.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const audit = (kind, fields) => require('node:fs').appendFileSync(${JSON.stringify(path.join(dir, "stream-calls.jsonl"))}, JSON.stringify({kind,pid:process.pid,...fields}) + '\\n');
const chunk = ${JSON.stringify(CHUNK)};
let turn = 0;
const cwds = new Map();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params || {};
  if (msg.method === 'initialize') return emit({ id: msg.id, result: { userAgent: 'codex-stream/0.163.0' } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'account/read') return emit({ id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (msg.method === 'model/list') return emit({ id: msg.id, result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true }], nextCursor: null } });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const id = p.threadId || 'thr-' + cwds.size;
    cwds.set(id, p.cwd || '');
    return emit({ id: msg.id, result: { thread: { id } } });
  }
  if (msg.method === 'turn/start') {
    const id = 'turn-' + (++turn);
    const n = (method, params) => emit({ method, params: { threadId: p.threadId, turnId: id, ...params } });
    emit({ id: msg.id, result: { turn: { id } } });
    if (/modex-title-/.test(cwds.get(p.threadId) || '')) {
      audit('title-start', {threadId:p.threadId,turnId:id});
      n('item/completed', { item: { id: 'name-' + turn, type: 'agentMessage', text: 'Stream', phase: 'final_answer' } });
      return emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
    }
    audit('coding-start', {threadId:p.threadId,turnId:id});
    emit({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } });
    const command = "/bin/zsh -lc 'yes | head -c 3145728'";
    n('item/started', { item: { type: 'commandExecution', id: 'c1', command, cwd: '/repo', status: 'inProgress' } });
    let sent = 0;
    const next = () => {
      if (sent < ${CHUNKS}) { sent++; n('item/commandExecution/outputDelta', { itemId: 'c1', delta: chunk }); return setTimeout(next, 10); }
      audit('coding-finish', {threadId:p.threadId,turnId:id,deltas:sent,rawBytes:Buffer.byteLength(chunk)*sent});
      n('item/completed', { item: { type: 'commandExecution', id: 'c1', command, cwd: '/repo', status: 'completed', exitCode: 0, aggregatedOutput: chunk.repeat(${CHUNKS}) } });
      n('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Streamed the log.', phase: 'final_answer' } });
      emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
    };
    return setTimeout(next, 10);
  }
  if (msg.id !== undefined && msg.method) emit({ id: msg.id, error: { code: -32601, message: 'fixture does not implement ' + msg.method } });
});
`, { mode: 0o755 });
  return cli;
}

