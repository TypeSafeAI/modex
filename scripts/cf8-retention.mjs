#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNewPath, parseArguments, verifyManifest, prepareRetention, runPreparedWorkloads } from "./lib/cf8-retention.mjs";
const help = `Reproduce the CF-8 retention workloads with common current pinned dependencies.

Usage: node scripts/cf8-retention.mjs --output <new-private-directory> --baseline <full-sha> --current <full-sha> [--prepare-only]
       node scripts/cf8-retention.mjs --verify <manifest.json>
       node scripts/cf8-retention.mjs --help

Source exports are rebuilt, not historical shipped binaries. Measurements are descriptive.
`;
try {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) process.stdout.write(help);
  else if (args.verify) { verifyManifest(args.verify); process.stdout.write("Verified retained source/build/dependency files; no workload launched.\n"); }
  else { assertNewPath(args.output); const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); const prepared = prepareRetention({ repoRoot: root, ...args }); const result = args.prepareOnly ? prepared : runPreparedWorkloads({ repoRoot: root, prepared }); process.stdout.write(JSON.stringify(result) + "\n"); }
} catch (error) { process.stderr.write(String(error.message) + "\n"); process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1; }
