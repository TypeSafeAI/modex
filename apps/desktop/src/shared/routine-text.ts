import type { RoutineTrigger } from "./routines.js";

/**
 * A scheduled task is made by describing it in a chat message ("Every week, review the release work…").
 * This reads the schedule out of that message with fixed rules, so what is saved never depends on a model's
 * reply: the message itself becomes the task's instructions, and the first run answers it.
 */
export interface TaskFromText { name: string; trigger: RoutineTrigger; /** No schedule was found in the text: daily at 8 AM was used. */ assumed: boolean }

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12 };

/** "at 8", "8 AM", "8:30pm", "noon", "midnight" → hours and minutes; absent: null. */
function timeOf(text: string): { h: number; m: number } | null {
  if (/\bnoon\b/.test(text)) return { h: 12, m: 0 };
  if (/\bmidnight\b/.test(text)) return { h: 0, m: 0 };
  const m = /\b(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/.exec(text) ?? /\bat\s+(\d{1,2})(?::([0-5]\d))?(?![\d:a-z])/.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const half = m[3]?.[0];
  if (h > 23 || (half && (h < 1 || h > 12))) return null;
  if (half === "p" && h < 12) h += 12;
  if (half === "a" && h === 12) h = 0;
  return { h, m: Number(m[2] ?? 0) };
}

/** The next local time at `h:m` after `now`, on `weekday` when one is given. */
function next(now: Date, h: number, m: number, weekday?: number): string {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  while (at.getTime() <= now.getTime() || (weekday !== undefined && at.getDay() !== weekday)) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

export function taskFromText(raw: string, now: Date = new Date()): TaskFromText {
  const text = raw.toLowerCase();
  const time = timeOf(text);
  const { h, m } = time ?? { h: 8, m: 0 };
  let trigger: RoutineTrigger | undefined;
  const every = /\bevery\s+(\d{1,3}|a|an|one|two|three|four|five|six|twelve)?\s*(minute|hour|day|week)s?\b/.exec(text);
  const weekday = DAYS.findIndex((day) => new RegExp(`\\b(?:every|each|on)\\s+${day}s?\\b|\\b${day}s\\b`).test(text));
  if (weekday >= 0) trigger = { kind: "interval", every: 7, unit: "days", from: next(now, h, m, weekday) };
  else if (every) {
    const n = every[1] ? WORDS[every[1]] ?? Number(every[1]) : 1;
    const unit = every[2]!;
    if (unit === "minute") trigger = { kind: "interval", every: Math.max(n, 5), unit: "minutes", from: new Date(now.getTime() + Math.max(n, 5) * 60_000).toISOString() };
    else if (unit === "hour") trigger = { kind: "interval", every: n, unit: "hours", from: new Date(now.getTime() + n * 3_600_000).toISOString() };
    else trigger = { kind: "interval", every: unit === "week" ? n * 7 : n, unit: "days", from: next(now, h, m) };
  } else if (/\bhourly\b/.test(text)) trigger = { kind: "interval", every: 1, unit: "hours", from: new Date(now.getTime() + 3_600_000).toISOString() };
  else if (/\bweekly\b|\beach week\b/.test(text)) trigger = { kind: "interval", every: 7, unit: "days", from: next(now, h, m) };
  else if (/\bdaily\b|\beach day\b|\bevery (?:morning|evening|night)\b/.test(text)) trigger = { kind: "interval", every: 1, unit: "days", from: next(now, /\bevery (?:evening|night)\b/.test(text) && !time ? 18 : h, m) };
  else if (/\btomorrow\b|\btonight\b|\bonce\b|\blater today\b/.test(text) && time) trigger = { kind: "once", at: next(now, h, m) };
  const assumed = !trigger;
  trigger ??= { kind: "interval", every: 1, unit: "days", from: next(now, h, m) };

  // The name: the message without its leading schedule phrase, cut to a few words.
  const lead = /^\s*(?:(?:every|each)\s+(?:\d+\s+|other\s+)?\w+|daily|weekly|hourly|tomorrow|tonight|once)(?:\s+(?:at\s+)?\d{1,2}(?::\d\d)?\s*(?:[ap]\.?m\.?)?)?\s*[,:–-]?\s*/i;
  const words = raw.replace(/\s+/g, " ").trim().replace(lead, "").split(" ").filter(Boolean);
  let name = "";
  for (const word of words.slice(0, 7)) { if ((name + " " + word).trim().length > 48) break; name = (name + " " + word).trim(); }
  name = name.replace(/[.,;:!?–-]+$/, "") || raw.trim().slice(0, 48) || "Scheduled task";
  return { name: name[0]!.toUpperCase() + name.slice(1), trigger, assumed };
}
