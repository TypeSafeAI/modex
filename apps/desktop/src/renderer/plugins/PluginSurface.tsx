import { useState } from "react";
import { PluginsView } from "./PluginsView";
import type {
  NativePlugin,
  PluginContext,
  PluginDetail,
} from "../../shared/plugins";
import type { Project } from "../../shared/types";
import { bridge } from "../bridge";
import { SecretInput, SecretOption, useRedact } from "../streamer";
import { ErrorNotice } from "../components/ui/ErrorNotice";
export function PluginSurface({
  projects,
  onImages,
}: {
  projects: Project[];
  onImages(): void;
}) {
  const redact = useRedact();
  const [binding, setBinding] = useState<{
    plugin: NativePlugin;
    context: PluginContext;
    details: PluginDetail;
  }>();
  const [entry, setEntry] = useState("");
  const [edit, setEdit] = useState(false);
  const [error, setError] = useState("");
  // The binding behind `error`, for its Retry. A skill in the wrong scope has none: it fails the same way again.
  const [failedChoice, setFailedChoice] = useState<{ message: string; plugin: NativePlugin; context: PluginContext } | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = async (plugin: NativePlugin, context: PluginContext) => {
    setError("");
    setFailedChoice(null);
    try {
      if (context.scope !== "user")
        throw new Error(
          "Image jobs use an isolated workspace. Install this skill in user scope before binding it for Images.",
        );
      const details = await bridge.invoke("plugins:details", {
        context,
        id: plugin.id,
      });
      setEntry(details.skills[0]?.entrypoint ?? "");
      setEdit(false);
      setBinding({ plugin, context, details });
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      if (context.scope === "user") setFailedChoice({ message, plugin, context });
    }
  };
  return (
    <section className="plugin-surface">
      <PluginsView
        projects={projects}
        onUseForImages={(plugin, context) => void choose(plugin, context)}
      />
      {error && (
        <ErrorNotice
          className="plugin-binding"
          testId="plugin-binding-error"
          where="Plugins · use for Images"
          message={error}
          onRetry={failedChoice?.message === error ? () => void choose(failedChoice.plugin, failedChoice.context) : undefined}
          onDismiss={() => setError("")}
        />
      )}
      {binding && (
        <section className="plugin-binding" aria-label="Configure image skill">
          <h2>Use {redact(binding.plugin.name)} for Images</h2>
          <p>
            Choose the native skill that generates images. The first successful
            run verifies this binding; installation alone does not verify
            provider access.
          </p>
          {binding.details.skills.length > 0 ? (
            <select
              aria-label="Image skill entrypoint"
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
            >
              {binding.details.skills.map((skill) => (
                <SecretOption key={skill.entrypoint} value={skill.entrypoint}>
                  {skill.entrypoint}
                </SecretOption>
              ))}
            </select>
          ) : (
            <SecretInput
              aria-label="Image skill entrypoint"
              placeholder="plugin:skill"
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
            />
          )}
          <label>
            <input
              type="checkbox"
              checked={edit}
              onChange={(e) => setEdit(e.target.checked)}
            />
            This skill accepts reference images and edits
          </label>
          <div className="images-actions">
            <button
              className="btn"
              disabled={busy || !entry.trim()}
              onClick={() => {
                setBusy(true);
                void bridge
                  .invoke("images:bind", {
                    runtime: binding.context.runtime,
                    account: "cli",
                    pluginId: binding.plugin.id,
                    pluginVersion: binding.plugin.version ?? "",
                    entrypoint: entry,
                    label: binding.plugin.name,
                    edit,
                  })
                  .then(
                    () => {
                      setBinding(undefined);
                      onImages();
                    },
                    (err) => setError(err.message),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Save image skill
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => setBinding(undefined)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
