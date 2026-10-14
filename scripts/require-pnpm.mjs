#!/usr/bin/env node
// Root preinstall. npm and Yarn already refuse through devEngines and packageManager;
// this catches installers that ignore both fields (Bun, npm before 10.9).
const agent = process.env.npm_config_user_agent ?? '';
if (!agent.startsWith('pnpm/')) {
  const used = agent.split(' ')[0] || 'an unknown installer';
  console.error(`This repository installs with pnpm, not ${used}.
Run: corepack enable pnpm && pnpm install
Remove any node_modules this attempt created before running pnpm.`);
  process.exit(1);
}
