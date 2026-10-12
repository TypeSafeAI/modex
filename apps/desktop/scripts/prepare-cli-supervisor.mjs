import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function prepareCliSupervisor() {
  if (process.platform !== "win32") return;
  const source = fileURLToPath(new URL("../src/main/engine/cli-supervisor.cpp", import.meta.url));
  const output = fileURLToPath(new URL("../dist/src/main/engine/cli-supervisor.exe", import.meta.url));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  try {
    execFileSync("cl.exe", ["/nologo", "/O2", "/W4", "/WX", "/EHsc", "/std:c++17", "/MT", source,
      `/Fe:${output}`, `/Fo:${output}.obj`], { stdio: "inherit" });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Windows builds require MSVC Build Tools. Run from an x64 Native Tools command prompt.");
    throw error;
  } finally { fs.rmSync(`${output}.obj`, { force: true }); }
}
