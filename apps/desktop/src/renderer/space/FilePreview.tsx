import { useEffect, useRef, useState } from "react";
import type { NotesFile } from "../../shared/notes";
import { bridge } from "../bridge";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";

/**
 * A file from the notes folder: images over `modex-notes://file/<id>`, text read through main, and
 * for anything else a way to open it in its own app.
 */
export function FilePreview({ file, onOpen, onReveal, onClose }: { file: NotesFile; onOpen: () => void; onReveal: () => void; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
    if (file.preview !== "text") return;
    let alive = true;
    void bridge.invoke("notes:file:read", { id: file.id }).then(value => { if (alive) setText(value); }, err => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [file.id, file.preview]);
  return <div className="modal-backdrop" onClick={onClose}>
    <div ref={dialog} tabIndex={-1} className="modal notes-file-preview" role="dialog" aria-modal="true" aria-label={file.name} data-testid="notes-file-preview"
      onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
      <header className="notes-file-head">
        <Icon name="file" size={16} /><strong>{file.name}</strong><span className="notes-file-size">{size(file.size)}</span>
        <span className="spacer" />
        <button className="btn small" onClick={onOpen}><Icon name="expand" size={14} />Open</button>
        <button className="btn small" onClick={onReveal}><Icon name="folder-open" size={14} />Reveal in Finder</button>
        <IconButton icon="close" label="Close preview" size="md" onClick={onClose} />
      </header>
      <div className="notes-file-body">
        {file.preview === "image" && <img src={`modex-notes://file/${encodeURIComponent(file.id)}`} alt={file.name} />}
        {file.preview === "text" && (error ? <p role="alert">{error}</p> : text === null ? <p role="status">Loading…</p> : <pre>{text}</pre>)}
        {file.preview === null && <p className="notes-file-none">No preview for this kind of file. Open it in its own app.</p>}
      </div>
    </div>
  </div>;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
