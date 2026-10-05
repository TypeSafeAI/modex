import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prepareDesktopSystem } from "../../../scripts/prepare-desktop-system.mjs";
prepareDesktopSystem(fileURLToPath(new URL("../dist/apps/desktop/src/main/engine/desktop-system", import.meta.url)));
await copyFile(new URL("../src/main/preload.cjs", import.meta.url), new URL("../dist/apps/store-desktop/src/main/preload.cjs", import.meta.url));
