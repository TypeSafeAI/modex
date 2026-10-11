# Canvas previews

Open a workspace **New tab**, choose **Canvas**, then select an HTML, SVG or Markdown
file from the thread's checkout. Use the workspace's **Full view** button to expand it;
Escape returns to the conversation. **Reload Canvas** restarts the preview manually.

Canvas runs local HTML scripts and loads relative styles, scripts, images and fonts.
It refreshes the document when its source or a loaded local asset changes, including
assets that appear after the document. Polling runs while Canvas is visible. Switching
workspace tabs preserves the preview; closing Canvas or its thread releases its guest.
Deleted files show an error and recover when restored.

Markdown supports headings, paragraphs, lists, fenced code, inline code, bold and web
link text. Raw HTML in Markdown is displayed as text. SVG renders as an SVG document.
Canvas is a preview, so interactions do not save edits back to the source file.

Each preview runs in its own temporary browser session without Node, a preload, Modex's
bridge, permissions, downloads or app credentials. Main serves only supported regular
files inside the checkout; symlinks cannot grant access outside it. Hidden paths and
unsupported file types are refused. Each resource is limited to 1 MB and a preview can
track up to 128 resources. Remote requests, external navigation, frames, form submissions
and privileged URLs are blocked. For a development server or a page requiring network
access, use the existing workspace browser tab.

Canvas currently requires the full desktop app. The Store client and browser development
bridge report it unavailable rather than forwarding preview operations to a host.
