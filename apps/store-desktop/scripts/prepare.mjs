import { copyFile } from "node:fs/promises";
await copyFile(new URL("../src/main/preload.cjs", import.meta.url), new URL("../dist/apps/store-desktop/src/main/preload.cjs", import.meta.url));
