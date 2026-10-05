export const REPOSITORY = "https://github.com/TypeSafeAI/modex";

/** @param {unknown} value */
export function isVersion(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

/** @param {string} next @param {string} current */
export function isOlder(next, current) {
  const a = next.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** @param {string} version */
export function releaseLinks(version) {
  if (!isVersion(version)) throw new Error("Invalid stable version");
  return {
    version,
    url: `${REPOSITORY}/releases/tag/v${version}`,
    downloadUrl: `${REPOSITORY}/releases/download/v${version}/Modex-${version}-arm64.dmg`,
  };
}

/** Validate the entire release before changing any link. @param {any} value @param {string} current */
export function validRelease(value, current) {
  if (!value || !isVersion(value.version) || isOlder(value.version, current)) return false;
  const expected = releaseLinks(value.version);
  return value.url === expected.url && value.downloadUrl === expected.downloadUrl;
}

/** @param {unknown} value */
export function isCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
