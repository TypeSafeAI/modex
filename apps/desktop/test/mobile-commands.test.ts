import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverMobileCommands } from "../src/main/engine/mobile-commands.js";

test("mobile commands expose only the selected provider's skills and command syntax", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-mobile-commands-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "repo");
  fs.mkdirSync(path.join(home, ".codex", "skills", "verify"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "skills", "verify", "SKILL.md"), "---\nname: verify\ndescription: Verify files in /Users/val/private/repo\n---\nSECRET BODY");
  fs.mkdirSync(path.join(root, "linked-skill"), { recursive: true });
  fs.writeFileSync(path.join(root, "linked-skill", "SKILL.md"), "---\nname: release\ndescription: Ship a verified release.\n---\n");
  fs.symlinkSync(path.join(root, "linked-skill"), path.join(home, ".codex", "skills", "release"));
  fs.mkdirSync(path.join(cwd, ".claude", "skills", "ship"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "skills", "ship", "SKILL.md"), "---\nname: ship\ndescription: Prepare a release.\n---\n");
  fs.mkdirSync(path.join(cwd, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "commands", "check.md"), "---\ndescription: Check the current work.\n---\nDo the check.");
  try {
    assert.deepEqual(discoverMobileCommands(home, cwd, "codex"), [
      { id: "skill:release", title: "release", detail: "Ship a verified release.", insertion: "$release ", kind: "skill" },
      { id: "skill:verify", title: "verify", detail: "Verify files in ~/private/repo", insertion: "$verify ", kind: "skill" },
    ]);
    assert.deepEqual(discoverMobileCommands(home, cwd, "claude"), [
      { id: "command:check", title: "check", detail: "Custom command", insertion: "/check ", kind: "command" },
      { id: "skill:ship", title: "ship", detail: "Prepare a release.", insertion: "/ship ", kind: "skill" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a skill's whole description reaches the phone, folded or quoted, without the places it points at", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-mobile-descriptions-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "repo");
  const skills = path.join(home, ".claude", "skills");
  const write = (name: string, body: string) => {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(path.join(skills, name, "SKILL.md"), body);
  };
  const long = "Use when the user asks for a deep review of a change. ".repeat(12).trim();
  write("folded", `---\nname: folded\ndescription: >\n  First line of the skill\n  and its second line.\n---\n`);
  write("quoted", `---\nname: quoted\ndescription: "${long}"\n---\n`);
  write("located", `---\nname: located\ndescription: Reads ${cwd}/docs and ${home}/notes.\n---\n`);
  write("bare", `---\nname: bare\n---\n`);
  try {
    const by = Object.fromEntries(discoverMobileCommands(home, cwd, "claude").map((c) => [c.title, c.detail]));
    assert.equal(by.folded, "First line of the skill and its second line.");
    assert.equal(by.quoted, long);
    assert.equal(by.located, "Reads <project>/docs and ~/notes.");
    assert.equal(by.bare, "Installed skill");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
