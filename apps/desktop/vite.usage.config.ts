import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// A read-only fixture preview. No desktop bridge, CLI processes, or account access.
export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer/usage", import.meta.url)),
  base: "./",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 8766, strictPort: true, cors: false },
  build: {
    outDir: "../../../dist/usage-preview",
    emptyOutDir: true,
    target: "chrome130",
  },
});
