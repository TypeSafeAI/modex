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
      { id: "skill:release", title: "release", detail: "Installed skill", insertion: "$release ", kind: "skill" },
      { id: "skill:verify", title: "verify", detail: "Installed skill", insertion: "$verify ", kind: "skill" },
    ]);
    assert.deepEqual(discoverMobileCommands(home, cwd, "claude"), [
      { id: "command:check", title: "check", detail: "Custom command", insertion: "/check ", kind: "command" },
      { id: "skill:ship", title: "ship", detail: "Installed skill", insertion: "/ship ", kind: "skill" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
