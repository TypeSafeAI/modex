import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// setup-node@v5 reads `packageManager` (pnpm since #196) and caches that package manager by
// default, so a job that never installs pnpm fails at setup. v0.1.0's attach job did (#251),
// after every signing and acceptance job had passed. Every setup-node step must follow
// pnpm/action-setup in its job or turn the cache off.

const workflows = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

/** Each job's steps as raw text, from the workflow's own layout: jobs at 2 spaces, steps at 6. */
export function jobSteps(text) {
  const jobs = new Map();
  let job, step, inJobs = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inJobs = /^jobs:\s*$/.test(line); job = undefined; continue; }
    if (!inJobs) continue;
    const name = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (name) { job = []; jobs.set(name, job); step = undefined; continue; }
    if (!job) continue;
    if (/^ {6}- /.test(line)) { step = [line]; job.push(step); continue; }
    if (step && (/^ {7,}\S/.test(line) || /^\s*$/.test(line))) step.push(line);
    else step = undefined;
  }
  return [...jobs].map(([name, steps]) => ({ name, steps: steps.map(s => s.join('\n')) }));
}

/** Setup-node steps that would look for pnpm in a job that has not installed it. */
export function uncachedProblems(file, text) {
  const problems = [];
  for (const { name, steps } of jobSteps(text)) {
    let pnpm = false;
    for (const step of steps) {
      if (/\buses:\s*pnpm\/action-setup@/.test(step)) pnpm = true;
      if (/\buses:\s*actions\/setup-node@/.test(step) && !pnpm && !/\bpackage-manager-cache:\s*false\b/.test(step)) problems.push(`${file} job ${name}`);
    }
  }
  return problems;
}

test('every setup-node step follows pnpm/action-setup or turns the package-manager cache off', () => {
  const files = fs.readdirSync(workflows).filter(f => /\.ya?ml$/.test(f));
  let seen = 0;
  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(workflows, file), 'utf8');
    seen += jobSteps(text).flatMap(j => j.steps).filter(s => /\buses:\s*actions\/setup-node@/.test(s)).length;
    problems.push(...uncachedProblems(file, text));
  }
  assert.ok(seen > 0, 'the parser found no setup-node steps; the workflow layout changed');
  assert.deepEqual(problems, [], 'install pnpm with pnpm/action-setup before setup-node, or set package-manager-cache: false');
});

test('the check names a job that sets up node without pnpm, and accepts the two fixes', () => {
  const workflow = (steps) => `name: X\non: push\njobs:\n  attach:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: pnpm/action-setup@v4\n`;
  const setup = '      - uses: actions/setup-node@v5\n        with:\n          node-version: 24\n';
  assert.deepEqual(uncachedProblems('x.yml', workflow(`      - uses: actions/checkout@v5\n${setup}`)), ['x.yml job attach']);
  assert.deepEqual(uncachedProblems('x.yml', workflow(`      - uses: pnpm/action-setup@v4\n${setup}`)), []);
  assert.deepEqual(uncachedProblems('x.yml', workflow(`${setup}          package-manager-cache: false\n`)), []);
  // pnpm installed by another job does not count.
  assert.deepEqual(uncachedProblems('x.yml', workflow(setup).replace('jobs:\n  attach', 'jobs:\n  first:\n    steps:\n      - uses: pnpm/action-setup@v4\n  attach')), ['x.yml job attach']);
  // A named step carries `uses` on its second line.
  assert.deepEqual(uncachedProblems('x.yml', workflow('      - name: Node\n        uses: actions/setup-node@v5\n')), ['x.yml job attach']);
});
