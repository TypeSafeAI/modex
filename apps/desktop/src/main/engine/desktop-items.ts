import { DESKTOP_ITEM_KINDS, LEGACY_DESKTOP_ITEM_KINDS } from "../../shared/desktop-protocol.js";
import type { ThreadEvent, ThreadItem } from "../../shared/types.js";

/**
 * Transcript items for a paired desktop that cannot draw every kind (docs/mac-app-store.md). A Store
 * build cut before CF-3 has no `question` or `plan` in its renderer and shows nothing for one, so its
 * host sends those as notices it can read, with the same id.
 */

/** The kinds a paired desktop named in its request header. One that names none predates the header. */
export function clientKinds(header: string | string[] | undefined): ReadonlySet<string> {
  const value = Array.isArray(header) ? header.join(",") : header;
  const named = value?.split(",").map((kind) => kind.trim()).filter(Boolean) ?? [];
  return new Set(named.length ? named : LEGACY_DESKTOP_ITEM_KINDS);
}

const drawsEverything = (kinds: ReadonlySet<string>) => DESKTOP_ITEM_KINDS.every((kind) => kinds.has(kind));

/** An item as a client that cannot draw its kind can read it. A question's answers are never included. */
export function itemForClient(item: ThreadItem, kinds: ReadonlySet<string>): ThreadItem {
  if (kinds.has(item.kind)) return item;
  return { id: item.id, kind: "notice", level: "info", text: noticeText(item), at: item.at };
}

function noticeText(item: ThreadItem): string {
  switch (item.kind) {
    case "question":
      return `The agent asked: ${item.questions.map((q) => q.text).join(" · ")}\n${item.delivery === "uncertain" ? "Answered; Modex can't tell whether the agent received it."
        : item.answers ? "Answered." : item.withdrawn ? "Not answered." : "Answer it in Modex, or update this app to answer here."}`;
    case "plan":
      return [`Plan · ${item.steps.filter((step) => step.status === "completed").length} of ${item.steps.length} reported done`,
        ...item.steps.map((step) => `${step.status === "completed" ? "✓" : "·"} ${step.text}`)].join("\n");
    default:
      return "An item from a newer version of Modex. Update this app to see it.";
  }
}

/**
 * A thread event as a client that draws `kinds` can apply it. An update to an item it cannot draw
 * arrives as that item's whole current notice, which every client replaces by id.
 */
export function eventForClient(event: ThreadEvent, kinds: ReadonlySet<string>, current: (threadId: string, itemId: string) => ThreadItem | undefined): ThreadEvent {
  if (drawsEverything(kinds)) return event;
  if (event.type === "item") return kinds.has(event.item.kind) ? event : { ...event, item: itemForClient(event.item, kinds) };
  if (event.type !== "item_update") return event;
  const item = current(event.threadId, event.id);
  return item && !kinds.has(item.kind) ? { threadId: event.threadId, type: "item", item: itemForClient(item, kinds) } : event;
}
