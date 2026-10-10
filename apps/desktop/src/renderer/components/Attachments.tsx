import type { Attachment } from "../../shared/attachments";
import { attachmentUrl, formatBytes } from "../../shared/attachments";
import { Icon } from "./ui/Icon";

/**
 * Attached files as chips: a thumbnail for images, a glyph for anything else, the name and size.
 * In the composer each chip has a remove button; in the transcript a click opens the file.
 */
export function AttachmentChips({ attachments, onRemove, onOpen, testId = "attachments" }: { attachments: Attachment[]; onRemove?: (a: Attachment) => void; onOpen?: (a: Attachment) => void; testId?: string }) {
  if (!attachments.length) return null;
  return (
    <div className="attachments" data-testid={testId}>
      {attachments.map((a) => (
        <span
          key={a.id}
          className={`attachment-chip${onOpen ? " openable" : ""}`}
          data-testid="attachment-chip"
          data-kind={a.kind}
          title={a.name}
          role={onOpen ? "button" : undefined}
          tabIndex={onOpen ? 0 : undefined}
          onClick={onOpen ? () => onOpen(a) : undefined}
          onKeyDown={onOpen ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(a); } } : undefined}
        >
          {a.kind === "image"
            ? <img className="attachment-thumb" src={attachmentUrl(a)} alt="" data-testid="attachment-thumb" />
            : <span className="attachment-glyph"><Icon name="file" size={14} /></span>}
          <span className="attachment-text">
            <span className="attachment-name">{a.name}</span>
            <span className="attachment-size">{formatBytes(a.size)}</span>
          </span>
          {onRemove && (
            <button type="button" className="attachment-remove" data-testid="attachment-remove" aria-label={`Remove ${a.name}`} onClick={(e) => { e.stopPropagation(); onRemove(a); }}>
              <Icon name="close" size={12} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
