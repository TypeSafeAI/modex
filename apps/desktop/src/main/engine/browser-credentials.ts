import { execFile } from "node:child_process";
import { resolveCli } from "./cli-path.js";

export interface BrowserLogin { id: string; vault: string; title: string }
export interface LoginFields { username: string; password: string }
interface Target { url: string; isCurrent(): boolean; fill(fields: LoginFields): Promise<boolean> }
interface Dependencies { read(args: string[]): Promise<unknown>; choose(logins: BrowserLogin[], origin: string): Promise<number | undefined> }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-z\d]{26}$/.test(value);
function httpsOrigin(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined; }
  catch { return undefined; }
}
/** 1Password may store a website as a bare host; read it as HTTPS, never as any other scheme. */
const savedOrigin = (href: string) => httpsOrigin(/^[a-z][a-z\d+.-]*:/i.test(href) ? href : `https://${href}`);

export function matchingLogins(value: unknown, origin: string): BrowserLogin[] {
  if (!Array.isArray(value) || httpsOrigin(origin) !== origin) return [];
  return value.filter(item => object(item) && item.category === "LOGIN" && identifier(item.id) && object(item.vault) && identifier(item.vault.id) && typeof item.title === "string" && Array.isArray(item.urls) && item.urls.some((url: unknown) => object(url) && typeof url.href === "string" && savedOrigin(url.href) === origin))
    .map(item => ({ id: item.id, vault: item.vault.id, title: item.title.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100) }));
}

/** No shell, service-account token, stderr, credentials in IPC, or background vault polling. */
export async function read1Password(args: string[]): Promise<unknown> {
  const executable = resolveCli("op", "op");
  const env: NodeJS.ProcessEnv = { ...process.env, OP_BIOMETRIC_UNLOCK_ENABLED: "true" };
  for (const key of Object.keys(env)) if (/^OP_(?:SESSION_|SERVICE_ACCOUNT_TOKEN$|CONNECT_)/.test(key)) delete env[key];
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env }, (error, stdout) => {
      if (error) { reject(new Error("Unlock 1Password and enable its CLI integration, then try again.")); return; }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("1Password returned an unreadable response.")); }
    });
  });
}

export async function fillFrom1Password(target: Target, deps: Dependencies): Promise<boolean> {
  const origin = httpsOrigin(target.url);
  if (!origin) throw new Error("1Password filling is available only on HTTPS pages.");
  const current = () => { if (!target.isCurrent()) throw new Error("The page changed. Select a login again on the current page."); };
  const read = async (args: string[]) => {
    try { return await deps.read(args); }
    catch { throw new Error("1Password could not be read. Install the 1Password CLI, unlock the desktop app and enable Settings → Developer → Integrate with 1Password CLI."); }
  };
  current();
  const logins = matchingLogins(await read(["item", "list", "--categories=Login", "--format=json"]), origin);
  current();
  if (!logins.length) throw new Error("No 1Password logins match this exact HTTPS site. Add this site's address to the login in 1Password.");
  if (logins.length > 12) throw new Error("More than 12 logins match this site. Narrow their website addresses in 1Password or use your system browser.");
  const selected = await deps.choose(logins, origin);
  current();
  if (selected === undefined) return false;
  const login = Number.isInteger(selected) ? logins[selected] : undefined;
  if (!login) throw new Error("Invalid login selection.");
  const item = await read(["item", "get", login.id, "--vault", login.vault, "--format=json"]);
  current();
  if (!matchingLogins([item], origin).some(entry => entry.id === login.id && entry.vault === login.vault) || !object(item)) throw new Error("This login no longer matches the page. Select a login again.");
  const fields = Array.isArray(item.fields) ? item.fields : [];
  const value = (purpose: string) => {
    const field = fields.find(field => object(field) && field.purpose === purpose);
    return object(field) && typeof field.value === "string" ? field.value : "";
  };
  const username = value("USERNAME"), password = value("PASSWORD");
  if ((!username && !password) || username.length > 4096 || password.length > 4096) throw new Error("This login has no usable username or password.");
  let filled: boolean;
  try { filled = await target.fill({ username, password }); }
  catch { throw new Error("The login could not be filled. Select a login again on the current page."); }
  if (!filled) throw new Error("No unambiguous login fields were found. Focus the login form or use your system browser.");
  return true;
}

/** Serialized into an isolated guest world. It neither returns secrets nor submits a form. */
export function fillLoginFields(origin: string, fields: LoginFields): boolean {
  if (location.origin !== origin || location.protocol !== "https:" || window.top !== window) return false;
  const visible = (input: HTMLInputElement) => !input.disabled && !input.readOnly && input.getClientRects().length > 0 && getComputedStyle(input).visibility !== "hidden";
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(visible);
  const passwords = inputs.filter(input => input.type === "password");
  // Never choose a field in a registration/change-password form or an ambiguous form.
  if (passwords.length > 1 || passwords.some(input => input.autocomplete === "new-password")) return false;
  const password = passwords[0];
  const form = password?.form ?? (document.activeElement instanceof HTMLInputElement ? document.activeElement.form : null);
  if (form && new URL(form.action, location.href).origin !== origin) return false;
  const candidates = inputs.filter(input => (!password || input.form === password.form) && ["text", "email", "tel"].includes(input.type));
  const explicit = candidates.filter(input => input.autocomplete.split(" ").includes("username") || input.type === "email");
  const username = explicit.length === 1 ? explicit[0] : password && candidates.length === 1 ? candidates[0] : undefined;
  if (!password && !username) return false;
  if (username?.form && new URL(username.form.action, location.href).origin !== origin) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const changed: HTMLInputElement[] = [];
  // Set both values before dispatching events, which may synchronously replace the document.
  if (username && fields.username) { set.call(username, fields.username); changed.push(username); }
  if (password && fields.password) { set.call(password, fields.password); changed.push(password); }
  for (const input of changed) {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return changed.length > 0;
}

interface CredentialRequest {
  token: string;
  document: Document;
  href: string;
  cancelled: boolean;
  revoke(): void;
}
type CredentialWorld = typeof globalThis & { modexCredentialRequest?: CredentialRequest };

/** Serialized separately into app-owned world 1001, before any vault read. No secrets here. */
export function prepareLoginRequest(token: string, href: string): boolean {
  const world = globalThis as CredentialWorld;
  world.modexCredentialRequest?.revoke();
  delete world.modexCredentialRequest;
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  if (!navigation || typeof navigation.addEventListener !== "function" || typeof navigation.removeEventListener !== "function" || window.top !== window || location.protocol !== "https:" || location.href !== href) return false;
  const request: CredentialRequest = { token, document, href, cancelled: false, revoke: () => {
    request.cancelled = true;
    navigation.removeEventListener("navigate", request.revoke);
    window.removeEventListener("pagehide", request.revoke);
  } };
  navigation.addEventListener("navigate", request.revoke);
  window.addEventListener("pagehide", request.revoke);
  world.modexCredentialRequest = request;
  return true;
}

/** Cleanup is token-specific: a delayed old request cannot revoke a newer selection. */
export function disposeLoginRequest(token: string): void {
  const world = globalThis as CredentialWorld;
  if (world.modexCredentialRequest?.token !== token) return;
  world.modexCredentialRequest.revoke();
  delete world.modexCredentialRequest;
}

/** Validation, consumption and field writes MUST stay in one synchronous isolated script. */
export function fillLoginRequest(token: string, href: string, fields: LoginFields, fill: typeof fillLoginFields): boolean {
  const world = globalThis as CredentialWorld, request = world.modexCredentialRequest;
  if (!request || request.token !== token || request.cancelled || request.document !== document || request.href !== href || location.href !== href || window.top !== window || location.protocol !== "https:") return false;
  request.revoke();
  delete world.modexCredentialRequest;
  return fill(location.origin, fields);
}
