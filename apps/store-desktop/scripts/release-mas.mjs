#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, symlinkSync, unlinkSync, rmSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAS_BUNDLE_ID, MAS_TEAM_ID, readJsonFile, validateMasIdentityNames, validateMasProfileMetadata } from './mas-release-config.mjs';

const storeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(storeDir, '../..');
const packageJson = readJsonFile(path.join(storeDir, 'package.json'));
const releaseDir = path.join(storeDir, 'release');
const args = new Set(process.argv.slice(2));
const shouldValidate = args.has('--validate') || args.has('--upload');
const shouldUpload = args.has('--upload');
const allowedArgs = new Set(['--validate', '--upload']);
for (const arg of args) {
  if (!allowedArgs.has(arg)) throw new Error(`MAS release: unknown argument ${arg}`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`MAS release: ${command} failed with exit code ${result.status ?? 'unknown'}`);
}

function capture(command, commandArgs, options = {}) {
  try {
    return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  } catch (error) {
    const detail = Buffer.isBuffer(error.stderr) ? error.stderr.toString() : String(error.stderr ?? '');
    throw new Error(`MAS release: ${command} failed: ${detail.trim() || error.message}`);
  }
}

function identityNames() {
  const output = capture('/usr/bin/security', ['find-identity', '-v']);
  return [...output.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function findIdentity(names, pattern, label) {
  const found = names.find((name) => pattern.test(name));
  if (!found) throw new Error(`MAS release: missing ${label} identity. Create it in Apple Developer Certificates, then retry.`);
  return found;
}

function profileMetadata(profilePath) {
  if (!existsSync(profilePath)) throw new Error(`MAS release: provisioning profile does not exist: ${profilePath}`);
  const cms = spawnSync('/usr/bin/security', ['cms', '-D', '-i', profilePath], { encoding: 'utf8' });
  if (cms.status !== 0) throw new Error(`MAS release: cannot decode provisioning profile: ${profilePath}`);
  const python = spawnSync('/usr/bin/python3', ['-c', [
    'import datetime, json, plistlib, sys',
    'def clean(value):',
    '  if isinstance(value, (bytes, bytearray)): return None',
    '  if isinstance(value, (datetime.datetime, datetime.date)): return value.isoformat()',
    '  if isinstance(value, dict): return {k: clean(v) for k, v in value.items() if k not in ("DER-Encoded-Profile", "DeveloperCertificates")}',
    '  if isinstance(value, list): return [clean(v) for v in value]',
    '  return value',
    'print(json.dumps(clean(plistlib.loads(sys.stdin.buffer.read()))))',
  ].join('\n')], { input: cms.stdout, encoding: 'utf8' });
  if (python.status !== 0) throw new Error('MAS release: cannot parse provisioning profile plist');
  try {
    return JSON.parse(python.stdout);
  } catch {
    throw new Error('MAS release: provisioning profile JSON was malformed');
  }
}

function env(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function requireApiCredentials() {
  const keyPath = env('APPLE_API_KEY');
  const keyId = env('APPLE_API_KEY_ID');
  const issuer = env('APPLE_API_ISSUER');
  if (!keyPath || !keyId || !issuer) {
    throw new Error('MAS release: --validate/--upload requires APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER');
  }
  if (!existsSync(keyPath)) throw new Error(`MAS release: APPLE_API_KEY file does not exist: ${keyPath}`);
  if (realpathSync(keyPath).startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error('MAS release: APPLE_API_KEY must be outside the repository');
  }
  return { keyPath, keyId, issuer };
}

function findPackage() {
  const candidates = readdirSync(releaseDir).filter((name) => name.endsWith('.pkg'));
  if (candidates.length !== 1) throw new Error(`MAS release: expected one .pkg in ${releaseDir}, found ${candidates.length}`);
  return path.join(releaseDir, candidates[0]);
}

function findApp() {
  const app = path.join(releaseDir, 'mas-arm64', `${packageJson.build.productName}.app`);
  if (!existsSync(app)) throw new Error(`MAS release: signed MAS app is missing: ${app}`);
  return app;
}

function verifyApp(app, appIdentity) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const details = capture('/usr/bin/codesign', ['-dvv', app]);
  if (!details.includes(`Authority=${appIdentity}`)) throw new Error(`MAS release: app is not signed by ${appIdentity}`);
  if (!details.includes(`TeamIdentifier=${MAS_TEAM_ID}`)) throw new Error(`MAS release: app team is not ${MAS_TEAM_ID}`);
  const entitlements = capture('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app]);
  if (!entitlements.includes('com.apple.security.app-sandbox')) throw new Error('MAS release: app sandbox entitlement is missing');
}

function verifyInstaller(pkg, installerIdentity) {
  const signature = capture('/usr/sbin/pkgutil', ['--check-signature', pkg]);
  if (!signature.includes(installerIdentity)) throw new Error(`MAS release: installer is not signed by ${installerIdentity}`);
}

function withApiKeyDirectory({ keyPath, keyId }, callback) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'modex-mas-api-'));
  const staged = path.join(tempDir, `AuthKey_${keyId}.p8`);
  symlinkSync(keyPath, staged);
  try {
    return callback(tempDir);
  } finally {
    unlinkSync(staged);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const profilePath = env('MODEX_MAS_PROVISIONING_PROFILE') || env('MODEX_MAS_PROFILE');
if (!profilePath) throw new Error('MAS release: set MODEX_MAS_PROVISIONING_PROFILE to the downloaded macOS App Store profile');
if (process.platform !== 'darwin') throw new Error('MAS release: Apple distribution must run on macOS');

const profile = profileMetadata(path.resolve(profilePath));
validateMasProfileMetadata(profile);
const names = identityNames();
const appIdentity = env('MODEX_MAS_APP_IDENTITY') || findIdentity(names, /^Apple Distribution: /, 'Apple Distribution');
const installerIdentity = env('MODEX_MAS_INSTALLER_IDENTITY') || findIdentity(names, /^(?:3rd Party Mac Developer Installer|Mac Installer Distribution): /, 'Mac Installer Distribution');
validateMasIdentityNames({ app: appIdentity, installer: installerIdentity });
console.log(`MAS identities: ${appIdentity}; ${installerIdentity}`);
console.log(`MAS profile: ${profile.Name || 'unnamed'} (${path.basename(path.resolve(profilePath))})`);

run('npm', ['run', 'build', '-w', '@modex/store-desktop'], { cwd: repoRoot });
run('npm', [
  'exec', '--workspace=@modex/store-desktop', '--', 'electron-builder', '--mac', 'mas', '--arm64', '--publish', 'never',
  `-c.mas.provisioningProfile=${path.resolve(profilePath)}`,
], { cwd: repoRoot, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'true' } });

const app = findApp();
const pkg = findPackage();
verifyApp(app, appIdentity);
verifyInstaller(pkg, installerIdentity);
console.log(`MAS package verified: ${pkg}`);

if (shouldValidate || shouldUpload) {
  const credentials = requireApiCredentials();
  withApiKeyDirectory(credentials, (apiPrivateKeysDir) => {
    const authEnv = { ...process.env, API_PRIVATE_KEYS_DIR: apiPrivateKeysDir };
    run('xcrun', ['altool', '--validate-app', pkg, '--api-key', credentials.keyId, '--api-issuer', credentials.issuer, '--output-format', 'normal'], { env: authEnv });
    if (shouldUpload) {
      run('xcrun', ['altool', '--upload-package', pkg, '--api-key', credentials.keyId, '--api-issuer', credentials.issuer, '--wait', '--output-format', 'normal'], { env: authEnv });
      console.log('MAS upload accepted by App Store Connect. Confirm processing and TestFlight availability in App Store Connect before inviting testers.');
    }
  });
} else {
  console.log('Local MAS verification complete. Pass --validate to run App Store Connect validation or --upload to validate and upload.');
}
