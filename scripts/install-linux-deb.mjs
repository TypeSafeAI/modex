import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** CI-only: resolve a verified Debian artifact through bounded signed Noble sources. */
export function installLinuxDeb(deb) {
  execFileSync("bash", [fileURLToPath(new URL("./prepare-linux-installed-host.sh", import.meta.url)), "noble", "--install-deb", deb], { timeout: 180000, stdio: "inherit" });
}
