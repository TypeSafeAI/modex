import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import { Icon } from "./ui/Icon";

/**
 * Create project: a name and the folder it works in. A Modex project is one folder on this computer, so there
 * is one source folder and no remote choice. Nothing is added until "Create project".
 */
export function CreateProjectDialog({ onCreate, onClose }: { onCreate(folder: string, name: string): Promise<void>; onClose(): void }) {
  const web = bridge.platform === "web";
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);
  const base = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
  const pick = async () => {
    setError(null);
    try { const path = await bridge.invoke("project:pick-folder", undefined); if (path) setFolder(path); }
    catch (failure) { setError((failure as Error).message); }
  };
  const create = async () => {
    if (!folder || busy) return;
    setBusy(true); setError(null);
    try { await onCreate(folder, name.trim()); onClose(); }
    catch (failure) { setError((failure as Error).message); setBusy(false); }
  };
  return (
    <div className="cp-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="cp-title" data-testid="create-project" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <button type="button" className="cp-close" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        <h2 id="cp-title">Create project</h2>
        <label className="cp-name"><span aria-hidden="true"><Icon name="folder" size={18} /></span>
          <input ref={nameRef} data-testid="create-project-name" aria-label="Project name" placeholder={folder ? base(folder) : "Project name"} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="cp-sources-head"><strong>Source folders</strong>{folder && <span><Icon name="laptop" size={16} />This computer</span>}</div>
        <div className="cp-sources">
          {folder ? (
            <div className="cp-folder" title={folder} data-testid="create-project-folder"><Icon name="folder" size={18} /><span>{base(folder)}</span><button type="button" aria-label={`Remove ${base(folder)}`} onClick={() => setFolder("")}><Icon name="close" size={15} /></button></div>
          ) : (
            <div className="cp-empty">
              <p><span>Add a folder on</span> this computer</p>
              {web ? (
                <span className="cp-path"><input data-testid="create-project-path" aria-label="Folder path" placeholder="/absolute/path/to/folder" value={typed} onChange={(event) => setTyped(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && typed.trim()) { event.preventDefault(); setFolder(typed.trim()); } }} />
                  <button type="button" className="cp-add" disabled={!typed.trim()} onClick={() => setFolder(typed.trim())}><Icon name="folder" size={15} />Add</button></span>
              ) : <button type="button" className="cp-add" data-testid="create-project-add" onClick={() => void pick()}><Icon name="folder" size={15} />Add</button>}
            </div>
          )}
        </div>
        {error && <p className="cp-error" role="alert">{error}</p>}
        <div className="cp-actions">
          <button type="button" className="cp-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="cp-create" data-testid="create-project-submit" disabled={!folder || busy}>Create project</button>
        </div>
      </form>
    </div>
  );
}
