import { copyFileSync, mkdirSync } from "node:fs";

const output = new URL("../dist/src/main/", import.meta.url);
mkdirSync(output, { recursive: true });
copyFileSync(new URL("../src/main/preload.cjs", import.meta.url), new URL("preload.cjs", output));
