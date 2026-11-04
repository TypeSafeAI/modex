import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "./helpers.js";

/** Bytes no tool would write: a comment, a real setting, non-UTF-8 and no trailing newline, so any rewrite shows. */
const GLOBAL_CONFIG = Buffer.concat([Buffer.from('# person\'s own Codex config\nmodel_provider = "openai"\n', "utf8"), Buffer.from([0xff, 0xfe, 0x00, 0x7a])]);

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const tree = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();

/**
 * Points this process's HOME and CODEX_HOME at a throwaway person's home holding a known `~/.codex/config.toml`,
 * so a local child that inherited or fell back to them would touch these bytes and never the real ones.
 */
export function globalCodexConfig(): { file: string; sha256: string; unchanged(): { sha256: string; bytes: boolean; mtimeMs: boolean; tree: boolean }; restore(): void } {
  const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  const home = tmpdir("lm3-person-home-");
  const dir = path.join(home, ".codex");
  const file = path.join(dir, "config.toml");
  fs.mkdirSync(dir);
  fs.writeFileSync(file, GLOBAL_CONFIG);
  const before = { mtimeMs: fs.statSync(file).mtimeMs, tree: tree(home) };
  process.env.HOME = home;
  process.env.CODEX_HOME = dir;
  return {
    file, sha256: sha256(GLOBAL_CONFIG),
    unchanged() {
      const bytes = fs.readFileSync(file);
      return { sha256: sha256(bytes), bytes: bytes.equals(GLOBAL_CONFIG), mtimeMs: fs.statSync(file).mtimeMs === before.mtimeMs, tree: JSON.stringify(tree(home)) === JSON.stringify(before.tree) };
    },
    restore() {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    },
  };
}
