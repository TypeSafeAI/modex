// Seeds a disposable Modex home and repository for the keyboard and VoiceOver review, driven by the
// offline scripted engine (no CLI, no usage). Prints the MODEX_HOME to launch with.
// Usage: node seed.mjs <empty directory>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || (fs.existsSync(root) && fs.readdirSync(root).length)) throw new Error("pass an empty directory");
const home = path.join(root, "home");
const repo = path.join(root, "review-repo");
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "review-script.json");
const markdown = JSON.parse(fs.readFileSync(new URL("./markdown-fixture.json", import.meta.url), "utf8")).content;
fs.mkdirSync(path.join(home, "app", "threads"), { recursive: true });
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "review-repo", private: true }, null, 2) + "\n");
fs.writeFileSync(path.join(repo, "README.md"), "# Review repository\n");
const env = { ...process.env, GIT_AUTHOR_NAME: "review", GIT_AUTHOR_EMAIL: "review@modex.local", GIT_COMMITTER_NAME: "review", GIT_COMMITTER_EMAIL: "review@modex.local" };
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
execFileSync("git", ["add", "."], { cwd: repo, env });
execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"], { cwd: repo, env });
const at = new Date().toISOString();
fs.writeFileSync(path.join(home, "app", "threads", "markdown-review.json"), JSON.stringify([
  { id: "markdown-user", kind: "user", text: "Review Markdown", at },
  { id: "markdown-answer", kind: "assistant", text: markdown, phase: "final", outcome: "succeeded", at },
]));
fs.writeFileSync(path.join(home, "app", "state.json"), JSON.stringify({
  version: 1,
  projects: [{ id: "p1", name: "review-repo", path: repo, addedAt: new Date().toISOString() }],
  threads: [{ id: "markdown-review", projectId: "p1", title: "Markdown review", titleSource: "manual", createdAt: at, updatedAt: at, cwd: repo, backend: "mock", mode: "chat", plan: false, model: "mock", status: "idle" }],
  // Chat mode is read-only, so the scripted patch and the `sleep 8` command each ask for approval.
  settings: { default_backend: "mock", default_mode: "chat", default_model: { codex: "", claude: "", mock: "mock" }, claude_bin: "claude", codex_bin: "codex", mock_script: script, routing: { jev_transport: "http" } },
}));
console.log(home);
