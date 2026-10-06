import test from 'node:test';
import assert from 'node:assert/strict';
import { MAS_BUNDLE_ID, validateMasIdentityNames, validateMasProfileMetadata } from '../scripts/mas-release-config.mjs';

test('accepts a non-debug macOS App Store profile for the store bundle', () => {
  const metadata = {
    Name: 'Modex Mac App Store',
    Platform: ['OSX'],
    ProfileDistributionType: 'STORE',
    TeamIdentifier: ['9LR8Z8UQ9X'],
    ExpirationDate: '2027-08-15T02:32:39.000Z',
    Entitlements: {
      'com.apple.application-identifier': `9LR8Z8UQ9X.${MAS_BUNDLE_ID}`,
      'com.apple.developer.team-identifier': '9LR8Z8UQ9X',
      'get-task-allow': false,
    },
  };

  assert.equal(validateMasProfileMetadata(metadata, { now: new Date('2026-10-05T00:00:00Z') }), true);
});

test('accepts Apple profiles that store the distribution type in DER payload', () => {
  const metadata = {
    Name: 'Modex Mac App Store',
    Platform: ['OSX'],
    'DER-Encoded-Profile': Buffer.from('ProfileDistributionTypeSTORE').toString('base64'),
    TeamIdentifier: ['9LR8Z8UQ9X'],
    ExpirationDate: '2027-08-15T02:32:39.000Z',
    Entitlements: {
      'com.apple.application-identifier': `9LR8Z8UQ9X.${MAS_BUNDLE_ID}`,
      'com.apple.developer.team-identifier': '9LR8Z8UQ9X',
      'get-task-allow': false,
    },
  };

  assert.equal(validateMasProfileMetadata(metadata, { now: new Date('2026-10-05T00:00:00Z') }), true);
});

test('rejects an iOS, wildcard, expired, or debug profile', () => {
  const base = {
    Platform: ['iOS'],
    ProfileDistributionType: 'STORE',
    TeamIdentifier: ['9LR8Z8UQ9X'],
    ExpirationDate: '2027-08-15T02:32:39.000Z',
    Entitlements: {
      'application-identifier': '9LR8Z8UQ9X.*',
      'com.apple.developer.team-identifier': '9LR8Z8UQ9X',
      'get-task-allow': false,
    },
  };

  const invalid = [
    base,
    { ...base, Platform: ['OSX'] },
    { ...base, Platform: ['OSX'], Entitlements: { ...base.Entitlements, 'application-identifier': `9LR8Z8UQ9X.${MAS_BUNDLE_ID}` }, ExpirationDate: '2025-01-01T00:00:00Z' },
    { ...base, Platform: ['OSX'], Entitlements: { ...base.Entitlements, 'application-identifier': `9LR8Z8UQ9X.${MAS_BUNDLE_ID}`, 'get-task-allow': true } },
  ];
  for (const metadata of invalid) {
    assert.throws(() => validateMasProfileMetadata(metadata, { now: new Date('2026-10-05T00:00:00Z') }));
  }
});

test('requires separate MAS application and installer identities', () => {
  assert.equal(validateMasIdentityNames({
    app: 'Apple Distribution: Soul Protocol LLC (9LR8Z8UQ9X)',
    installer: '3rd Party Mac Developer Installer: Soul Protocol LLC (9LR8Z8UQ9X)',
  }), true);

  assert.throws(() => validateMasIdentityNames({
    app: 'Developer ID Application: Soul Protocol LLC (9LR8Z8UQ9X)',
    installer: 'Developer ID Installer: Soul Protocol LLC (9LR8Z8UQ9X)',
  }));
});
