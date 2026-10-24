/** Remote-only display budgets. Plain-text fallback preserves every source character. */
export const REMOTE_TEXT_LIMITS = { tokens: 2048, lineCharacters: 4096, contextCharacters: 64 * 1024 } as const;
const TOKEN = /("(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|\b(?:true|false|null|const|let|return|function|export|import|from)\b)/g;

/** One budget for the file's complete set of hunks, rather than one budget per line/hunk. */
export function highlightRows<T extends { text: string }>(rows: readonly T[]): ReadonlyMap<T, readonly string[]> {
  const highlighted = new Map<T, readonly string[]>();
  let remaining: number = REMOTE_TEXT_LIMITS.tokens;
  for (const row of rows) {
    if (remaining === 0) break;
    if (row.text.length > REMOTE_TEXT_LIMITS.lineCharacters) continue;
    const parts = row.text.split(TOKEN, remaining + 1);
    if (parts.length > remaining) continue;
    highlighted.set(row, parts);
    remaining -= parts.length;
  }
  return highlighted;
}
