import { defineConfig } from "vite";
import release from "./release.json" with { type: "json" };
import releaseHandler from "../../api/release.js";

if (!/^\d+\.\d+\.\d+$/.test(release.version))
  throw new Error("Invalid published release version");
const download = `https://github.com/TypeSafeAI/modex/releases/download/v${release.version}/Modex-${release.version}-arm64.dmg`;
if (!/^https:\/\/testflight\.apple\.com\/join\/[a-zA-Z0-9]+$/.test(release.testflightUrl))
  throw new Error("Invalid public TestFlight invitation");
export default defineConfig({
  plugins: [
    {
      name: "published-release-links",
      transformIndexHtml: (html) =>
        html
          .replaceAll("__MODEX_VERSION__", release.version)
          .replaceAll("__MODEX_DOWNLOAD__", download)
          .replaceAll("__MODEX_TESTFLIGHT__", release.testflightUrl),
    },
    {
      name: "local-release-feed",
      configureServer(server) { server.middlewares.use("/api/release", releaseHandler); },
      configurePreviewServer(server) { server.middlewares.use("/api/release", releaseHandler); },
    },
  ],
  build: { target: "es2022" },
});
