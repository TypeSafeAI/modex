import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readWorkspaceFile, listWorkspaceFiles } from "../src/main/engine/workspace-files.js";
import { allowedBrowserURL, browserURL } from "../src/shared/browser.js";

test("browser addresses preserve HTTPS and local previews, searches encode text, privileged schemes are refused", () => {
  assert.equal(browserURL("example.com/docs"), "https://example.com/docs");
  assert.equal(browserURL("localhost:3000/test"), "http://localhost:3000/test");
  assert.equal(browserURL("a search & a question"), "https://www.google.com/search?q=a%20search%20%26%20a%20question");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "http://example.com", "https://user:pass@example.com", "http://localhost.example.com/"]) {
    assert.equal(allowedBrowserURL(url), false);
    assert.throws(() => browserURL(url));
  }
  assert.equal(allowedBrowserURL("https://example.com/path"), true);
  assert.equal(allowedBrowserURL("http://[::1]:8080/"), true);
});

test("file previews read project files but reject traversal, escaping symlinks, binary and oversized content", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "modex-files-"));
  const root = path.join(parent, "project");
  await fs.mkdir(root);
  try {
    await fs.writeFile(path.join(root, "README.md"), "# project\n");
    await fs.writeFile(path.join(parent, "private"), "secret");
    await fs.symlink(path.join(parent, "private"), path.join(root, "escape"));
    await fs.symlink(parent, path.join(root, "outside"));
    await fs.writeFile(path.join(root, "binary"), Buffer.from([1, 0, 2]));
    await fs.writeFile(path.join(root, "large"), Buffer.alloc(1024 * 1024 + 1, 97));
    assert.equal(await readWorkspaceFile(root, "README.md"), "# project\n");
    for (const name of ["../private", "escape", "outside/private"]) await assert.rejects(readWorkspaceFile(root, name), /outside/);
    await assert.rejects(readWorkspaceFile(root, "binary"), /Binary/);
    await assert.rejects(readWorkspaceFile(root, "large"), /too large/);
    await assert.rejects(readWorkspaceFile(root, "."), /regular file/);
    const listing = await listWorkspaceFiles(root);
    assert.deepEqual(listing, { paths: ["README.md", "binary", "large"], truncated: false });
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
