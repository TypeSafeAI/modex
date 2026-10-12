import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BUNDLE_ID = "ai.typesafe.modex";
const PUBLISHER = `anchor apple generic and certificate leaf[subject.OU] = "9LR8Z8UQ9X" and identifier "${BUNDLE_ID}"`;
export type VerificationCommand = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
const nativeCommand: VerificationCommand = (file, args) => exec(file, [...args], {
  encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: "C", LANG: "C" },
});
interface Candidate { runningApp: string; candidate: string; version: string; arch: "arm64" | "x64" }

/** Authenticate an already contained, privately staged bundle. Does not launch or install it.
 * The update controller separately enforces stable/newer selection and rechecks archive bytes.
 */
export async function verifyMacUpdateBundle(input: Candidate, run: VerificationCommand = nativeCommand): Promise<void> {
  if (![input.runningApp, input.candidate].every(p => path.isAbsolute(p) && p.endsWith(".app") && p.length <= 4096 && !/[\x00-\x1f\x7f]/.test(p))
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.version) || input.version.length > 50
    || !["arm64", "x64"].includes(input.arch)) throw new Error("Invalid update candidate.");
  const signature = (bundle: string, requirement: string) => run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", "-R", `=${requirement}`, bundle]);
  // Check the installed trust anchor before deriving its designated requirement. Merely
  // reading codesign display output does not verify a signature or its Apple trust chain.
  await signature(input.runningApp, PUBLISHER);
  const displayed = await run("/usr/bin/codesign", ["--display", "-r-", input.runningApp]);
  const requirements = `${displayed.stdout}\n${displayed.stderr}`.split(/\r?\n/).filter(s => s.startsWith("designated => "));
  if (requirements.length !== 1 || requirements[0]!.length > 8192) throw new Error("The installed publisher requirement is unavailable.");
  const requirement = requirements[0]!.slice("designated => ".length).trim();
  if (!requirement || /[\x00-\x1f\x7f]/.test(requirement)) throw new Error("The installed publisher requirement is invalid.");
  await signature(input.candidate, PUBLISHER);
  await signature(input.candidate, requirement);
  const info = path.join(input.candidate, "Contents/Info.plist");
  const read = async (key: string) => (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, info])).stdout.trim();
  if (await read("CFBundleIdentifier") !== BUNDLE_ID || await read("CFBundleExecutable") !== "Modex") throw new Error("The update is for a different application.");
  if (await read("CFBundleShortVersionString") !== input.version) throw new Error("The update version does not match its release.");
  const architecture = (await run("/usr/bin/lipo", ["-archs", path.join(input.candidate, "Contents/MacOS/Modex")])).stdout.trim().split(/\s+/);
  if (!architecture.includes(input.arch === "x64" ? "x86_64" : "arm64")) throw new Error("The update is for a different processor.");
  const assessment = await run("/usr/sbin/spctl", ["--assess", "--verbose=2", "--type", "execute", input.candidate]);
  if (!/(?:^|\n)source=Notarized Developer ID(?:\r?\n|$)/.test(`${assessment.stdout}\n${assessment.stderr}`)) throw new Error("The update is not a notarized Developer ID application.");
}
