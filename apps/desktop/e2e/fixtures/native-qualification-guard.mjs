// Validation for the opt-in, unpackaged native fixture. This module starts no process or service.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL, DIGEST, CONTEXT } from "./local-native-spec.mjs";

export function nativeQualification({ home, enabled, e2e, packaged }) {
  if (enabled !== "1" || e2e !== "1" || packaged !== false) throw new Error("Native qualification requires an opt-in unpackaged test app.");
  const temporary = fs.realpathSync(os.tmpdir()), root = fs.realpathSync(home);
  if (!root.startsWith(temporary + path.sep) || !path.basename(root).startsWith("modex-e2e-home-")
    || JSON.parse(fs.readFileSync(path.join(root, "app/state.json"), "utf8")).settings.default_backend !== "mock") throw new Error("Native qualification requires a disposable mock home.");
  const file = path.join(root, "local-native-qualification.json"), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error("Invalid native qualification manifest.");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const cwd = fs.realpathSync(manifest.cwd), origin = new URL(manifest.origin);
  if (manifest.version !== 1 || manifest.authorization !== "local-native-lifecycle" || manifest.model !== MODEL || manifest.digest !== DIGEST || manifest.contextTokens !== CONTEXT
    || !cwd.startsWith(temporary + path.sep) || !path.basename(cwd).startsWith("modex-e2e-repo-")
    || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || Object.keys(manifest).some(key => !["version", "authorization", "model", "digest", "contextTokens", "cwd", "origin"].includes(key))) throw new Error("Native qualification is limited to the approved disposable project and model.");
  return { cwd, origin: origin.origin };
}
