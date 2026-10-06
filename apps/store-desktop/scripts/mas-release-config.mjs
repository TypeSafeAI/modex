import fs from 'node:fs';

export const MAS_BUNDLE_ID = 'works.jev.modex.desktop';
export const MAS_TEAM_ID = '9LR8Z8UQ9X';

function fail(message) {
  throw new Error(`MAS release: ${message}`);
}

function profileEntitlement(metadata, key) {
  return metadata?.Entitlements?.[key] ?? metadata?.Entitlements?.[`com.apple.${key}`];
}

export function validateMasProfileMetadata(metadata, options = {}) {
  if (!metadata || typeof metadata !== 'object') fail('provisioning profile did not contain a plist');
  const bundleId = options.bundleId ?? MAS_BUNDLE_ID;
  const teamId = options.teamId ?? MAS_TEAM_ID;
  const now = options.now ?? new Date();
  if (!Array.isArray(metadata.Platform) || !metadata.Platform.includes('OSX')) {
    fail('provisioning profile is not for macOS (Platform must include OSX)');
  }
  if (metadata.ProfileDistributionType !== 'STORE') {
    fail('provisioning profile is not a Mac App Store profile');
  }
  if (!Array.isArray(metadata.TeamIdentifier) || !metadata.TeamIdentifier.includes(teamId)) {
    fail(`provisioning profile is not issued to team ${teamId}`);
  }
  const applicationIdentifier = profileEntitlement(metadata, 'application-identifier');
  if (applicationIdentifier !== `${teamId}.${bundleId}`) {
    fail(`provisioning profile application identifier must be ${teamId}.${bundleId}`);
  }
  if (profileEntitlement(metadata, 'developer.team-identifier') !== teamId) {
    fail(`provisioning profile team entitlement must be ${teamId}`);
  }
  if (profileEntitlement(metadata, 'get-task-allow') === true) {
    fail('provisioning profile allows debugging; use a distribution profile');
  }
  const expires = new Date(metadata.ExpirationDate);
  if (!Number.isFinite(expires.getTime()) || expires <= now) {
    fail('provisioning profile is expired or has no valid expiration date');
  }
  return true;
}

export function validateMasIdentityNames({ app, installer }) {
  if (typeof app !== 'string' || !/^Apple Distribution: .+/.test(app)) {
    fail('app signing identity must be an Apple Distribution certificate');
  }
  if (typeof installer !== 'string' || !/^(?:3rd Party Mac Developer Installer|Mac Installer Distribution): .+/.test(installer)) {
    fail('installer signing identity must be a Mac Installer Distribution certificate');
  }
  return true;
}

export function readJsonFile(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}
