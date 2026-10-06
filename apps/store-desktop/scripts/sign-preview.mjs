import { signAsync } from '@electron/osx-sign';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const identity = process.env.MODEX_STORE_SIGN_IDENTITY;
if (!identity || !/^[A-Fa-f0-9]{40}$/.test(identity)) throw new Error('Set MODEX_STORE_SIGN_IDENTITY to the SHA-1 of your Developer ID Application identity for this local sandbox preview.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'release/mas-dev-arm64/Modex.app');
await signAsync({
  app, platform: 'mas', type: 'development', identity, identityValidation: false,
  preAutoEntitlements: false, preEmbedProvisioningProfile: false,
  optionsForFile: (file) => ({ entitlements: path.join(root, `build/entitlements${file === app ? '' : '.inherit'}.plist`), hardenedRuntime: false }),
});
console.log('Signed local MAS sandbox preview. This is not a distribution or TestFlight package.');
