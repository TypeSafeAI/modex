import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The desktop renderer and the Store edition's in-memory demo are bundled from their own
// packages; nothing here starts a host, a CLI or a network client.
export default defineConfig({
  plugins: [react()],
  build: { target: "es2022" },
  server: { port: 5179, strictPort: true },
});
