/** Known permission shapes from Codex app-server 0.162.1. Unknown grants fail closed. */
export function requestedPermissions(value: unknown): Record<string, unknown> | null {
  if (!fields(value, ["network", "fileSystem"])) return null;
  if (value.network != null && (!fields(value.network, ["enabled"]) ||
    (value.network.enabled != null && typeof value.network.enabled !== "boolean"))) return null;
  const fs = value.fileSystem;
  if (fs != null) {
    if (!fields(fs, ["read", "write", "entries", "globScanMaxDepth"])) return null;
    for (const paths of [fs.read, fs.write]) {
      if (paths != null && (!Array.isArray(paths) || !paths.every((p) => typeof p === "string"))) return null;
    }
    if (fs.globScanMaxDepth != null && (typeof fs.globScanMaxDepth !== "number" ||
      !Number.isSafeInteger(fs.globScanMaxDepth) || fs.globScanMaxDepth < 1)) return null;
    if (fs.entries != null && (!Array.isArray(fs.entries) || !fs.entries.every((entry) =>
      fields(entry, ["access", "path"]) && typeof entry.access === "string" && ["read", "write", "deny"].includes(entry.access) && permissionPath(entry.path)))) return null;
  }
  // Bind the response to the profile displayed before the asynchronous human decision.
  return structuredClone(value);
}

function fields(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

function permissionPath(value: unknown): boolean {
  if (!fields(value, ["type", "path", "pattern", "value"])) return false;
  if (value.type === "path") return fields(value, ["type", "path"]) && typeof value.path === "string";
  if (value.type === "glob_pattern") return fields(value, ["type", "pattern"]) && typeof value.pattern === "string";
  if (value.type !== "special" || !fields(value, ["type", "value"])) return false;
  const special = value.value;
  if (!fields(special, ["kind", "subpath"])) return false;
  if (special.kind === "project_roots") return special.subpath == null || typeof special.subpath === "string";
  return fields(special, ["kind"]) && typeof special.kind === "string" && ["root", "minimal", "tmpdir", "slash_tmp"].includes(special.kind);
}
