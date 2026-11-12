/**
 * Keyboard movement between Code Review's areas (real-use benchmark, F6). Every control was reachable with
 * Tab, but only through 34 to 124 presses between areas. F6 goes to the next area and Shift+F6 to the
 * previous, as desktop apps use it; `[` and `]` go to the previous and next changed file.
 */
export const AREAS: readonly { within: string; focus: string }[] = [
  { within: '[data-testid="code-review-inbox"]', focus: '[data-testid="code-review-search"]' },
  { within: '[data-testid="code-review-tabbar"]', focus: '[role="tab"][aria-selected="true"]' },
  { within: '[data-testid="code-review-overview-body"]', focus: ":scope" },
  { within: '[data-testid="code-review-diff"]', focus: ":scope" },
  { within: '[data-testid="code-review-tree"]', focus: '[data-testid="cr-tree-file"][aria-current="true"], [data-testid="cr-tree-file"]' },
];

/** The area to focus after `current` (an index into `present`, or -1 when focus is in none). */
export function nextArea(present: number[], current: number, back: boolean): number | null {
  if (!present.length) return null;
  const at = present.indexOf(current);
  if (at < 0) return back ? present[present.length - 1]! : present[0]!;
  return present[(at + (back ? present.length - 1 : 1)) % present.length]!;
}

/** The file `[` or `]` goes to from `selected`; it stops at either end rather than wrapping. */
export function stepFile(paths: string[], selected: string | null, back: boolean): string | null {
  if (!paths.length) return null;
  const at = selected === null ? -1 : paths.indexOf(selected);
  if (at < 0) return back ? paths[paths.length - 1]! : paths[0]!;
  return paths[Math.max(0, Math.min(paths.length - 1, at + (back ? -1 : 1)))]!;
}

/** True when a plain key press belongs to what is focused: text being typed, or a control that uses the key. */
export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Moves focus to the next or previous area that is on screen. Returns whether it moved. */
export function cycleArea(root: HTMLElement, back: boolean): boolean {
  const active = document.activeElement;
  const targets: (HTMLElement | null)[] = [];
  let current = -1;
  AREAS.forEach((area, i) => {
    const within = [...root.querySelectorAll<HTMLElement>(area.within)].find((el) => el.checkVisibility()) ?? null;
    const target = within && (area.focus === ":scope" ? within : [...within.querySelectorAll<HTMLElement>(area.focus)].find((el) => el.checkVisibility()) ?? null);
    targets.push(target);
    if (within && active && within.contains(active)) current = i;
  });
  const to = nextArea(targets.flatMap((el, i) => (el ? [i] : [])), current, back);
  if (to === null) return false;
  targets[to]!.focus();
  return document.activeElement === targets[to];
}
