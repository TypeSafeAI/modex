import { THEMES, type Theme } from "../shared/theme.js";

/** Presentation only: these values are owned by Modex, never supplied by guest content. */
export function knowledgeAppearance(theme: Theme): { background: string; css: string } {
  const { background, surface, accent } = THEMES[theme];
  const palette = {
    graphite: { text: "#e3e4e6", muted: "#929296", sidebar: "#131315", border: "#29292c", hover: "#222224" },
    jev: { text: "#f8f3fa", muted: "#aaa5b8", sidebar: "#101523", border: "#2b3144", hover: "#1a2030" },
    coven: { text: "#fafafa", muted: "#aaa9b0", sidebar: "#171719", border: "#39383c", hover: "#2f2e32" },
  }[theme];
  const variables = {
    background, foreground: palette.text, card: background, "card-foreground": palette.text,
    popover: surface, "popover-foreground": palette.text, primary: accent, "primary-foreground": "#101014",
    secondary: surface, "secondary-foreground": palette.text, muted: surface, "muted-foreground": palette.muted,
    accent: palette.hover, "accent-foreground": palette.text, border: palette.border, input: palette.border, ring: accent,
    sidebar: palette.sidebar, "sidebar-foreground": palette.text, "sidebar-primary": accent,
    "sidebar-primary-foreground": "#101014", "sidebar-accent": palette.hover, "sidebar-accent-foreground": accent,
    "sidebar-hover": palette.hover, "sidebar-hover-foreground": palette.text, "sidebar-hover-muted-foreground": palette.muted,
    "sidebar-selected": palette.hover, "sidebar-selected-foreground": palette.text, "sidebar-selected-muted-foreground": palette.muted,
    "sidebar-border": palette.border, "sidebar-ring": accent, "link-color": accent, "syntax-bg": palette.sidebar,
    "selection-soft": `color-mix(in srgb, ${accent} 28%, transparent)`,
  };
  const prose = {
    body: palette.text, headings: palette.text, lead: palette.muted, links: accent, bold: palette.text,
    counters: palette.muted, bullets: palette.muted, hr: palette.border, quotes: palette.text,
    "quote-borders": palette.border, captions: palette.muted, code: palette.text,
    "pre-code": palette.text, "pre-bg": palette.sidebar, "th-borders": palette.border, "td-borders": palette.border,
  };
  return { background, css: `:root, :root.dark { color-scheme: dark !important; ${Object.entries(variables).map(([key, value]) => `--${key}: ${value} !important;`).join(" ")} }
    .prose, .tiptap { color: ${palette.text} !important; ${Object.entries(prose).map(([key, value]) => `--tw-prose-${key}: ${value} !important;`).join(" ")} }
    html, body { background-color: ${background} !important; color: ${palette.text} !important; }` };
}
