import type { ModexBridge } from "../src/shared/types";
declare global { interface Window { modex?: ModexBridge; } }
export {};
