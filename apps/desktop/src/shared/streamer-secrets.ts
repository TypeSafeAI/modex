/** Display-only matching: source text must remain intact for storage and CLI execution. */
// The lookahead classifies once. Two consuming wildcards around the keyword can
// repeatedly repartition a long name containing many "token" words on failure.
const SECRET_NAME = String.raw`(?=[\w-]*(?:password|passwd|secret|token|api[-_]?key|credential|authorization))[\w-]+`;
const VALUE = String.raw`("(?:\\.|[^"\\\r\n])*(?:"|$)|'(?:\\.|[^'\\\r\n])*(?:'|$)|[^\s,;}&]+)`;
const LABEL = String.raw`["'\x60*]*${SECRET_NAME}["'\x60*]*`;

export function secretRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const collect = (pattern: RegExp, group = 0) => {
    for (const match of text.matchAll(pattern)) {
      const value = match[group]!;
      const start = match.index! + (group ? match[0].length - value.length : 0);
      if (value) ranges.push([start, start + value.length]);
    }
  };
  collect(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g);
  // Match prefixes while text is streaming, before a complete token has arrived.
  collect(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]+|\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+|\bxox[abposr]-[A-Za-z0-9-]+|\b(?:AKIA|ASIA)[A-Z0-9]+|\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){0,2}|\bAIza[A-Za-z0-9_-]+/g);
  collect(/(?:Proxy-)?Authorization\s*:\s*([^\r\n]+)/gi, 1);
  collect(/(?:X-Api-Key|Api-Key|X-Auth-Token|Cookie|Set-Cookie)\s*:\s*([^\r\n]+)/gi, 1);
  // Keep the URL's scheme, host and username visible.
  // Match the userinfo delimiter directly, including URLs prefixed by a diff sign.
  for (const match of text.matchAll(/:\/\/[^\s:/@]+:([^\s@/]+)@/g)) {
    const start = match.index! + match[0].length - match[1]!.length - 1;
    ranges.push([start, start + match[1]!.length]);
  }
  // Start once per name rather than retrying every suffix of a long terminal word.
  collect(new RegExp(String.raw`(?<![\w-])${SECRET_NAME}["'\x60*]*\s*(?:[=:]|\bis\b)\s*${VALUE}`, "gim"), 1);
  collect(new RegExp(String.raw`(?:^|[ \t])--?${SECRET_NAME}(?:=|[ \t]+)${VALUE}`, "gim"), 1);
  // YAML block scalars continue through indented lines, including partial streamed values.
  for (const match of text.matchAll(new RegExp(String.raw`^([ \t]*)${LABEL}[ \t]*:[ \t]*[|>][+\-\d]*[^\r\n]*\r?\n`, "gim"))) {
    const start = match.index! + match[0].length;
    let end = start;
    for (const line of text.slice(start).matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
      if (!line[0]) break;
      if (line[0].trim() && line[0].match(/^[ \t]*/)![0].length <= match[1]!.length) break;
      end += line[0].length;
    }
    if (end > start) ranges.push([start, end]);
  }
  // Merge overlaps so a token inside a labeled value is replaced just once.
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function redactSecrets(text: string): string {
  let result = "";
  let cursor = 0;
  for (const [start, end] of secretRanges(text)) {
    result += text.slice(cursor, start) + "[redacted]";
    cursor = end;
  }
  return result + text.slice(cursor);
}
