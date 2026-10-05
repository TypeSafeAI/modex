import { cp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL(".vercel/output/", root);
await access(new URL("dist/index.html", root));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL("dist/", root), new URL("static/", output), {
  recursive: true,
});
await writeFile(
  new URL("config.json", output),
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: "/(.*)",
          headers: {
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
          },
          continue: true,
        },
        { handle: "filesystem" },
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(`Prepared static deployment: ${fileURLToPath(output)}`);
