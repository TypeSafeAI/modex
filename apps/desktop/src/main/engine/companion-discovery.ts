import { spawn } from "node:child_process";

export interface CompanionAdvertisement { host: string; port: number; fingerprint: string }
export type CompanionPublisher = (service: CompanionAdvertisement) => () => void;

/** Advertise only an address and public certificate identity, never the pairing secret. */
export const publishCompanion: CompanionPublisher = ({ host, port, fingerprint }) => {
  if (process.platform !== "darwin" || host === "127.0.0.1") return () => {};
  const child = spawn("/usr/bin/dns-sd", ["-R", `Modex-${fingerprint.slice(0, 16)}`, "_modex._tcp", "local.", String(port),
    `fingerprint=${fingerprint}`, `url=https://${host}:${port}`], { stdio: "ignore" });
  // A Mac without Bonjour can still pair directly using its QR code or copied link.
  child.on("error", () => {});
  return () => { child.kill(); };
};
