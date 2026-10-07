import type { ChangesSnapshot, Project } from "../../shared/types";
import { Icon } from "./ui/Icon";

/** A compact entry to the real workspace, shown only when there is room beside the transcript. */
export function RepositoryOverview({ project, changes, onOpenChanges, onOpenFolder }: {
  project: Project; changes: ChangesSnapshot | null; onOpenChanges: () => void; onOpenFolder: () => void;
}) {
  const additions = changes?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions = changes?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  return <aside className="repository-overview" data-testid="repository-overview" aria-label="Repository overview">
    <div className="repository-overview-title" title={project.path}>{project.name}</div>
    <button className="repository-overview-row" onClick={onOpenChanges}>
      <Icon name="review" size={16} /><span>Changes</span><span className="spacer" />
      {changes ? <span className="repository-overview-counts"><span className="additions">+{additions}</span><span className="deletions">−{deletions}</span></span> : <span className="repository-overview-muted">Loading…</span>}
    </button>
    <div className="repository-overview-rule" />
    <div className="repository-overview-title">Workspace</div>
    <button className="repository-overview-row" onClick={onOpenFolder}><Icon name="folder" size={16} /><span>Open folder</span></button>
    {changes?.branch && <div className="repository-overview-row repository-overview-muted" title={changes.branch}><Icon name="branch" size={16} /><span>{changes.branch}</span></div>}
  </aside>;
}
