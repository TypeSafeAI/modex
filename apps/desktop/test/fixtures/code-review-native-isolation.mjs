import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

let pinnedClaude;

/** Scripted provider wire data drives the installed CLI, not a real model or a mocked tool refusal. */
export async function claudeFixture(t, mode = 'candidate') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modex-cr6-claude-proof-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'snapshot'), home = path.join(root, 'home'), bin = path.join(root, 'claude');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  const installed = process.env.MODEX_CR6_CLAUDE_BIN ?? execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8', timeout: 5000 }).trim();
  pinnedClaude ??= fs.realpathSync(installed);
  fs.copyFileSync(pinnedClaude, bin, fs.constants.COPYFILE_FICLONE); fs.chmodSync(bin, 0o700);
  const selected = path.join(repo, 'selected.txt'), secret = path.join(root, 'outside-secret');
  const writeMarker = path.join(repo, 'write-marker'), hookMarker = path.join(root, 'hook-marker'), mcpMarker = path.join(root, 'mcp-marker');
  fs.writeFileSync(selected, 'synthetic-selected-evidence'); fs.writeFileSync(secret, 'synthetic-outside-secret');
  fs.symlinkSync(secret, path.join(repo, 'escape-link'));
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `/usr/bin/printf synthetic-hook > ${JSON.stringify(hookMarker)}` }] }] } }));
  const mcp = { mcpServers: { sentinel: { command: '/bin/sh', args: ['-c', `printf synthetic-mcp > ${JSON.stringify(mcpMarker)}`] } } };
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify(mcp));
  const requests = [], results = [], advertised = new Set(); let turns = 0;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', bytes => { body += bytes; if (body.length > 256 * 1024) req.destroy(); });
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url });
      if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url.includes('count_tokens') ? { input_tokens: 1 } : {})); return; }
      if (++turns > 4) { res.writeHead(429); res.end('{}'); return; }
      let data; try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('{}'); return; }
      for (const tool of data.tools ?? []) if (typeof tool.name === 'string') advertised.add(tool.name);
      results.push(...(data.messages ?? []).flatMap(m => Array.isArray(m.content) ? m.content.filter(x => x.type === 'tool_result') : []));
      const blocks = turns === 1 ? [
        { type: 'tool_use', id: 'read-good', name: 'Read', input: { file_path: selected } },
        { type: 'tool_use', id: 'read-secret', name: 'Read', input: { file_path: secret } },
        { type: 'tool_use', id: 'read-symlink', name: 'Read', input: { file_path: path.join(repo, 'escape-link') } },
        { type: 'tool_use', id: 'run-shell', name: 'Bash', input: { command: `touch ${JSON.stringify(writeMarker)}` } },
        { type: 'tool_use', id: 'write-file', name: 'Write', input: { file_path: selected, content: 'bad' } },
        { type: 'tool_use', id: 'external-write', name: 'WebFetch', input: { url: `http://127.0.0.1:${server.address().port}/unexpected-write`, prompt: 'synthetic' } },
        { type: 'tool_use', id: 'mcp-write', name: 'mcp__sentinel__write', input: { path: writeMarker } },
      ] : [{ type: 'text', text: 'synthetic-fixture-complete' }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: `msg_fixture_${turns}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      blocks.forEach((block, index) => {
        send('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
        send('content_block_stop', { type: 'content_block_stop', index });
      });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      send('message_stop', { type: 'message_stop' }); res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  // The cloned executable avoids granting reads to the real user home. No actual auth is supplied.
  const guard = `(version 1)(allow default)(deny network-outbound (require-not (remote ip "localhost:${port}")))(deny file-read* file-write* (subpath ${JSON.stringify(os.homedir())}))(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.SecurityServer"))`;
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'synthetic-invalid-api-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, GH_TOKEN: 'synthetic-gh-token', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const version = execFileSync('/usr/bin/sandbox-exec', ['-p', guard, bin, '--version'], { cwd: repo, env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }).trim();
  const common = ['--settings', settings, '--setting-sources', '', '--model', 'claude-sonnet-4-6'];
  const candidate = ['--bare', '--restricted', '--tools', 'Read', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
  // 'production': the argv Modex ships (src/main/engine/backends/claude.ts), read from the build so the two cannot drift.
  const production = mode === 'production' ? (await import('../../dist/src/main/engine/backends/claude.js')).REVIEW_CONFINEMENT_ARGS : null;
  const action = mode === 'hook-control' ? ['--init-only', ...common]
    : mode === 'mcp-control' ? ['--bare', '--restricted', '--tools', 'Read', '--mcp-config', JSON.stringify(mcp), ...common, '-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '3', '--max-budget-usd', '0.01', 'Synthetic fixture only.']
    : production ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...production, '--max-turns', '3', '--append-system-prompt', 'Synthetic fixture only.', '--settings', settings, '--model', 'claude-sonnet-4-6', '--max-budget-usd', '0.01']
    : [...candidate, ...common, '-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '3', '--max-budget-usd', '0.01', 'Synthetic fixture only.'];
  const started = Date.now();
  const child = spawn('/usr/bin/sandbox-exec', ['-p', guard, bin, ...action], { cwd: repo, env, detached: true, stdio: [production ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  // The production argv reads its prompt from stdin as Modex writes it: one stream-json user message.
  if (production) child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Synthetic fixture only.' } })}\n`);
  let stdout = '', stderr = '', timedOut = false, overflow = false;
  const terminate = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 1024 * 1024) { overflow = true; terminate(); } });
  child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 65536) { overflow = true; terminate(); } });
  const timer = setTimeout(() => { timedOut = true; terminate(); }, 45000);
  const outcome = await new Promise(resolve => { child.once('error', error => resolve({ code: null, error: error.code })); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer); terminate();
  const markers = { write: fs.existsSync(writeMarker), hook: fs.existsSync(hookMarker), mcp: fs.existsSync(mcpMarker) };
  return { ...outcome, timedOut, overflow, elapsedMs: Date.now() - started, version, installed: pinnedClaude, guard: guard.split(root).join('<fixture>'), requests, turns, results, selected: fs.readFileSync(selected, 'utf8'), advertised: [...advertised], markers, stdout, stderr };
}
