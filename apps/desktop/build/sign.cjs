// electron-builder `mac.sign` hook for the release build (see scripts/release-mac.sh).
//
// electron-builder always hands codesign the certificate *name*. A keychain that holds two
// Developer ID certificates with the same name (a renewal next to the one it replaced) makes
// that name ambiguous and codesign refuses. The release script resolves the exact certificate
// and passes its SHA-1 hash in MODEX_SIGN_HASH; this hook signs with the hash instead. Every
// other option (entitlements, hardened runtime, timestamp, the bundle walk) is what
// electron-builder already prepared. Without the hash, as in CI's single-identity temporary
// keychain, it signs exactly as electron-builder would.
const { signAsync } = require("@electron/osx-sign");

module.exports = async function sign(opts) {
  const hash = process.env.MODEX_SIGN_HASH;
  if (hash && !/^[0-9A-F]{40}$/i.test(hash)) throw new Error("MODEX_SIGN_HASH must be a 40-hex SHA-1 certificate hash");
  await signAsync(hash ? { ...opts, identity: hash, identityValidation: false } : opts);
};
