import { workspace } from "./workspace";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../desktop/src/renderer/App";
import { BrandMark } from "../../desktop/src/renderer/components/BrandMark";
import { restoreTheme } from "../../desktop/src/renderer/theme";
import "../../desktop/src/renderer/tokens.css";
import "../../desktop/src/renderer/styles.css";
import "./web.css";

const SITE = "https://modex.codes/";
const DOWNLOAD = `${SITE}#get-started`;

function WebShell() {
  const [id, setId] = useState(workspace.id);
  return (
    <div className="web-shell">
      <header className="web-banner" aria-label="Demo workspace" data-testid="web-banner">
        <p>
          <strong>Demo workspace</strong>
          <span>Replies, files and approvals are simulated in this tab. Coding with Claude Code or Codex runs in the Mac app.</span>
        </p>
        <button type="button" data-testid="web-reset" onClick={() => { workspace.reset(); setId(workspace.id()); }}>Reset demo</button>
        <a className="web-download" href={DOWNLOAD}>Download for Mac <span aria-hidden="true">↗</span></a>
      </header>
      <div className="web-workspace">
        <App key={id} persistPreferences={false} spaceEnabled={false} analyticsEnabled={false} codeReviewEnabled={false} />
      </div>
      {/* The desktop interface needs room for its panes; a phone gets the way to the site instead. */}
      <main className="web-narrow" aria-labelledby="web-narrow-title" data-testid="web-narrow">
        <section>
          <div className="web-narrow-mark" aria-hidden="true"><BrandMark /></div>
          <p className="web-kicker">DEMO WORKSPACE</p>
          <h1 id="web-narrow-title">Made for a wider window.</h1>
          <p>Modex is a desktop workspace for Claude Code and Codex. Open this page on a computer to try the demo, or see how it works first.</p>
          <a className="web-download" href={SITE}>See how Modex works <span aria-hidden="true">↗</span></a>
          <p className="web-narrow-note">Free and open source. The Mac app runs your own Claude Code or Codex.</p>
        </section>
      </main>
    </div>
  );
}

restoreTheme();
createRoot(document.getElementById("root")!).render(<React.StrictMode><WebShell /></React.StrictMode>);
