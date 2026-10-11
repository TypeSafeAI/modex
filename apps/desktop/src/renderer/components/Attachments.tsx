import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import type { Attachment } from "../../shared/attachments";
import { attachmentUrl, formatBytes } from "../../shared/attachments";
import { Icon } from "./ui/Icon";

/**
 * Attached files as chips: a thumbnail for images, a glyph for anything else, the name and size.
 * In the composer each chip has a remove button; in the transcript a click reveals the file in its folder.
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
            ? <AttachmentThumbnail attachment={a} />
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


function AttachmentThumbnail({ attachment }: { attachment: Attachment }) {
  const [source, setSource] = useState<{ rel: string; url: string } | null>(null);
  useEffect(() => {
    if (!bridge.attachmentThumbnail) return;
    const controller = new AbortController();
    let url: string | undefined;
    void bridge.attachmentThumbnail(attachment.rel, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setSource({ rel: attachment.rel, url });
    }).catch(() => { /* A missing/retired image leaves the named chip usable. */ });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [attachment.rel]);
  const src = bridge.attachmentThumbnail ? source?.rel === attachment.rel ? source.url : undefined : attachmentUrl(attachment);
  return <img className="attachment-thumb" src={src} alt="" data-testid="attachment-thumb" />;
}
