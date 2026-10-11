import type { ModexAccountStatus } from "../../../desktop/src/shared/types.js";

const detail = "Manage your Modex account in the full desktop app.";
const unavailable = () => { throw new Error(detail); };
/** Store identity is unavailable locally; these commands never reach host auth. */
export const storeAccountCommands = {
  "modexAccount:status": (): ModexAccountStatus => ({ available: false, environment: "production", signingIn: false, user: null, expiresAt: null, detail }),
  "modexAccount:signIn": unavailable,
  "modexAccount:refresh": unavailable,
  "modexAccount:cancel": () => {},
  "modexAccount:signOut": unavailable,
};
