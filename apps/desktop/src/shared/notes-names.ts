/**
 * File and folder names for notes. A name is derived from a title once; the title itself lives in
 * the note's frontmatter whenever the name cannot carry it exactly (sanitized, suffixed, or empty).
 */

/** The longest stem in UTF-8 bytes, leaving room for " 999.md" under the common 255-byte limit. */
export const MAX_STEM_BYTES = 200;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** A safe file stem for `title`: NFC, no separators or control characters, no leading dot, never empty. */
export function noteStem(title: string): string {
  let stem = title.normalize("NFC")
    // Whitespace of any kind (tabs, line breaks) reads as one space.
    .replace(/\s+/g, " ")
    // Separators, characters Windows and Finder refuse, and the remaining control characters.
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, "-")
    .trim()
    // No hidden files, and no trailing dots or spaces (Windows strips them).
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (!stem) stem = "Untitled";
  // Open Knowledge reserves index.md at every level and serves `__x__` routes.
  if (WINDOWS_RESERVED.test(stem) || /^index$/i.test(stem) || /^__.*__$/.test(stem)) stem = `${stem} note`;
  return truncateBytes(stem, MAX_STEM_BYTES);
}

/** Cuts `text` to at most `max` UTF-8 bytes without splitting a character. */
export function truncateBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (bytes(out + ch) > max) break;
    out += ch;
  }
  return out.replace(/[.\s]+$/, "") || "Untitled";
}

/** Names compare the way APFS and NTFS do by default: Unicode-normalized and without case. */
export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** A name without its `.md`: a note `Plan.md` and a folder `Plan` would be the same entry to a reader. */
const stemKey = (name: string) => nameKey(name.replace(/\.md$/i, ""));

/**
 * `stem + ext`, or "stem 2.ext", "stem 3.ext"…, whichever is not taken. `taken` holds the names
 * already in the folder; a note and a folder of the same name count as taken by each other.
 */
export function uniqueName(stem: string, ext: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(stemKey));
  const candidate = (n: number) => n === 1 ? stem : `${truncateBytes(stem, MAX_STEM_BYTES - 4)} ${n}`;
  for (let n = 1; n < 10_000; n++) if (!used.has(stemKey(candidate(n)))) return `${candidate(n)}${ext}`;
  throw new Error("This folder has too many notes with that name.");
}
