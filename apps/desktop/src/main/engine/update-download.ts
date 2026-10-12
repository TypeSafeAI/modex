import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ReleaseArchive } from "./updates.js";

interface DownloadOptions {
  parent: string;
  signal: AbortSignal;
  progress: (received: number) => void;
  fetcher?: typeof fetch;
}

/** Full ZIP download into a private disposable directory. Metadata hashes detect
 * corruption; callers must still authenticate the contained application's publisher.
 */
export async function downloadReleaseArchive(candidate: ReleaseArchive, options: DownloadOptions): Promise<{
  directory: string; file: string; sha512: string; dispose(): Promise<void>;
}> {
  if (candidate.version.length > 50 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate.version)
    || !candidate.version.split(".").every(part => Number.isSafeInteger(Number(part)))
    || !["arm64", "x64"].includes(candidate.arch) || !/^[a-f0-9]{64}$/.test(candidate.sha256)
    || !Number.isSafeInteger(candidate.size) || candidate.size <= 0 || candidate.size > 512 * 1024 * 1024) throw new Error("Invalid update download.");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60 * 1000)]);
  signal.throwIfAborted();
  await fs.mkdir(options.parent, { recursive: true, mode: 0o700 });
  const parent = await fs.lstat(options.parent);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
    || (process.getuid && parent.uid !== process.getuid())) throw new Error("The update cache must be a private directory owned by this account.");
  signal.throwIfAborted();
  const directory = await fs.realpath(await fs.mkdtemp(path.join(options.parent, "download-")));
  const file = path.join(directory, "update.zip");
  const dispose = () => fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.chmod(directory, 0o700);
    const source = `https://github.com/TypeSafeAI/modex/releases/download/v${candidate.version}/Modex-${candidate.version}-${candidate.arch}.zip`;
    let url = new URL(source);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 4; redirects++) {
      signal.throwIfAborted();
      response = await (options.fetcher ?? fetch)(url.href, {
        redirect: "manual", signal, headers: { "User-Agent": "Modex-Update", Accept: "application/octet-stream" },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (!location || location.length > 8192 || redirects === 4) throw new Error("Update download redirect could not be verified.");
      url = new URL(location, url);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
        || !(url.hostname === "release-assets.githubusercontent.com" || (url.origin + url.pathname === source))) {
        throw new Error("Update download redirect left GitHub release delivery.");
      }
    }
    if (!response?.ok || !response.body) {
      await response?.body?.cancel();
      throw new Error("The update could not be downloaded. Try again when the connection is available.");
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel(signal.reason).catch(() => {}); };
    const sha256 = createHash("sha256"), sha512 = createHash("sha512");
    let received = 0;
    try {
      handle = await fs.open(file, "wx", 0o600);
      reader = response.body.getReader();
      signal.addEventListener("abort", cancel, { once: true });
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        received += value.byteLength;
        if (received > candidate.size) throw new Error("The update exceeded its expected size.");
        sha256.update(value); sha512.update(value);
        await handle.writeFile(value);
        options.progress(received);
      }
      if (received !== candidate.size || sha256.digest("hex") !== candidate.sha256) throw new Error("Update download integrity check failed. Download it again.");
      await handle.sync();
      signal.throwIfAborted();
      return { directory, file, sha512: sha512.digest("base64"), dispose };
    } finally {
      signal.removeEventListener("abort", cancel);
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      } else { await response.body.cancel().catch(() => {}); }
      await handle?.close();
    }
  } catch (error) { await dispose(); throw error; }
}
