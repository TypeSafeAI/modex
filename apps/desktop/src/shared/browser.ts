/** User-entered addresses and searches. Privileged URL schemes never reach a guest renderer. */
export function browserURL(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a URL or search term.");
  const address = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)
    ? `http://${value}` : /^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(value) ? `https://${value}` : value;
  if (!/^[a-z][a-z\d+.-]*:/i.test(address)) return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  const url = new URL(address);
  if (!allowedBrowserURL(url.href) || url.username || url.password) throw new Error("Use an HTTPS URL or a local development server.");
  return url.href;
}
export function allowedBrowserURL(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}
export interface BrowserSnapshot { id: string; url: string; title: string; back: boolean; forward: boolean; loading: boolean; error?: string }
export interface BrowserBounds { x: number; y: number; width: number; height: number }

export type WorkspaceShortcut = "new" | "full" | "files" | "review" | "address" | "terminal" | "hide" | "escape";
