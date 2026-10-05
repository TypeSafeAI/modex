import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function prepareDesktopSystem(output) {
  if (process.platform !== 'darwin') return;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync('clang', ['-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0', '-fobjc-arc', '-O2', '-Wall', '-Wextra', '-Werror', '-framework', 'AppKit', '-framework', 'Security', fileURLToPath(new URL('../apps/desktop/src/main/engine/desktop-system.m', import.meta.url)), '-o', output], { stdio: 'inherit' });
}
