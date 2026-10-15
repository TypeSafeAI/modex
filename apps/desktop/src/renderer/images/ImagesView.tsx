import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImageAsset,
  ImageCapability,
  ImageDraft,
  ImageJob,
  ImageQuery,
} from "../../shared/images";
import { IMAGE_LIMITS, imageUrl } from "../../shared/images";
import type { Project, ThreadItem } from "../../shared/types";
import type { SpacePage } from "../../shared/space";
import { formatBytes, type StagedFile } from "../../shared/attachments";
import { bridge } from "../bridge";
import {
  SecretInput,
  SecretOption,
  SecretTextarea,
  useRedact,
} from "../streamer";
import { restartDrafts } from "../restart-drafts";
import { Icon } from "../components/ui/Icon";
import "./images.css";
const blank: ImageDraft = { prompt: "", capabilityId: "", referenceIds: [] };
const activeJob = (job: ImageJob) =>
  ["queued", "running", "waiting-for-approval"].includes(job.status);
export function ImagesView({
  active,
  projects,
  onPlugins,
  onUseInChat,
  onOpenPage,
}: {
  active: boolean;
  projects: Project[];
  onPlugins(): void;
  onUseInChat(id: string): Promise<void>;
  onOpenPage(id: string): void;
}) {
  const redact = useRedact();
  const [query, setQuery] = useState<ImageQuery>({ view: "all" });
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [selected, setSelected] = useState<ImageAsset | null>(null);
  const [zoom, setZoom] = useState(false);
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<ImageCapability[]>([]);
  const [jobs, setJobs] = useState<ImageJob[]>([]);
  const [draft, setDraft] = useState<ImageDraft>(blank);
  const [references, setReferences] = useState<ImageAsset[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [studio, setStudio] = useState(false);
  const [pages, setPages] = useState<SpacePage[]>([]);
  const [pageId, setPageId] = useState("");
  const [jobId, setJobId] = useState<string>();
  const [transcript, setTranscript] = useState<ThreadItem[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const save = useRef<Promise<unknown>>(Promise.resolve());
  const persistedDraft = useRef(JSON.stringify(blank));
  const savePending = useRef(0);
  const readyRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const busyRef = useRef(false);
  const queryEpoch = useRef(0);
  const loaded = useRef(false);
  const selectedId = useRef<string | undefined>(undefined);
  selectedId.current = selected?.id;
  const refresh = useCallback(async () => {
    const epoch = ++queryEpoch.current;
    try {
      const [list, capabilities, history] = await Promise.all([
        bridge.invoke("images:list", query),
        bridge.invoke("images:capabilities", undefined),
        bridge.invoke("imageJobs:list", undefined),
      ]);
      if (epoch !== queryEpoch.current) return;
      setAssets(list.assets);
      setTotal(list.total);
      setNext(list.nextOffset);
      setCaps(capabilities);
      setJobs(history);
      if (selectedId.current) {
        try {
          setSelected(
            await bridge.invoke("images:get", { id: selectedId.current }),
          );
        } catch {
          setSelected(null);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (epoch === queryEpoch.current) setLoading(false);
    }
  }, [query]);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void bridge.invoke("images:draft", undefined).then(
      (value) => {
        persistedDraft.current = JSON.stringify(value);
        draftRef.current = value;
        readyRef.current = true;
        setDraft(value);
        setReady(true);
      },
      (err) => setError(err.message),
    );
  }, []);
  const persistDraft = useCallback(() => {
    const value = draftRef.current;
    const revision = JSON.stringify(value);
    savePending.current++;
    const pending = save.current.catch(() => {}).then(async () => {
      await bridge.invoke("images:saveDraft", value);
      persistedDraft.current = revision;
    });
    save.current = pending;
    void pending.then(
      () => { savePending.current--; },
      (err) => { savePending.current--; setError(err.message); },
    );
    return pending;
  }, []);
  useEffect(() => {
    if (ready) void persistDraft();
  }, [draft, ready, persistDraft]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (!readyRef.current || (!savePending.current && persistedDraft.current === JSON.stringify(draftRef.current))) return;
      event.preventDefault();
      event.returnValue = "";
      // A failed save remains dirty. Retry on close without stacking retries
      // behind an already queued save of the latest editor contents.
      if (!savePending.current) void persistDraft().catch(() => {});
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [persistDraft]);
  useEffect(
    () => restartDrafts.register("image-drafts", async () => {
      if (busyRef.current) throw new Error("Wait for the image action to finish.");
      await persistDraft();
    }),
    [persistDraft],
  );
  useEffect(() => {
    let live = true;
    void Promise.all(
      draft.referenceIds.map((id) => bridge.invoke("images:get", { id })),
    ).then(
      (result) => {
        if (live) setReferences(result);
      },
      (err) => {
        if (live) setError(err.message);
      },
    );
    return () => {
      live = false;
    };
  }, [draft.referenceIds]);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
        if (jobId)
          void bridge
            .invoke("imageJobs:items", { id: jobId })
            .then(setTranscript)
            .catch((err) => setError(err.message));
      }, 100);
    };
    const off = bridge.onMediaEvent?.(schedule);
    const offThread = bridge.onEvent(() => {
      if (jobId) schedule();
    });
    window.addEventListener("focus", schedule);
    return () => {
      off?.();
      offThread();
      window.removeEventListener("focus", schedule);
      if (timer) clearTimeout(timer);
    };
  }, [active, refresh, jobId]);
  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setZoom(false);
    setDeleteConfirm(false);
    void bridge
      .invoke("space:list", undefined)
      .then((p) => setPages(p.filter((v) => !v.trashedAt)))
      .catch((err) => setError(err.message));
  }, [selected?.id]);
  const run = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    restartDrafts.assertOpen();
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const updateDraft = (patch: Partial<ImageDraft>) => {
    restartDrafts.assertOpen();
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft(draftRef.current);
  };
  const addReference = (asset: ImageAsset) => {
    if (draft.referenceIds.includes(asset.id)) return;
    if (draft.referenceIds.length >= 20) {
      setError("Use at most 20 reference images.");
      return;
    }
    updateDraft({ referenceIds: [...draft.referenceIds, asset.id] });
    setStudio(true);
  };
  const accept = (result: { assets: ImageAsset[]; errors: string[] }) => {
    if (result.errors.length) setError(result.errors.join("\n"));
    if (result.assets.length)
      setNotice(
        `Imported ${result.assets.length} image${result.assets.length === 1 ? "" : "s"}.`,
      );
  };
  const importFiles = (files: File[]) =>
    run(async () => {
      const staged: StagedFile[] = [];
      const errors: string[] = [];
      for (const file of files.slice(0, IMAGE_LIMITS.batch)) {
        try {
          if (file.size > IMAGE_LIMITS.bytes) throw new Error("exceeds 25 MiB");
          const local = bridge.pathForFile?.(file);
          if (local) staged.push({ name: file.name, path: local });
          else {
            const bytes = new Uint8Array(await file.arrayBuffer());
            let raw = "";
            for (let i = 0; i < bytes.length; i += 32768)
              raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
            staged.push({ name: file.name, data: btoa(raw) });
          }
        } catch (err) {
          errors.push(`${file.name}: ${(err as Error).message}`);
        }
      }
      const result = await bridge.invoke("images:import", {
        files: staged,
        projectId: query.projectId,
      });
      accept({
        ...result,
        errors: [
          ...errors,
          ...result.errors,
          ...(files.length > IMAGE_LIMITS.batch
            ? ["Imported the first 20 files; add the rest in another batch."]
            : []),
        ],
      });
      if (studio && result.assets.length)
        updateDraft({
          referenceIds: [
            ...new Set([
              ...draftRef.current.referenceIds,
              ...result.assets.map((a) => a.id),
            ]),
          ].slice(0, 20),
        });
    });
  const openAsset = (asset: ImageAsset) => {
    setSelected(asset);
  };
  const submit = () =>
    run(async () => {
      await save.current;
      const job = await bridge.invoke("imageJobs:submit", {
        ...draft,
        requestId: crypto.randomUUID(),
      });
      setJobId(job.id);
      setNotice("Image job queued. You can keep working while it runs.");
    });
  const chosen = caps.find((c) => c.id === draft.capabilityId);
  return (
    <section
      className="images-surface"
      hidden={!active}
      aria-label="Images"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          void importFiles(Array.from(event.dataTransfer.files));
        }
      }}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length) {
          event.preventDefault();
          void importFiles(files);
        }
      }}
    >
      <header className="images-header">
        <div>
          <h1>Images</h1>
          <p>Your ideas, made visible. Saved on this Mac.</p>
        </div>
        <div className="images-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await bridge.invoke("images:pick", {
                  projectId: query.projectId,
                });
                accept(result);
                if (studio && result.assets.length)
                  updateDraft({
                    referenceIds: [
                      ...new Set([
                        ...draftRef.current.referenceIds,
                        ...result.assets.map((a) => a.id),
                      ]),
                    ].slice(0, 20),
                  });
              })
            }
          >
            <Icon name="plus" />
            Import
          </button>
          <button
            className="btn"
            onClick={() => {
              setStudio((v) => !v);
              requestAnimationFrame(() => prompt.current?.focus());
            }}
            aria-expanded={studio}
          >
            <Icon name="sparkle" />
            Generate
          </button>
        </div>
      </header>
      <input
        ref={upload}
        hidden
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label="Import image files"
        onChange={(event) => {
          void importFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <div className="images-toolbar">
        <nav aria-label="Image views">
          {(
            ["all", "generated", "imported", "favorites", "trash"] as const
          ).map((view) => (
            <button
              key={view}
              className={query.view === view ? "active" : ""}
              aria-pressed={query.view === view}
              onClick={() => setQuery((q) => ({ ...q, view, offset: 0 }))}
            >
              {view[0]!.toUpperCase() + view.slice(1)}
            </button>
          ))}
        </nav>
        <SecretInput
          aria-label="Search images"
          type="search"
          placeholder="Search images"
          value={query.query ?? ""}
          onChange={(e) =>
            setQuery((q) => ({ ...q, query: e.target.value, offset: 0 }))
          }
        />
        <select
          aria-label="Filter images by project"
          value={query.projectId ?? ""}
          onChange={(e) =>
            setQuery((q) => ({
              ...q,
              projectId: e.target.value || undefined,
              offset: 0,
            }))
          }
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <SecretOption key={p.id} value={p.id}>
              {p.name}
            </SecretOption>
          ))}
        </select>
        <select
          aria-label="Sort images"
          value={query.sort ?? "newest"}
          onChange={(e) =>
            setQuery((q) => ({
              ...q,
              sort: e.target.value as "newest" | "name",
              offset: 0,
            }))
          }
        >
          <option value="newest">Newest first</option>
          <option value="name">Name</option>
        </select>
      </div>
      {error && (
        <div role="alert" className="images-error">
          {redact(error)}
          <button className="btn" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {notice && <p role="status">{redact(notice)}</p>}
      {studio && (
        <section className="image-studio" aria-label="Image generation">
          <div>
            <h2>Make something new</h2>
            <p>
              Choose an installed image skill. Provider usage may incur charges.
            </p>
          </div>
          {!caps.length ? (
            <p>
              No image skills configured.{" "}
              <button className="btn" onClick={onPlugins}>
                Choose a plugin
              </button>
            </p>
          ) : (
            <>
              <div className="images-actions">
                <select
                  aria-label="Image skill"
                  value={draft.capabilityId}
                  onChange={(e) =>
                    updateDraft({ capabilityId: e.target.value })
                  }
                >
                  <option value="">Choose an image skill</option>
                  {caps.map((cap) => (
                    <SecretOption
                      key={cap.id}
                      value={cap.id}
                    >{`${cap.label} · ${cap.runtime}${cap.verifiedVersion === cap.pluginVersion ? "" : " · unverified"}`}</SecretOption>
                  ))}
                </select>
                <select
                  aria-label="Generation project"
                  value={draft.projectId ?? ""}
                  onChange={(e) =>
                    updateDraft({ projectId: e.target.value || undefined })
                  }
                >
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <SecretOption key={p.id} value={p.id}>
                      {p.name}
                    </SecretOption>
                  ))}
                </select>
                <button className="btn" onClick={onPlugins}>
                  Manage plugins
                </button>
              </div>
              <SecretTextarea
                ref={prompt}
                aria-label="Image prompt"
                placeholder="Describe the image you want to make…"
                value={draft.prompt}
                maxLength={16000}
                onChange={(e) => updateDraft({ prompt: e.target.value })}
              />
              <div className="image-references">
                {references.map((asset) => (
                  <span key={asset.id}>
                    <img src={imageUrl(asset.id, true)} alt="" />
                    {redact(asset.name)}
                    <button
                      className="btn"
                      aria-label={`Remove reference ${redact(asset.name)}`}
                      onClick={() =>
                        updateDraft({
                          referenceIds: draft.referenceIds.filter(
                            (id) => id !== asset.id,
                          ),
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <p className="hint">
                Choose a library image, or import, drop or paste references
                while this composer is open.
              </p>
              <button
                className="btn"
                disabled={
                  busy ||
                  !ready ||
                  !chosen ||
                  !draft.prompt.trim() ||
                  Boolean(draft.referenceIds.length && !chosen.edit)
                }
                onClick={() => void submit()}
              >
                {draft.referenceIds.length
                  ? "Generate revision"
                  : "Generate image"}
              </button>
              {draft.referenceIds.length && !chosen?.edit && (
                <p role="status">
                  Choose a skill configured for references and edits.
                </p>
              )}
            </>
          )}
        </section>
      )}
      <div className="images-body">
        <div className="images-library">
          {loading ? (
            <p role="status">Loading images…</p>
          ) : !assets.length ? (
            <div className="images-empty">
              <Icon name="image" size={42} />
              <h2>
                {query.query
                  ? "No matching images"
                  : query.view === "trash"
                    ? "Trash is empty"
                    : "A home for your images"}
              </h2>
              <p>
                Import files, drop an image, or generate with an installed
                plugin.
              </p>
              <button className="btn" onClick={() => upload.current?.click()}>
                Choose images
              </button>
            </div>
          ) : (
            <>
              <p className="hint">
                {total} image{total === 1 ? "" : "s"}
              </p>
              <div className="images-grid">
                {assets.map((asset) => (
                  <button
                    key={asset.id}
                    data-image-id={asset.id}
                    className={`image-card${selected?.id === asset.id ? " selected" : ""}`}
                    onClick={() => openAsset(asset)}
                    aria-label={`Open ${redact(asset.name)}`}
                  >
                    <div>
                      <img
                        loading="lazy"
                        decoding="async"
                        src={imageUrl(asset.id, true)}
                        alt=""
                      />
                    </div>
                    <strong>{redact(asset.name)}</strong>
                    <span>
                      {asset.width} × {asset.height}
                      {asset.favorite ? " · ★" : ""}
                    </span>
                  </button>
                ))}
              </div>
              {next !== null && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    const epoch = queryEpoch.current;
                    void bridge
                      .invoke("images:list", { ...query, offset: next })
                      .then(
                        (result) => {
                          if (epoch !== queryEpoch.current) return;
                          setAssets((current) => [
                            ...current.filter(
                              (a) => !result.assets.some((b) => b.id === a.id),
                            ),
                            ...result.assets,
                          ]);
                          setNext(result.nextOffset);
                        },
                        (err) => setError(err.message),
                      );
                  }}
                >
                  Load more
                </button>
              )}
            </>
          )}
          <details
            className="image-linked-pages"
            onToggle={(event) => {
              if (event.currentTarget.open)
                void bridge
                  .invoke("space:list", undefined)
                  .then(setPages)
                  .catch((err) => setError(err.message));
            }}
          >
            <summary>Pages with images</summary>
            {pages
              .filter(
                (p) =>
                  !p.trashedAt &&
                  /!\[[^\]]*\]\((https?:\/\/|modex-image:)/i.test(p.markdown),
              )
              .map((p) => (
                <button
                  className="btn"
                  key={p.id}
                  onClick={() => onOpenPage(p.id)}
                >
                  {redact(p.title || "Untitled page")}
                </button>
              ))}
          </details>
        </div>
        {selected && (
          <aside className="image-detail" aria-label="Image details">
            <button
              className="btn"
              onClick={() => {
                const id = selected.id;
                setSelected(null);
                setDeleteConfirm(false);
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLButtonElement>(`[data-image-id="${id}"]`)
                    ?.focus(),
                );
              }}
            >
              Close details
            </button>
            <button
              className={`image-preview${zoom ? " zoom" : ""}`}
              onClick={() => setZoom((v) => !v)}
              aria-label={zoom ? "Fit image" : "Zoom image"}
            >
              <img src={imageUrl(selected.id)} alt={redact(selected.name)} />
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () =>
                  setSelected(
                    await bridge.invoke("images:update", {
                      id: selected.id,
                      name,
                    }),
                  ),
                );
              }}
            >
              <SecretInput
                aria-label="Image name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
              <button className="btn" disabled={busy || !name.trim()}>
                Rename
              </button>
            </form>
            <p>
              {selected.width} × {selected.height} ·{" "}
              {formatBytes(selected.size)} · {selected.source}
            </p>
            <select
              aria-label="Image project"
              value={selected.projectId ?? ""}
              onChange={(e) =>
                void run(async () =>
                  setSelected(
                    await bridge.invoke("images:update", {
                      id: selected.id,
                      projectId: e.target.value || null,
                    }),
                  ),
                )
              }
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <SecretOption key={p.id} value={p.id}>
                  {p.name}
                </SecretOption>
              ))}
            </select>
            {selected.prompt && (
              <p className="image-prompt">{redact(selected.prompt)}</p>
            )}
            {selected.parentIds.length > 0 && (
              <div>
                Based on{" "}
                {selected.parentIds.map((id) => (
                  <button
                    className="btn"
                    key={id}
                    onClick={() =>
                      void run(async () =>
                        openAsset(await bridge.invoke("images:get", { id })),
                      )
                    }
                  >
                    Source image
                  </button>
                ))}
              </div>
            )}
            <div className="images-actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setSelected(
                      await bridge.invoke("images:update", {
                        id: selected.id,
                        favorite: !selected.favorite,
                      }),
                    ),
                  )
                }
              >
                {selected.favorite ? "Unfavorite" : "Favorite"}
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    bridge.invoke("images:export", { id: selected.id }),
                  )
                }
              >
                Export
              </button>
              <button
                className="btn"
                onClick={() =>
                  void run(() =>
                    bridge.invoke("images:reveal", { id: selected.id }),
                  )
                }
              >
                Reveal
              </button>
            </div>
            {!selected.trashedAt && (
              <>
                <div className="images-actions">
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void run(() => onUseInChat(selected.id))}
                  >
                    Use in chat
                  </button>
                  <button
                    className="btn"
                    onClick={() => addReference(selected)}
                  >
                    Use as reference
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      updateDraft({ referenceIds: [selected.id], prompt: "" });
                      setStudio(true);
                      requestAnimationFrame(() => prompt.current?.focus());
                    }}
                  >
                    Edit with a prompt
                  </button>
                </div>
                <div className="images-actions">
                  <select
                    aria-label="Insert image into page"
                    value={pageId}
                    onChange={(e) => setPageId(e.target.value)}
                  >
                    <option value="">Choose a Space page</option>
                    {pages
                      .filter((p) => !p.trashedAt)
                      .map((p) => (
                        <SecretOption key={p.id} value={p.id}>
                          {p.title || "Untitled page"}
                        </SecretOption>
                      ))}
                  </select>
                  <button
                    className="btn"
                    disabled={busy || !pageId}
                    onClick={() =>
                      void run(async () => {
                        const page = pages.find((p) => p.id === pageId);
                        if (!page) throw new Error("Choose a page.");
                        await bridge.invoke("images:insert", {
                          id: selected.id,
                          pageId,
                          revision: page.revision,
                        });
                        setPages(await bridge.invoke("space:list", undefined));
                        setNotice("Image inserted into Space.");
                      })
                    }
                  >
                    Insert
                  </button>
                </div>
              </>
            )}
            <div className="images-actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setSelected(
                      await bridge.invoke("images:update", {
                        id: selected.id,
                        trash: !selected.trashedAt,
                      }),
                    ),
                  )
                }
              >
                {selected.trashedAt ? "Restore" : "Move to Trash"}
              </button>
              {selected.trashedAt && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => setDeleteConfirm(true)}
                >
                  Delete permanently…
                </button>
              )}
            </div>
            {deleteConfirm && (
              <div role="group" aria-label="Confirm permanent deletion">
                <p>
                  Permanently delete this library copy? This cannot be undone.
                  Referenced images are protected.
                </p>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await bridge.invoke("images:delete", { id: selected.id });
                      setSelected(null);
                    })
                  }
                >
                  Delete image
                </button>
                <button className="btn" onClick={() => setDeleteConfirm(false)}>
                  Keep image
                </button>
              </div>
            )}
          </aside>
        )}
      </div>
      <section className="image-jobs" aria-label="Image jobs">
        <h2>Generation history</h2>
        {!jobs.length ? (
          <p className="hint">Your image jobs will appear here.</p>
        ) : (
          jobs.map((job) => (
            <article key={job.id}>
              <div>
                <strong>{redact(job.prompt)}</strong>
                <span role="status">{job.status.replaceAll("-", " ")}</span>
                <span>{job.outputIds.length} saved</span>
              </div>
              {job.error && <p>{redact(job.error)}</p>}
              <div className="images-actions">
                {activeJob(job) ? (
                  <button
                    className="btn"
                    onClick={() =>
                      void run(() =>
                        bridge.invoke("imageJobs:cancel", { id: job.id }),
                      )
                    }
                  >
                    Cancel job
                  </button>
                ) : (
                  <button
                    className="btn"
                    onClick={() =>
                      void run(() =>
                        bridge.invoke("imageJobs:retry", {
                          id: job.id,
                          requestId: crypto.randomUUID(),
                        }),
                      )
                    }
                  >
                    Retry as new job
                  </button>
                )}
                <button
                  className="btn"
                  onClick={() =>
                    void run(async () => {
                      setJobId(job.id);
                      setTranscript(
                        await bridge.invoke("imageJobs:items", { id: job.id }),
                      );
                    })
                  }
                >
                  Execution details
                </button>
                {job.outputIds.map((id) => (
                  <button
                    className="btn"
                    key={id}
                    onClick={() =>
                      void run(async () =>
                        setSelected(await bridge.invoke("images:get", { id })),
                      )
                    }
                  >
                    View result
                  </button>
                ))}
              </div>
              {jobId === job.id && (
                <div
                  className="image-transcript"
                  aria-label="Image execution transcript"
                >
                  {transcript.map((item) => (
                    <div key={item.id}>
                      {item.kind === "approval" ? (
                        <>
                          <p>{redact(item.question)}</p>
                          {item.detail && <pre>{redact(item.detail)}</pre>}
                          {item.answer && <p>Decision: {item.answer}</p>}
                          {!item.answer && activeJob(job) && (
                            <div className="images-actions">
                              <button
                                className="btn"
                                onClick={() =>
                                  void run(() =>
                                    bridge.invoke("imageJobs:answer", {
                                      id: job.id,
                                      itemId: item.id,
                                      answer: "yes",
                                    }),
                                  )
                                }
                              >
                                Approve
                              </button>
                              <button
                                className="btn"
                                onClick={() =>
                                  void run(() =>
                                    bridge.invoke("imageJobs:answer", {
                                      id: job.id,
                                      itemId: item.id,
                                      answer: "no",
                                    }),
                                  )
                                }
                              >
                                Deny
                              </button>
                            </div>
                          )}
                        </>
                      ) : (
                        <pre>
                          {redact(
                            "text" in item
                              ? String(item.text)
                              : "title" in item
                                ? String(item.title)
                                : item.kind,
                          )}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))
        )}
      </section>
    </section>
  );
}
