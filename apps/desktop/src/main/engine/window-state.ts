import fs from "node:fs";
import path from "node:path";

/**
 * Window geometry that survives a relaunch: the normal (un-maximized) bounds plus whether the
 * window was maximized or full screen. Stored as JSON in MODEX_HOME, so e2e and demo homes stay isolated.
 */
export type Rect = { x: number; y: number; width: number; height: number };
export type WindowState = Rect & { maximized: boolean; fullscreen: boolean };

export const WINDOW_STATE_FILE = "window-state.json";
export const DEFAULT_SIZE = { width: 1380, height: 880 };
/** How much of the title bar must land on some display for saved bounds to be trusted. */
const MIN_VISIBLE = { width: 120, height: 42 };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function readWindowState(home: string): WindowState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, WINDOW_STATE_FILE), "utf8")) as Record<string, unknown>;
    if (![raw.x, raw.y, raw.width, raw.height].every(isNum)) return null;
    return {
      x: raw.x as number,
      y: raw.y as number,
      width: raw.width as number,
      height: raw.height as number,
      maximized: raw.maximized === true,
      fullscreen: raw.fullscreen === true,
    };
  } catch {
    return null;
  }
}

export function writeWindowState(home: string, state: WindowState): void {
  const file = path.join(home, WINDOW_STATE_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Bounds to open the window with. Saved bounds are used only when the top strip of the window
 * (where the title bar is) is still visible on one of the current displays' work areas — a display
 * that was unplugged must not strand the window off screen. The size is clamped to that display and
 * to the minimum size. Otherwise: the default size, centred by the OS.
 */
export function initialBounds(
  saved: WindowState | null,
  workAreas: Rect[],
  min: { width: number; height: number },
): Partial<Rect> & { width: number; height: number } {
  if (!saved) return { ...DEFAULT_SIZE };
  const titleStrip: Rect = { x: saved.x, y: saved.y, width: saved.width, height: MIN_VISIBLE.height };
  const home = workAreas.find((a) => overlap(titleStrip, a).width >= MIN_VISIBLE.width && overlap(titleStrip, a).height >= MIN_VISIBLE.height / 2);
  if (!home) return { width: Math.max(min.width, Math.min(saved.width, DEFAULT_SIZE.width)), height: Math.max(min.height, Math.min(saved.height, DEFAULT_SIZE.height)) };
  const width = Math.max(min.width, Math.min(saved.width, home.width));
  const height = Math.max(min.height, Math.min(saved.height, home.height));
  return { x: saved.x, y: saved.y, width, height };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}
