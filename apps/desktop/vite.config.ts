import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function browserDev(): Plugin {
  let token = "";
  return {
    name: "modex-browser-dev",
    apply: "serve",
    configResolved(config) {
      if (config.server.host !== "127.0.0.1") throw new Error("The Modex browser bridge must bind to 127.0.0.1.");
    },
    async configureServer(server) {
      // Load the Node build without bundling native terminal modules into Vite's config.
      const entry = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "dist/src/main/browser-dev.js")).href;
      const { createBrowserDev } = await import(/* @vite-ignore */ entry);
      const bridge = createBrowserDev(process.env.MODEX_BROWSER_HOME ?? path.join(os.homedir(), ".modex-browser-dev"));
      token = bridge.token;
      server.middlewares.use((req, res, next) => { void bridge.handle(req, res, next).catch(next); });
      const close = server.close.bind(server);
      server.close = async () => { await bridge.dispose(); await close(); };
    },
    transformIndexHtml() {
      return [{ tag: "meta", attrs: { name: "modex-browser-token", content: token }, injectTo: "head" }];
    },
  };
}

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), browserDev()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true, target: "chrome130" },
  server: { host: "127.0.0.1", port: 5178, strictPort: true, cors: false },
});
