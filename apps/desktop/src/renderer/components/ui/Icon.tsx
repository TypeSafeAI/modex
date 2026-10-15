/**
 * Inline stroke icons on a 16×16 grid, drawn in `currentColor` so they follow text colour.
 * The set is limited to glyphs in the parity plan's capability map (controls Modex actually has), so the
 * shell and composer phases draw from one vocabulary; nothing here stands for a feature Modex lacks.
 */
const PATHS = {
  "folder-open": "M2 6V4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1V6M2 6.5h12l-2 6H3z",
  link: "M6.5 9.5l3-3M6 11l-1 1a2.12 2.12 0 0 1-3-3l3-3a2.12 2.12 0 0 1 3 0M10 5l1-1a2.12 2.12 0 0 1 3 3l-3 3a2.12 2.12 0 0 1-3 0",
  sparkle: "M8 1.5l1.6 4.9L14.5 8l-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6zM13 1v3M11.5 2.5h3",
  list: "M2.5 4h.01M2.5 8h.01M2.5 12h.01M6 4h7.5M6 8h7.5M6 12h7.5",
  shapes: "M4.5 2L7 6H2zM11.5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2.5 9.5h4v4h-4zM11.5 9l2.5 2.5-2.5 2.5L9 11.5z",
  "insert-square": "M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5zM8 5v6M5 8h6",
  checklist: "M2 3l1 1 2-2M2 8l1 1 2-2M2 13l1 1 2-2M8 3h6M8 8h6M8 13h6",
  sort: "M3 4h10M5 8h6M7 12h2",
  guide: "M1 6l7-3 7 3-7 3zM4 7.5v4c2 2 6 2 8 0v-4M15 6v5",
  page: "M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM6 6h4M6 9h3",
  image: "M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM2 10l3-3 7 6M10 5h.01",
  library: "M2 3h3v10H2zM6.5 3h3v10h-3zM10.5 3.5l2.5-.5 2 9.5-2.5.5z",
  history: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.5V8l-2 2",
  bell: "M3 11h10l-1.5-2V6a3.5 3.5 0 0 0-7 0v3zM6.5 13h3",
  minus: "M4 8h8",
  space: "M5 2h7a1 1 0 0 1 1 1v8M3 4h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4.5 7h3M4.5 9.5h2",
  star: "M8 1.8l1.85 3.75 4.15.6-3 2.93.71 4.13L8 11.26l-3.71 1.95L5 9.08 2 6.15l4.15-.6z",
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.5 9.5h7L12 4M6.5 6.5v4.5M9.5 6.5v4.5",
  archive: "M2.5 3h11v3h-11zM3.5 6v7h9V6M6.5 8.5h3",
  "terminal-box": "M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM4.5 6l2 2-2 2M8.5 10h3",
  files: "M6 3V2h6l2 2v6h-2M2 5h4l2 2h4v7H2z",
  "diff-color": "M2.5 3h11v10h-11zM3 12.5L13 3.5M4 10V5h7",
  globe: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM2 8h12M8 2c-3 3-3 9 0 12M8 2c3 3 3 9 0 12",
  review: "M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM5.5 6.5h5M8 4v5M5.5 11h5",
  expand: "M9.5 2.5h4v4M6.5 13.5h-4v-4",
  tabs: "M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM8 2.5v11",
  grid: "M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z",
  file: "M4 2h5l3 3v9H4zM9 2v4h3",
  paperclip: "M10.6 5.4L6 10a1.75 1.75 0 0 0 2.5 2.5l5-5a3.25 3.25 0 0 0-4.6-4.6L3.6 8.2a4.5 4.5 0 0 0 6.4 6.4l3.6-3.6",
  wrap: "M2 4h11M2 8h9a3 3 0 0 1 0 6H8M10 12l-2 2 2 2M2 12h3",
  fold: "M4 2v5M2 4l2-2 2 2M4 14V9M2 12l2 2 2-2M9 4h5M9 8h5M9 12h5",
  comment: "M3 2.5h10v8H8l-3 3v-3H3z",
  plus: "M8 3.5v9M3.5 8h9",
  home: "M2.5 7.25L8 2.75l5.5 4.5v5.75a.5.5 0 0 1-.5.5h-3.25v-4h-3.5v4H3a.5.5 0 0 1-.5-.5z",
  close: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  check: "M3.5 8.5l3 3 6-7",
  "chevron-down": "M4.5 6.25L8 9.75l3.5-3.5",
  "chevron-up": "M4.5 9.75L8 6.25l3.5 3.5",
  "chevron-right": "M6.25 4.5L9.75 8l-3.5 3.5",
  "arrow-left": "M12.5 8h-9M7 4.5L3.5 8 7 11.5",
  "arrow-right": "M3.5 8h9M9 4.5L12.5 8 9 11.5",
  "arrow-up": "M8 12.5v-9M4.5 7L8 3.5 11.5 7",
  download: "M8 2.5v7M5 6.5l3 3 3-3M3 10v3h10v-3",
  stop: "M5 5h6v6H5z",
  branch: "M5 5.5v5M11 6.5c0 2.5-6 1.5-6 4M5 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
  folder: "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5l3 3",
  compose: "M8.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7.5M11.5 2.5l2 2L8 10H6V8z",
  sidebar: "M3 3.5h10a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5zM6.5 3.5v9",
  more: "M4 8h.01M8 8h.01M12 8h.01",
  gear: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.75 3.75l1.06 1.06M11.19 11.19l1.06 1.06M3.75 12.25l1.06-1.06M11.19 4.81l1.06-1.06",
  info: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 7.5v3M8 5.25h.01",
  laptop: "M3.5 4.5h9v6h-9zM2 12h12",
  phone: "M5 1.75h6a1 1 0 0 1 1 1v10.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1zM7 12h2",
  changes: "M3 3.5h10v9H3zM9.5 3.5v9",
  terminal: "M3.5 4.5L6.5 8l-3 3.5M8 11.5h4.5",
  privacy: "M2.5 5.5L8 2.5l5.5 3v3.25c0 2.75-2.15 4.2-5.5 5.25-3.35-1.05-5.5-2.5-5.5-5.25zM5 8l2 2 4-4",
  restart: "M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 2.75v2.5H10",
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon-svg ${className}` : "icon-svg"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 2.25 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
