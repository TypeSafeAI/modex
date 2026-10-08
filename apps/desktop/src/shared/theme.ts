/** Appearance preferences shared by the renderer and native window. */
export const THEMES = {
  graphite: { name: "Graphite", description: "Neutral charcoal · lavender", background: "#0f0f11", surface: "#262729", accent: "#a89bd8" },
  jev: { name: "Jev", description: "Midnight blue · pink", background: "#0b0f1b", surface: "#1d2435", accent: "#f386a1" },
  coven: { name: "OpenCoven", description: "Charcoal · lavender", background: "#1c1b1d", surface: "#27272a", accent: "#9386d0" },
} as const;
export type Theme = keyof typeof THEMES;
export function normalizeTheme(value: unknown): Theme { return value === "coven" || value === "jev" ? value : "graphite"; }
