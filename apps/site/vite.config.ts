import { defineConfig } from "vite";
import release from "./release.json" with { type: "json" };

if (!/^\d+\.\d+\.\d+$/.test(release.version))
  throw new Error("Invalid published release version");
const download = `https://github.com/TypeSafeAI/modex/releases/download/v${release.version}/Modex-${release.version}-arm64.dmg`;
export default defineConfig({
  plugins: [
    {
      name: "published-release-links",
      transformIndexHtml: (html) =>
        html
          .replaceAll("__MODEX_VERSION__", release.version)
          .replaceAll("__MODEX_DOWNLOAD__", download),
    },
  ],
  build: { target: "es2022" },
});
