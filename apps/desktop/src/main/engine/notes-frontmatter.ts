import { Document, isMap, parseDocument } from "yaml";

/** What Modex reads from a note file. `body` is exactly the text after the frontmatter. */
export interface ParsedNote {
  /** `modex_id` from the frontmatter, when it is a string. */
  id?: string;
  /** `title` from the frontmatter, when it is a string; otherwise the title is the file name. */
  title?: string;
  body: string;
  /** Whether the file has frontmatter Modex can edit (a YAML mapping). */
  frontmatter: boolean;
}

/**
 * Splits `text` into frontmatter and body. Frontmatter opens only with a first line of exactly `---`
 * and closes at the next line of exactly `---`; anything else is all body.
 */
export function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const open = /^---\r?\n/.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  const close = /^---\r?(?:\n|$)/m.exec(rest);
  if (!close) return null;
  return { yaml: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

function mapping(yaml: string): Document | null {
  let doc: Document;
  try { doc = parseDocument(yaml); } catch { return null; }
  if (doc.errors.length) return null;
  if (doc.contents === null) return new Document({});
  return isMap(doc.contents) ? doc : null;
}

export function parseNote(text: string): ParsedNote {
  const split = splitFrontmatter(text);
  const doc = split && mapping(split.yaml);
  if (!split || !doc) return { body: text, frontmatter: false };
  const id = doc.get("modex_id");
  const title = doc.get("title");
  return { ...(typeof id === "string" ? { id } : {}), ...(typeof title === "string" ? { title } : {}), body: split.body, frontmatter: true };
}

/**
 * The file text for a note. Keeps every other key (and comment) of `previous`'s frontmatter, sets
 * `modex_id`, and writes `title` only when the file name cannot carry it exactly.
 */
export function formatNote(note: { id: string; title: string; stem: string; body: string }, previous?: string): string {
  const split = previous === undefined ? null : splitFrontmatter(previous);
  const doc = (split && mapping(split.yaml)) ?? new Document({});
  doc.set("modex_id", note.id);
  if (note.title !== note.stem) doc.set("title", note.title);
  else doc.delete("title");
  return `---\n${doc.toString({ lineWidth: 0 })}---\n${note.body}`;
}
