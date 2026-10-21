/**
 * Whether the Code Review destination is shown. Gate A (#319) is incomplete, so a built app hides it
 * unless this local switch is "on"; development builds show it. Nothing else reads the switch.
 */
export const CODE_REVIEW_SWITCH = "modex.codeReview";

export function codeReviewEnabled(storage: { getItem(key: string): string | null }, development: boolean): boolean {
  if (development) return true;
  try {
    return storage.getItem(CODE_REVIEW_SWITCH) === "on";
  } catch {
    return false;
  }
}
