// Reproducible SSR parse/render measurements, not browser latency or native-provider acceptance.
// pnpm --filter @modex/desktop exec node scripts/benchmark-transcript.mjs [baseline-ref]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ref = process.argv[2] ?? '74833f78b82b901208db807bdc6ade8e7a718efa';
const sourcePath = 'apps/desktop/src/renderer/components/Markdown.tsx';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const baseline = git('show', `${ref}:${sourcePath}`);
const probe = path.join(root, '.probes', `benchmark-markdown-${process.pid}.tsx`);
fs.mkdirSync(path.dirname(probe), { recursive: true });
fs.writeFileSync(probe, baseline.replace('"../../shared/inline"', '"../src/shared/inline"').replace('"./transcript/CodeBlock"', '"../src/renderer/components/transcript/CodeBlock"'));
Object.assign(globalThis, { window: { modex: { platform: 'web', invoke: async () => {}, onEvent: () => () => {}, onTerminalEvent: () => () => {} } } });
const paragraph = 'A deterministic transcript fixture preserves ordered Unicode text: Café 日本語 👩🏽‍💻. '.repeat(7);
const document = `## Result\n\n${paragraph}\n\n| Check | Outcome |\n| --- | --- |\n| Parser | Passed |\n\n\`\`\`ts\nconst result = 42;\nconsole.log(result);\n\`\`\`\n\n${paragraph}`;
const messages = Array.from({ length: 200 }, (_, i) => `Message ${i}\n\n${document}`);
const streamed = Array.from({ length: 5 }, (_, i) => `Part ${i}\n\n${document}`).join('\n\n');
const contextual = `- Review the result\n\n  Keep the nested paragraph in this item.\n\n${streamed}\n\nSee [the reference][ref].\n\n[ref]: https://example.com/reference`;
const elapsed = fn => { const start = performance.now(); fn(); return performance.now() - start; };
const samples = [];
try {
  for (let trial = 0; trial < 3; trial++) {
    const server = await createServer({ root, configFile: false, plugins: [react()], logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
    try {
      const order = [['baseline', `/.probes/${path.basename(probe)}`], ['current', '/src/renderer/components/Markdown.tsx']];
      if (trial % 2) order.reverse();
      for (const [label, modulePath] of order) {
        const { Markdown, streamingChunks } = await server.ssrLoadModule(modulePath);
        const render = text => renderToStaticMarkup(createElement(Markdown, { text }));
        for (let warm = 0; warm < 20; warm++) render(`Warmup ${warm}\n\n${document}`);
        const coldMs = elapsed(() => messages.forEach(render));
        const reopenMs = elapsed(() => messages.forEach(render));
        const streaming = {};
        for (const [kind, document] of [['plain', streamed], ['contextual', contextual]]) {
          const deltas = [];
          for (let end = 24; end < document.length + 24; end += 24) {
            const text = document.slice(0, end);
            deltas.push(elapsed(() => streamingChunks(text).forEach(render)));
          }
          streaming[kind] = { meanMs: deltas.reduce((a,b) => a+b,0)/deltas.length, maxMs: Math.max(...deltas), deltas: deltas.length, bytes: Buffer.byteLength(document) };
        }
        samples.push({ trial, label, coldMs, reopenMs, streaming });
      }
    } finally { await server.close(); }
  }
  console.log(JSON.stringify({ fixture: '200 mixed Markdown messages; 24-character streaming deltas', messages: messages.length, transcriptBytes: Buffer.byteLength(messages.join('')), streamedBytes: Buffer.byteLength(streamed), baseline: ref, head: git('rev-parse','HEAD'), sourceSha256: createHash('sha256').update(fs.readFileSync(path.join(root,'src/renderer/components/Markdown.tsx'))).digest('hex'), node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, load: os.loadavg(), scope: 'Vite SSR parse/render only; excludes browser layout and IPC. Baseline contextual splitting is semantically incorrect, so that comparison records the cost of retaining document context.', samples }, null, 2));
} finally { fs.rmSync(probe, { force: true }); }
