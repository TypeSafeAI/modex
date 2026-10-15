import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Backend } from "../backends/types.js";
import type { PluginExecution } from "../plugins.js";
/** Deterministic, explicitly labelled demo data. Never calls a real provider or native plugin CLI. */
export function fixturePlugins(): PluginExecution {
  let installed = true;
  let enabled = true;
  return async (_target, args) => {
    if (args.includes("--help"))
      return "  list List plugins\n  details Show details\n  install Install\n  add Install\n  update Update\n  enable Enable\n  disable Disable\n  uninstall Remove\n  remove Remove\n  marketplace Sources\n  configure Configure\n  upgrade Refresh\n--json --available --scope --values-stdin";
    if (args[1] === "list")
      return JSON.stringify({
        installed: installed
          ? [
              {
                id: "modex-fixture",
                name: "modex-fixture",
                version: "1",
                enabled,
                scope: "user",
                description:
                  "Offline image fixture — simulated generation for demos and tests",
                skillText:
                  "# Offline image fixture\nGenerate a synthetic one-pixel image through the Modex fixture backend. This is not a real provider.",
              },
            ]
          : [],
        available: !installed
          ? [
              {
                id: "modex-fixture",
                name: "modex-fixture",
                version: "1",
                description: "Offline image fixture",
              },
            ]
          : [],
      });
    if (args[1] === "details")
      return "Offline fixture. This plugin simulates generation without network calls.";
    if (args[1] === "marketplace" && args[2] === "list")
      return JSON.stringify([
        { name: "modex-fixtures", source: "Built-in offline fixtures" },
      ]);
    if (["install", "add"].includes(args[1]!)) installed = true;
    if (["remove", "uninstall"].includes(args[1]!)) installed = false;
    if (args[1] === "disable") enabled = false;
    if (args[1] === "enable") enabled = true;
    return JSON.stringify({
      success: true,
      message: "Offline fixture updated",
    });
  };
}
export const imageFixtureBackend: Backend = {
  id: "mock",
  listModels: async () => [],
  dispose: async () => {},
  runTurn: async (_text, options, sink, signal) => {
    sink.assistant(
      "Offline image fixture: this is a simulated generation job.",
    );
    const answer = await sink.approval({
      canAlways: false,
      question: "Create the offline fixture image?",
      detail:
        "Writes one synthetic PNG inside this image job's output folder. No provider or network request is made.",
    });
    if (answer === "no" || signal.aborted) return { status: "interrupted" };
    if (!options.images)
      return {
        status: "failed",
        error: "Fixture image registration is unavailable.",
      };
    fs.writeFileSync(
      path.join(options.cwd, "output", "fixture.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const client = new Client({ name: "modex-image-fixture", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(options.images.url)),
      );
      const result = await client.callTool({
        name: "register",
        arguments: { file: "fixture.png" },
      });
      if (result.isError)
        return { status: "failed", error: "Fixture registration failed." };
      sink.assistant("Saved a synthetic image to the library.");
      return { status: "completed" };
    } finally {
      await client.close();
    }
  },
};
