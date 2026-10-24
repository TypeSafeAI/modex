// Seeds a disposable Modex home for the Code Review keyboard and VoiceOver review: the CR-8 journeys' synthetic
// GitHub world (apps/desktop/test/fixtures/code-review-gh-world.ts, built to dist/test), a synthetic `gh` first on
// PATH, and a throwaway gh configuration. No token is set and the person's own gh login is never read.
// Prints the command that launches the app against it.
// Usage, from apps/desktop after `pnpm build`: node ../../docs/reviews/2026-10-22-cr8-voiceover/seed.mjs <empty directory>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || (fs.existsSync(root) && fs.readdirSync(root).length)) throw new Error("pass an empty directory");
const fixture = path.resolve("dist/test/fixtures/code-review-gh-world.js");
if (!fs.existsSync(fixture)) throw new Error("run from apps/desktop after pnpm build");
const { baseWorld, WORLD_GH } = await import(pathToFileURL(fixture).href);

const home = path.join(root, "home"), repo = path.join(root, "review-repo");
const bin = path.join(root, "bin"), config = path.join(root, "gh-config"), holds = path.join(root, "holds");
for (const dir of [path.join(home, "app", "threads"), repo, bin, config, holds]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# Review repository\n");
const env = { ...process.env, GIT_AUTHOR_NAME: "review", GIT_AUTHOR_EMAIL: "review@modex.local", GIT_COMMITTER_NAME: "review", GIT_COMMITTER_EMAIL: "review@modex.local" };
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
execFileSync("git", ["add", "."], { cwd: repo, env });
execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"], { cwd: repo, env });
fs.writeFileSync(path.join(home, "app", "state.json"), JSON.stringify({
  version: 1,
  projects: [{ id: "p1", name: "review-repo", path: repo, addedAt: new Date().toISOString() }],
  threads: [],
  settings: { default_backend: "mock", default_mode: "chat", default_model: { codex: "", claude: "", mock: "mock" }, routing: { jev_transport: "http" } },
}));
fs.writeFileSync(path.join(bin, "gh"), WORLD_GH, { mode: 0o755 });
fs.writeFileSync(path.join(root, "gh-world.json"), JSON.stringify(baseWorld()));
fs.writeFileSync(path.join(root, "gh-calls.log"), "");
fs.writeFileSync(path.join(config, "hosts.yml"), "github.com:\n    user: ada-fixture\n    git_protocol: https\n");

const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
console.log([
  "env -u GH_TOKEN -u GITHUB_TOKEN -u MODEX_E2E -u MODEX_DEMO",
  `MODEX_HOME=${q(home)} MODEX_NO_LOGIN_PATH=1 GH_CONFIG_DIR=${q(config)}`,
  `FAKE_GH_WORLD=${q(path.join(root, "gh-world.json"))} FAKE_GH_LOG=${q(path.join(root, "gh-calls.log"))} FAKE_GH_HOLDS=${q(holds)}`,
  `PATH=${q(bin)}:"$PATH" npx electron .`,
].join(" "));
