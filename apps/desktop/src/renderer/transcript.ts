import type { ThreadEvent, ThreadItem } from "../shared/types";

export type ItemEvent = Extract<ThreadEvent, { type: "item" | "item_update" }>;

/** Replay events over a snapshot without duplicating items already included in that snapshot. */
export function applyItemEvent(items: ThreadItem[], event: ItemEvent): ThreadItem[] {
  const id = event.type === "item" ? event.item.id : event.id;
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return event.type === "item" ? [...items, event.item] : items;
  const next = [...items];
  next[index] = event.type === "item" ? event.item : { ...items[index], ...event.patch } as ThreadItem;
  return next;
}
