import type { Block } from "@create-markdown/core";
import { parseSpaceBlocks } from "../../shared/space-markdown";
import { pageImageUrl } from "../../shared/notes";

/**
 * React escapes text; allow only explicit web/mail links, web images, Images assets, and a page's own
 * images by a path relative to its file (served from the notes folder) in imported Markdown.
 */
export function safeBlocks(markdown: string, pageId?: string): Block[] {
  const clean = (block: Block): Block => ({ ...block,
    content: block.content.map(span => {
      const styles = { ...span.styles };
      if (styles.link && !/^(https?:|mailto:)/i.test(styles.link.url.trim())) delete styles.link;
      return { ...span, styles };
    }),
    props: block.type === "image" && !/^(https?:\/\/|modex-image:\/\/asset\/[a-f0-9-]{36}$)/i.test((block.props as { url: string }).url) ? localImage(block.props as { url: string }, pageId) : block.props,
    children: block.children.map(clean),
  });
  return parseSpaceBlocks(markdown).map(clean);
}

function localImage<T extends { url: string }>(props: T, pageId: string | undefined): T {
  const url = pageId ? pageImageUrl(pageId, props.url) : null;
  return url ? { ...props, url } : { ...props, url: "", alt: "Image URL must use HTTPS or HTTP, or a path beside this page" };
}

export const BLOCK_COMMANDS = [
  { name: "Text", hint: "Start with a thought", symbol: "Aa", source: "" },
  { name: "Heading 1", hint: "A big chapter", symbol: "H1", source: "# " },
  { name: "Heading 2", hint: "A new section", symbol: "H2", source: "## " },
  { name: "Heading 3", hint: "A smaller detail", symbol: "H3", source: "### " },
  { name: "Bulleted list", hint: "Collect a few ideas", symbol: "•", source: "- " },
  { name: "Numbered list", hint: "One step at a time", symbol: "1.", source: "1. " },
  { name: "Checklist", hint: "Keep track of what’s next", symbol: "☑", source: "- [ ] " },
  { name: "Quote", hint: "Words worth keeping", symbol: "❞", source: "> " },
  { name: "Code", hint: "A snippet, with room to think", symbol: "</>", source: "```\n\n```" },
  { name: "Table", hint: "Put details side by side", symbol: "⊞", source: "| Name | Details |\n| --- | --- |\n| Item | Description |" },
  { name: "Divider", hint: "Give the page a pause", symbol: "—", source: "---" },
  { name: "Image", hint: "Add an image by URL", symbol: "▧", source: "![Image description](https://)" },
] as const;
