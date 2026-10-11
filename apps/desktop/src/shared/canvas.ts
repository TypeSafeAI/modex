export const CANVAS_SCHEME = "modex-canvas";
export const canvasFile = (name: string): boolean => /\.(html?|svg|md|markdown)$/i.test(name);
export interface CanvasSnapshot { path: string; loading: boolean; error?: string }
