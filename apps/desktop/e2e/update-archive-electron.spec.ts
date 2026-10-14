import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { launch, seedHome } from "./support";

// Electron's own fs treats any path ending in ".asar" as an archive to read. Every real update
// carries Contents/Resources/app.asar, so staging runs where unit tests cannot: inside Electron.
test("update staging inside Electron extracts the candidate's app.asar as a regular file", async () => {
  const { home, repo } = seedHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-update-asar-"));
  const archive = path.join(dir, "candidate.zip");
  const asar = "candidate application archive bytes";
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from("#!/bin/sh\n"), "Modex.app/Contents/MacOS/Modex", { mode: 0o100755 });
  zip.addBuffer(Buffer.from(asar), "Modex.app/Contents/Resources/app.asar", { mode: 0o100644 });
  zip.addBuffer(Buffer.from("native"), "Modex.app/Contents/Resources/app.asar.unpacked/native.node", { mode: 0o100644 });
  const writing = pipeline(zip.outputStream, fs.createWriteStream(archive));
  zip.end(); await writing;
  const bytes = fs.readFileSync(archive);
  const parent = path.join(dir, "updates");
  fs.mkdirSync(parent, { mode: 0o700 });
  const { app } = await launch(home);
  try {
    const result = await app.evaluate(async ({ app }, input) => {
      const { join, dirname } = process.getBuiltinModule("node:path");
      // The same loading the release's native updater harness uses, in dev and packaged builds.
      const require = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
      const raw = require("original-fs");
      const { stageUpdateArchive } = require("./dist/src/main/engine/update-archive.js");
      try {
        const staged = await stageUpdateArchive(input.archive, { parent: input.parent, sha512: input.sha512, size: input.size });
        const resources = join(staged.bundle, "Contents/Resources");
        const extracted = {
          isFile: raw.lstatSync(join(resources, "app.asar")).isFile(),
          text: raw.readFileSync(join(resources, "app.asar"), "utf8"),
          unpacked: raw.readFileSync(join(resources, "app.asar.unpacked/native.node"), "utf8"),
        };
        await staged.dispose();
        return { ...extracted, removed: !raw.existsSync(dirname(staged.bundle)) };
      } catch (error) { return { error: String((error as Error).message) }; }
    }, { archive, parent, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") });
    expect(result).toEqual({ isFile: true, text: asar, unpacked: "native", removed: true });
  } finally {
    await app.close();
    for (const p of [dir, home, repo]) fs.rmSync(p, { recursive: true, force: true });
  }
});
