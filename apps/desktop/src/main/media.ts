import { fixturePlugins } from "./engine/images/fixture.js";
import { atomicJSON, readJSON } from "./engine/images/files.js";
import { dialog, nativeImage, shell } from "electron";
import type { BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BridgeCommands, ThreadEvent, Thread } from "../shared/types.js";
import { IMAGE_SCHEME, type ImageCapability } from "../shared/images.js";
import { LIMITS } from "../shared/attachments.js";
import type { Store } from "./engine/store.js";
import type { ThreadRunner } from "./engine/runner.js";
import { ImageStore } from "./engine/images/store.js";
import { ImageJobs } from "./engine/images/jobs.js";
import { PluginService } from "./engine/plugins.js";
import { resolveCli } from "./engine/cli-path.js";
import { cliEnvironment } from "./engine/backends/health.js";
type Handle = <K extends keyof BridgeCommands>(
  channel: K,
  fn: (
    input: BridgeCommands[K]["req"],
  ) => BridgeCommands[K]["res"] | Promise<BridgeCommands[K]["res"]>,
) => void;
export class Media {
  private changing = false;
  private revisions: Record<string, number>;
  readonly images: ImageStore;
  readonly jobs: ImageJobs;
  readonly plugins: PluginService;
  constructor(
    private readonly o: {
      home: string;
      store: Store;
      runner: () => ThreadRunner;
      window: () => BrowserWindow | null;
      changed(kind: "images" | "jobs" | "plugins"): void;
      pathReady: Promise<unknown>;
      offline: boolean;
    },
  ) {
    this.revisions = readJSON(
      path.join(o.home, "images", "plugin-revisions.json"),
      {},
    );
    this.images = new ImageStore(o.home, {
      thumbnail: (bytes, dimensions) => {
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error("Image could not be decoded.");
        const size = image.getSize();
        if (
          size.width !== dimensions.width ||
          size.height !== dimensions.height
        )
          throw new Error("Image dimensions do not match its contents.");
        const scale = Math.min(1, 480 / size.width, 480 / size.height);
        return image
          .resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: "good",
          })
          .toPNG();
      },
      changed: () => o.changed("images"),
      referenced: (id) =>
        this.jobs?.referenced(id) ||
        o.store.space
          .list()
          .some((p) =>
            [p, ...o.store.space.history(p.id).map((v) => v.page)].some((v) =>
              v.markdown.includes(`${IMAGE_SCHEME}://asset/${id}`),
            ),
          ),
    });
    this.plugins = new PluginService({
      ...(o.offline ? { execute: fixturePlugins() } : {}),
      localRoot: path.join(o.home, "plugin-imports"),
      cacheFile: path.join(o.home, "images", "plugins-cache.json"),
      resolve: async (context) => {
        await o.pathReady;
        if (o.offline) return { bin: "modex-fixture", cwd: o.home, env: {} };
        const project = context.projectId
          ? o.store.project(context.projectId)
          : undefined;
        if (context.projectId && !project)
          throw new Error("Project no longer exists.");
        const bin = resolveCli(
          context.runtime,
          o.store.settings[
            context.runtime === "claude" ? "claude_bin" : "codex_bin"
          ],
        );
        return {
          bin,
          cwd: project?.path ?? os.homedir(),
          env: cliEnvironment(bin),
        };
      },
      beforeMutation: (context) => {
        const next = {
          ...this.revisions,
          [context.runtime]: (this.revisions[context.runtime] ?? 0) + 1,
        };
        atomicJSON(path.join(o.home, "images", "plugin-revisions.json"), next);
        this.revisions = next;
      },
      busy: (context) =>
        this.jobs?.busy() ||
        o.store
          .snapshot()
          .threads.some(
            (t) =>
              t.backend === context.runtime &&
              ["running", "waiting"].includes(o.runner().status(t.id)),
          ),
    });
    this.jobs = new ImageJobs({
      home: o.home,
      images: this.images,
      runner: o.runner,
      projectExists: (id) => !!o.store.project(id),
      changed: () => o.changed("jobs"),
      demo: o.offline,
      validate: (cap) => this.validateCapability(cap),
    });
  }
  async validateCapability(cap: ImageCapability) {
    if (this.changing) throw new Error("Wait for plugin changes to finish.");
    if (this.o.offline && cap.pluginId !== "modex-fixture")
      throw new Error(
        "Only the offline fixture image skill is available in demos/tests.",
      );
    const inventory = await this.plugins.list({
      context: {
        runtime: cap.runtime,
        account: cap.account ?? "cli",
        scope: "user",
      },
    });
    if (inventory.stale)
      throw new Error(
        "Plugin availability could not be verified. Refresh Plugins before generating.",
      );
    const plugin = inventory.plugins.find(
      (p) => p.id === cap.pluginId && p.installed,
    );
    if (!plugin || plugin.enabled === false)
      throw new Error("Image plugin is missing or disabled. Open Plugins.");
    if ((plugin.version ?? "") !== cap.pluginVersion)
      throw new Error(
        "Image plugin version changed. Reconfigure its image skill in Plugins.",
      );
  }
  beforeSend(thread: Thread) {
    if (this.changing)
      throw new Error(
        "Wait for plugin changes to finish before starting a turn.",
      );
    const revision = this.revisions[thread.backend] ?? 0;
    if (thread.sessionHandle && (thread.pluginRevision ?? 0) !== revision)
      throw new Error(
        "Plugins changed since this session started. Start a new chat to load the current plugins.",
      );
    if (!thread.sessionHandle)
      this.o.store.updateThread(thread.id, { pluginRevision: revision });
  }
  private async mutate<T>(
    runtime: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.changing) throw new Error("A plugin change is already running.");
    this.changing = true;
    try {
      return await operation();
    } finally {
      this.changing = false;
      this.o.changed("plugins");
    }
  }
  onEvent(event: ThreadEvent) {
    this.jobs.onThreadEvent(event);
  }
  register(handle: Handle) {
    const project = (id: string | undefined | null) => {
      if (id && !this.o.store.project(id))
        throw new Error("Project no longer exists.");
    };
    handle("features:media", () => ({ images: true, plugins: true }));
    handle("plugins:importLocal", async ({ context }) => {
      const result = await dialog.showOpenDialog(this.o.window()!, {
        title: "Import local plugin or marketplace",
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths[0])
        return { message: "Local import canceled.", restartRequired: false };
      return this.mutate(context.runtime, () =>
        this.plugins.importLocal({ context, source: result.filePaths[0]! }),
      );
    });
    handle("plugins:list", (input) => this.plugins.list(input));
    handle("plugins:details", (input) => this.plugins.details(input));
    handle("plugins:sources", (input) => this.plugins.sources(input));
    handle("plugins:mutate", async (input) => {
      const result = await this.mutate(input.context.runtime, () =>
        this.plugins.mutate(input),
      );
      this.o.changed("plugins");
      return result;
    });
    handle("plugins:source:mutate", async (input) => {
      const result = await this.mutate(input.context.runtime, () =>
        this.plugins.mutateSource(input),
      );
      this.o.changed("plugins");
      return result;
    });
    handle("images:list", (input) => this.images.list(input));
    handle("images:get", ({ id }) => this.images.get(id));
    handle("images:import", ({ files, projectId }) => {
      project(projectId);
      return this.images.import(files, { projectId });
    });
    handle("images:pick", async ({ projectId }) => {
      project(projectId);
      const result = await dialog.showOpenDialog(this.o.window()!, {
        title: "Import images",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        ],
      });
      return result.canceled
        ? { assets: [], errors: [] }
        : this.images.import(
            result.filePaths.map((file) => ({
              name: path.basename(file),
              path: file,
            })),
            { projectId },
          );
    });
    handle("images:update", (input) => {
      project(input.projectId);
      return this.images.update(input);
    });
    handle("images:delete", ({ id }) => this.images.delete(id));
    handle("images:export", async ({ id }) => {
      const asset = this.images.get(id);
      const extension = asset.mime.split("/")[1]!;
      const result = await dialog.showSaveDialog(this.o.window()!, {
        defaultPath: /\.(png|jpe?g|webp|gif)$/i.test(asset.name)
          ? asset.name
          : `${asset.name}.${extension}`,
        filters: [{ name: "Image", extensions: [extension] }],
      });
      if (result.canceled || !result.filePath) return null;
      await fs.promises.writeFile(result.filePath, this.images.bytes(id), {
        mode: 0o600,
      });
      return result.filePath;
    });
    handle("images:reveal", ({ id }) =>
      shell.showItemInFolder(this.images.filePath(id)),
    );
    handle("images:attachment", ({ attachment }) => {
      const file = this.o.runner().attachments.resolve(attachment.rel);
      if (!file) throw new Error("Attachment is missing or changed.");
      const result = this.images.import(
        [{ name: attachment.name, path: file }],
        { source: "attachment" },
      );
      if (!result.assets[0]) throw new Error(result.errors.join("\n"));
      return result.assets[0];
    });
    handle("images:stage", ({ id }) => {
      const asset = this.images.get(id);
      if (asset.trashedAt) throw new Error("Restore this image first.");
      if (asset.size > LIMITS.imageBytes)
        throw new Error(
          "This image exceeds the 5 MiB chat attachment limit. Export a smaller copy first.",
        );
      return {
        name: asset.name,
        mime: asset.mime,
        size: asset.size,
        data: this.images.bytes(id).toString("base64"),
      };
    });
    handle("images:insert", ({ id, pageId, revision }) => {
      const page = this.o.store.space
        .list()
        .find((p) => p.id === pageId && !p.trashedAt);
      if (!page) throw new Error("Page no longer exists.");
      if (page.revision !== revision)
        throw new Error("This page changed. Refresh and try again.");
      if (this.images.get(id).trashedAt)
        throw new Error("Restore this image first.");
      this.o.store.space.save({
        ...page,
        markdown: `${page.markdown}\n\n${this.images.markdown(id)}`,
        revision,
      });
    });
    handle("images:capabilities", () => this.jobs.capabilities());
    handle("images:bind", async (input) => {
      const cap = { ...input, id: "" };
      await this.validateCapability(cap);
      return this.jobs.bind(input);
    });
    handle("images:unbind", ({ id }) => this.jobs.unbind(id));
    handle("images:draft", () => this.jobs.draft());
    handle("images:saveDraft", (input) => this.jobs.saveDraft(input));
    handle("imageJobs:list", () => this.jobs.list());
    handle("imageJobs:submit", (input) => this.jobs.submit(input));
    handle("imageJobs:cancel", ({ id }) => this.jobs.cancel(id));
    handle("imageJobs:retry", ({ id, requestId }) =>
      this.jobs.retry(id, requestId),
    );
    handle("imageJobs:items", ({ id }) => this.jobs.items(id));
    handle("imageJobs:answer", ({ id, itemId, answer }) =>
      this.jobs.answer(id, itemId, answer),
    );
  }
  response(url: string): Response {
    try {
      const u = new URL(url);
      const match = u.pathname.match(/^\/([a-f0-9-]{36})(\/thumbnail)?$/);
      if (
        u.protocol !== `${IMAGE_SCHEME}:` ||
        u.host !== "asset" ||
        !match ||
        u.search ||
        u.hash
      )
        return new Response(null, { status: 404 });
      const asset = this.images.get(match[1]!);
      return new Response(
        new Uint8Array(this.images.bytes(asset.id, !!match[2])),
        {
          headers: {
            "Content-Type": match[2] ? "image/png" : asset.mime,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  async exportMarkdown(markdown: string, destination: string) {
    const ids = [
      ...new Set(
        [
          ...markdown.matchAll(
            /modex-image:\/\/asset\/([a-f0-9-]{36})(?![a-f0-9/-])/g,
          ),
        ].map((m) => m[1]!),
      ),
    ];
    if (!ids.length) return markdown;
    const folder = path.join(
      path.dirname(destination),
      `${path.basename(destination, path.extname(destination))}-assets`,
    );
    if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink())
      throw new Error("Export assets directory cannot be a symlink.");
    fs.mkdirSync(folder, { recursive: true });
    for (const id of ids) {
      const asset = this.images.get(id);
      const name = `${id}.${asset.mime.split("/")[1]}`;
      const target = path.join(folder, name);
      const bytes = this.images.bytes(id);
      try {
        fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          fs.lstatSync(target).isSymbolicLink() ||
          !fs.readFileSync(target).equals(bytes)
        )
          throw error;
      }
      markdown = markdown
        .split(`${IMAGE_SCHEME}://asset/${id}`)
        .join(`./${encodeURIComponent(path.basename(folder))}/${name}`);
    }
    return markdown;
  }
  dispose() {
    return Promise.all([this.jobs.dispose(), this.plugins.dispose()]).then(() => {});
  }
}
