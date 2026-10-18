import { useEffect, useState } from "react";
import { bridge } from "../../bridge";

/**
 * A fenced code block in the transcript: its language, the code, and Copy. Copy puts the code on the
 * clipboard through main and does nothing else; nothing in a reply runs from here.
 */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const name = lang ? `${lang} code` : "code";
  const copy = async () => {
    setFailed(false);
    try { await bridge.invoke("clipboard:write", { text: code }); setCopied(true); }
    catch { setFailed(true); }
  };
  return (
    <div className="code-block" data-testid="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || "text"}</span>
        <button type="button" className="code-copy" data-testid="code-copy" aria-label={`Copy ${name}`} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre className="code" data-lang={lang || undefined}><code>{code}</code></pre>
      <span role="status" className={failed ? "code-copy-error" : "sr-only"}>{failed ? "Could not copy. Select the code to copy it." : copied ? `Copied ${name}` : ""}</span>
    </div>
  );
}
