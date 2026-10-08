import type { Block } from "@create-markdown/core";
import { parseSpaceBlocks } from "../../shared/space-markdown";

/** React escapes text; allow only explicit web/mail links and web images in imported Markdown. */
export function safeBlocks(markdown: string): Block[] {
  const clean = (block: Block): Block => ({ ...block,
    content: block.content.map(span => {
      const styles = { ...span.styles };
      if (styles.link && !/^(https?:|mailto:)/i.test(styles.link.url.trim())) delete styles.link;
      return { ...span, styles };
    }),
    props: block.type === "image" && !/^https?:\/\//i.test((block.props as { url: string }).url) ? { ...block.props, url: "", alt: "Image URL must use HTTPS or HTTP" } : block.props,
    children: block.children.map(clean),
  });
  return parseSpaceBlocks(markdown).map(clean);
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
