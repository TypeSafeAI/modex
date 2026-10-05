import { useEffect, useRef, useState } from "react";
import type { BackendHealth, BackendId, ChatGPTStatus, EffortLevel, Mode, ModelInfo, RoutingPolicy, RoutingStatus, RoutingTest, Settings } from "../../shared/types";
import { BACKENDS, EFFORT_LEVELS, MODES } from "../../shared/types";
import { sameJudgeSettings, testMatchesJudge } from "../../shared/judge-settings";
import { bridge } from "../bridge";

interface Props {
  settings: Settings;
  onSave: (patch: Partial<Settings>) => Promise<void>;
  onClose: () => void;
}

const testIdentity = (test: RoutingTest) => {
  const tested = test.tested!;
  return test.transport === "cli"
    ? `jev CLI ${tested.executable ?? "(unknown executable)"} · ${tested.model}`
    : test.transport === "http"
      ? `HTTPS${tested.executable ? ` (CLI ${tested.executable} not selected)` : ""} · ${tested.model}`
      : `unavailable${tested.executable ? ` · CLI ${tested.executable}` : ""} · ${tested.model}`;
};

const errorMessage = (err: unknown, fallback: string) =>
  (err instanceof Error ? err.message : "").replace(/^Error invoking remote method '[^']+':\s*(?:Error(?::\s*|\s*$))?/, "").trim() || fallback;

const backendHealthText = (status: BackendHealth | undefined, failed: boolean) =>
  status ? `${status.version ? `v${status.version} · ` : ""}${status.detail}` : failed ? "Account check unavailable · retry" : "checking…";

export function SettingsDialog({ settings, onSave, onClose }: Props) {
  const [section, setSection] = useState<"general" | "clis" | "routing" | "advanced">("routing");
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissBlockedRef = useRef(false);
  const dismissRef = useRef(() => {});
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current!;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter((el) => el.getClientRects().length > 0 && !el.closest("[inert]"));
    (controls()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current();
      } else if (event.key === "Tab") {
        const list = controls();
        const first = list[0] ?? dialog;
        const last = list.at(-1) ?? dialog;
        const active = document.activeElement as HTMLElement;
        if (!list.includes(active) || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const [s, setS] = useState<Settings>(settings);
  const [health, setHealth] = useState<Record<BackendId, BackendHealth> | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [healthRevision, setHealthRevision] = useState(0);
  const [chatgpt, setChatgpt] = useState<ChatGPTStatus | null>(null);
  const [chatgptBusy, setChatgptBusy] = useState(false);
  const [chatgptDetail, setChatgptDetail] = useState("");
  const chatgptBusyRef = useRef(false);
  const [claudeLoginBusy, setClaudeLoginBusy] = useState(false);
  const [claudeLoginDetail, setClaudeLoginDetail] = useState("");
  const claudeLoginRef = useRef(false);
  const [lists, setLists] = useState<Partial<Record<BackendId, { models: ModelInfo[]; error?: string }>>>({});
  const [routing, setRouting] = useState<RoutingStatus | null>(null);
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [test, setTest] = useState<RoutingTest | "running" | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const operationRef = useRef(false);
  const routingStatusRequestRef = useRef(0);

  dismissRef.current = () => { if (!dismissBlockedRef.current) closeRef.current(); };

  useEffect(() => {
    let current = true;
    setHealth(null);
    setHealthFailed(false);
    void bridge.invoke("backends:health", undefined)
      .then((result) => { if (current) setHealth(result); })
      .catch(() => { if (current) setHealthFailed(true); });
    void bridge.invoke("chatgpt:status", undefined).then((result) => { if (current) setChatgpt(result); }).catch(() => { if (current) setChatgpt(null); });
    void bridge.invoke("models:list", { backend: "codex" }).then((result) => { if (current) setLists((lists) => ({ ...lists, codex: result })); }).catch(() => { if (current) setLists((lists) => ({ ...lists, codex: { models: [], error: "Could not load Codex models." } })); });
    return () => { current = false; };
  }, [healthRevision]);

  const accountAction = async (action: () => Promise<void>) => {
    if (chatgptBusyRef.current) return;
    chatgptBusyRef.current = true; setChatgptBusy(true); setChatgptDetail("Waiting for account operation…");
    try { await action(); }
    catch { setChatgptDetail("Account operation did not complete. Check protected storage, finish active turns, or retry sign-in. Existing credentials were preserved unless you signed out locally."); }
    finally { chatgptBusyRef.current = false; setChatgptBusy(false); setHealthRevision((revision) => revision + 1); }
  };

  useEffect(() => {
    const request = ++routingStatusRequestRef.current;
    void bridge.invoke("routing:status", undefined)
      .then((status) => { if (request === routingStatusRequestRef.current) { setRouting(status); setRoutingError(null); } })
      .catch((err) => { if (request === routingStatusRequestRef.current) { setRouting(null); setRoutingError(errorMessage(err, "Could not load judge status.")); } });
    for (const b of ["claude"] as BackendId[]) void bridge.invoke("models:list", { backend: b }).then((r) => setLists((l) => ({ ...l, [b]: r }))).catch((err) => setLists((l) => ({ ...l, [b]: { models: [], error: (err as Error).message } })));
  }, []);

  const modelSelect = (b: "claude" | "codex") => {
    const r = lists[b];
    const list = r?.models ?? [];
    return (
      <select value={list.some((m) => m.id === s.default_model[b]) ? s.default_model[b] : ""} onChange={(e) => set("default_model", { ...s.default_model, [b]: e.target.value })} disabled={!list.length}>
        <option value="">{r?.error ? "CLI unavailable" : list.length ? "CLI default" : "Loading…"}</option>
        {list.map((m) => <option key={m.id} value={m.id}>{m.label}{m.isDefault ? " · default" : ""}</option>)}
      </select>
    );
  };

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));
  const setR = <K extends keyof RoutingPolicy>(k: K, v: RoutingPolicy[K]) => setS((x) => ({ ...x, routing: { ...x.routing, [k]: v } }));
  const r = s.routing;
  const jevModel = r.jev_model.trim();
  const judgeDraftDirty = !sameJudgeSettings(r, settings.routing);
  const lastTest = routing?.lastTest;
  const savedTestMatches = !!lastTest && !judgeDraftDirty && !!routing && testMatchesJudge(lastTest, routing, settings.routing);
  const testResultStale = !!test && test !== "running" && !!test.tested &&
    (test.current === false || judgeDraftDirty || (!!routing && !testMatchesJudge(test, routing, settings.routing)));
  const interactionLocked = saving || keyBusy || resetBusy || test === "running";
  const learned = routing ? Object.entries(routing.fit.tasks).filter(([, t]) => t.offset !== 0) : [];
  const sourceLabel: Record<RoutingStatus["keySource"], string> = { modex: "Modex keychain", env: "TYPESAFE_API_KEY in the environment", "jev-config": "the jev CLI config (~/.config/jev/config.json)", "login-shell": "your login shell", none: "nowhere" };
  const keyAction = async (fn: () => Promise<RoutingStatus>) => {
    if (operationRef.current) return;
    operationRef.current = true;
    ++routingStatusRequestRef.current;
    setRoutingError(null);
    setKeyBusy(true);
    setKeyError(null);
    setTest(null);
    try {
      setRouting(await fn());
      setKeyDraft("");
    } catch (err) {
      const message = errorMessage(err, "Could not update the key.");
      setKeyError(message);
      setRouting(null);
      setRoutingError(message);
    } finally {
      setKeyBusy(false);
      operationRef.current = false;
    }
  };
  const resetLearning = async () => {
    if (operationRef.current || !window.confirm("Reset Auto routing's learned preferences? This applies immediately and cannot be undone.")) return;
    operationRef.current = true;
    ++routingStatusRequestRef.current;
    setRoutingError(null);
    setResetBusy(true);
    setResetError(null);
    setTest(null);
    try {
      setRouting(await bridge.invoke("routing:reset", undefined));
    } catch (err) {
      setResetError(`Could not confirm the learning reset: ${(err as Error).message || "unknown error"}. Reopen Settings to check the current learning state before retrying.`);
      setRouting(null);
      setRoutingError(errorMessage(err, "Could not refresh judge status after the learning reset."));
    } finally {
      setResetBusy(false);
      operationRef.current = false;
    }
  };
  const runTest = async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    const request = ++routingStatusRequestRef.current;
    setRoutingError(null);
    setTest("running");
    try {
      const result = await bridge.invoke("routing:test", undefined);
      try {
        const status = await bridge.invoke("routing:status", undefined);
        if (request === routingStatusRequestRef.current) { setRouting(status); setRoutingError(null); }
      } catch (err) {
        if (request === routingStatusRequestRef.current) {
          setRouting(null);
          setRoutingError(errorMessage(err, "Could not refresh judge status."));
        }
      }
      setTest(result);
    } catch (err) {
      const message = errorMessage(err, "Could not test the judge.");
      setTest({ ok: false, message, transport: "none", ms: 0 });
      setRouting(null);
      setRoutingError(message);
    } finally {
      operationRef.current = false;
    }
  };

  const save = async () => {
    if (operationRef.current) return;
    if (!jevModel) {
      setModelError("Enter a Jev model id before saving.");
      setSection("advanced");
      contentRef.current?.scrollTo(0, 0);
      return;
    }
    operationRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const draft: Settings = {
        ...s,
        default_model: { ...s.default_model },
        routing: { ...s.routing, allow_backends: [...s.routing.allow_backends], jev_model: jevModel },
      };
      await onSave(draft);
      onClose();
    } catch (err) {
      const detail = errorMessage(err, "");
      setSaveError(detail ? `Could not save settings: ${detail}` : "Could not save settings.");
    } finally {
      setSaving(false);
      operationRef.current = false;
    }
  };
  dismissBlockedRef.current = interactionLocked;

  const chooseSection = (next: typeof section) => {
    setSection(next);
    contentRef.current?.scrollTo(0, 0);
  };
  const toggleBackend = (backend: "codex" | "claude", enabled: boolean) => {
    const selected = new Set(r.allow_backends);
    if (enabled) selected.add(backend);
    else selected.delete(backend);
    const coding = (["codex", "claude"] as const).filter((id) => selected.has(id));
    const legacyDemo = r.allow_backends.includes("mock") ? ["mock" as const] : [];
    setR("allow_backends", [...coding, ...legacyDemo]);
  };
  const toggleLegacyMock = (enabled: boolean) => {
    const allow = r.allow_backends.filter((backend) => backend !== "mock");
    setR("allow_backends", enabled ? [...allow, "mock"] : allow);
  };

  const sections = [
    ["general", "General"], ["clis", "Coding CLIs"], ["routing", "Auto routing"], ["advanced", "Advanced / demo"],
  ] as const;

  return (
    <div className="modal-backdrop" onClick={() => { if (!interactionLocked) onClose(); }}>
      <div ref={dialogRef} tabIndex={-1} className="modal settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-busy={interactionLocked} aria-label="Settings" data-testid="settings">
        <header className="settings-header" data-testid="settings-header">
          <div>
            <h2>Settings</h2>
            <p>Modex runs the Claude Code and Codex CLIs for coding. Jev classifies requests for Auto routing; it never sees project files or runs coding turns.</p>
          </div>
        </header>
        <nav className="settings-nav" aria-label="Settings sections" data-testid="settings-nav">
          {sections.map(([id, label]) => <button key={id} type="button" disabled={interactionLocked} className={`settings-nav-item${section === id ? " active" : ""}`} aria-current={section === id ? "page" : undefined} onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })} onClick={() => chooseSection(id)}>{label}</button>)}
        </nav>
        <div className="settings-scroll" ref={contentRef} data-testid="settings-content" inert={interactionLocked}>
        {section === "general" && <section id="settings-general" aria-labelledby="settings-general-title" className="settings-section">
          <h3 id="settings-general-title">General</h3>
          <label className="field">
            <span>Default backend for new threads</span>
            <select value={s.default_backend} onChange={(e) => set("default_backend", e.target.value as BackendId)}>
              {BACKENDS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              <option value="mock">Mock (offline demo)</option>
            </select>
          </label>
          <label className="field">
            <span>Default mode for new threads</span>
            <select value={s.default_mode} onChange={(e) => set("default_mode", e.target.value as Mode)}>
              {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        </section>}
        {section === "clis" && <section id="settings-clis" aria-labelledby="settings-clis-title" className="settings-section">
          <h3 id="settings-clis-title">Coding CLIs</h3>
          <div data-testid="chatgpt-accounts">
            <h4>ChatGPT account for Codex</h4>
            <p className="hint">Account actions apply immediately and remain applied if you cancel Settings. Existing conversations keep their original account. Codex runs coding turns; Modex stores only this sign-in's credentials in protected OS storage.</p>
            <label className="field"><span>Active account for new Codex conversations</span>
              <select disabled={chatgptBusy || !chatgpt?.available} value={chatgpt?.active ?? ""} onChange={(event) => { const id = event.target.value || null; void accountAction(async () => { setChatgpt(await bridge.invoke("chatgpt:select", { accountId: id })); setChatgptDetail("Account selected for new conversations."); }); }}>
                <option value="">Existing Codex CLI authentication</option>
                {chatgpt?.accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.registration} · {account.signedIn ? account.planEnabled ? "plan authorized" : "identity only" : "signed out"}</option>)}
              </select>
            </label>
            <button type="button" disabled={chatgptBusy || !chatgpt?.available} onClick={() => { void accountAction(async () => { setChatgptDetail("Complete sign-in in your system browser. Model access remains unverified."); setChatgpt(await bridge.invoke("chatgpt:signIn", {})); setChatgptDetail("ChatGPT identity verified. Check plan authorization and complete a Codex turn to verify model access."); }); }}>Continue with ChatGPT</button>
            {chatgpt?.active && <>
              <button type="button" disabled={chatgptBusy} onClick={() => { const accountId = chatgpt.active!; void accountAction(async () => { setChatgpt(await bridge.invoke("chatgpt:signIn", { accountId })); setChatgptDetail("Selected registration reauthorized."); }); }}>Reauthorize selected account</button>
              <button type="button" disabled={chatgptBusy} onClick={() => { const accountId = chatgpt.active!; void accountAction(async () => { const result = await bridge.invoke("chatgpt:signOut", { accountId }); setChatgpt(result.status); setChatgptDetail(result.detail); }); }}>Sign out selected account</button>
            </>}
            {chatgptBusy && <button type="button" onClick={() => { void bridge.invoke("chatgpt:cancel", undefined); }}>Cancel ChatGPT sign-in</button>}
            <p role="status">{chatgptDetail || chatgpt?.detail || "Checking protected credential storage…"}</p>
          </div>
          <button type="button" disabled={claudeLoginBusy || s.claude_bin !== settings.claude_bin} onClick={async () => {
            if (claudeLoginRef.current) return;
            claudeLoginRef.current = true;
            setClaudeLoginBusy(true);
            setClaudeLoginDetail("Waiting for Claude Code sign-in. Complete the browser flow; opening the browser does not confirm login.");
            try { const result = await bridge.invoke("claude:login", undefined); setClaudeLoginDetail(result.detail); }
            catch { setClaudeLoginDetail("Could not start Claude sign-in. Check the configured executable."); }
            finally { claudeLoginRef.current = false; setClaudeLoginBusy(false); setHealthRevision((revision) => revision + 1); }
          }}>Sign in to Claude Code</button>
          {claudeLoginBusy && <button type="button" onClick={() => { void bridge.invoke("claude:cancelLogin", undefined); }}>Cancel sign-in</button>}
          <p role="status">{claudeLoginDetail}</p>
          <p className="hint">Sign-in applies immediately to the saved CLI path and is shared with other Claude Code clients. It remains applied if you cancel Settings. Claude owns credentials; API or enterprise configuration may take precedence. For manual-input recovery, run claude auth login in your terminal. No logout or account-switch action is provided.</p>
          <button type="button" onClick={() => setHealthRevision((revision) => revision + 1)}>Refresh account status</button>
          <p className="hint">Checks the saved executable paths used by this app session. Model catalogues do not confirm account access. Path changes require a restart.</p>
        <div className="grid2">
          <label className="field">
            <span>Claude executable</span>
            <input value={s.claude_bin} onChange={(e) => set("claude_bin", e.target.value)} spellCheck={false} />
            <small className={s.claude_bin === settings.claude_bin && health?.claude.authentication === "authenticated" ? "ok" : "warn"}>{s.claude_bin !== settings.claude_bin ? "Path changed · save and restart to check" : backendHealthText(health?.claude, healthFailed)}</small>
          </label>
          <label className="field">
            <span>Codex executable</span>
            <input value={s.codex_bin} onChange={(e) => set("codex_bin", e.target.value)} spellCheck={false} />
            <small className={s.codex_bin === settings.codex_bin && health?.codex.authentication === "authenticated" ? "ok" : "warn"}>{s.codex_bin !== settings.codex_bin ? "Path changed · save and restart to check" : backendHealthText(health?.codex, healthFailed)}</small>
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Default Claude model</span>
            {modelSelect("claude")}
          </label>
          <label className="field">
            <span>Default Codex model</span>
            {modelSelect("codex")}
          </label>
        </div>
        </section>}
        {section === "routing" && <section id="settings-routing" aria-labelledby="settings-routing-title" className="settings-section" data-testid="settings-routing-section">
        <h3 id="settings-routing-title">Auto routing</h3>
        <p className="hint">Settings below are drafts until Save. API key changes, Clear, and learning reset apply immediately and remain applied if you cancel.</p>
        <p className="routing-status" data-testid="routing-status">
          {routingError ? <span className="warn">Judge status unavailable: {routingError} Use Test judge to retry with saved settings.</span> : routing === null ? "Checking the judge…" : routing.live ? (
            <span>
              Jev transport configured — {routing.transport.kind === "cli" ? `via the jev CLI ${routing.transport.version ?? ""} (${routing.transport.bin})` : "via Modex's own HTTPS call"}
              {routing.keyLast4 ? `, key ****${routing.keyLast4} from ${sourceLabel[routing.keySource]}` : routing.keySource === "none" ? ", key left to the CLI" : ""}
              {routing.keyRef ? ` (1Password ${routing.keyRef})` : ""}.
            </span>
          ) : (
            <span className="warn">{routing.detail ?? "Jev is not available."} Auto uses the built-in heuristic.</span>
          )}
          {routing ? ` ${routing.fit.routes} auto turn${routing.fit.routes === 1 ? "" : "s"} so far` : ""}
          {routing && r.premium_turns_per_day != null ? ` · ${routing.fit.premiumToday}/${r.premium_turns_per_day} premium today` : ""}
          {learned.length ? ` · learned: ${learned.map(([k, t]) => `${k.replace(/_/g, " ")} ${t.offset > 0 ? "+" : ""}${t.offset}`).join(", ")}` : ""}
          {routing && routing.fit.routes > 0 ? <> · <button className="btn small ghost" disabled={interactionLocked} onClick={() => void resetLearning()}>Reset learning…</button></> : null}
        </p>
        {resetError && <p className="warn" role="alert" data-testid="routing-reset-error">{resetError}</p>}
        <div className="key-row" data-testid="jev-key">
          <label className="field grow">
            <span>TypeSafe API key {routing?.secrets.present ? <em className="ok">· saved in {routing.secrets.backend}{routing.keySource === "modex" && routing.keyLast4 ? ` (****${routing.keyLast4})` : ""}</em> : null}</span>
            <input type="password" autoComplete="off" value={keyDraft} placeholder={routing?.secrets.present ? "Saved — paste a new key to replace it" : "sk-… or op://Vault/Item/field"} onChange={(e) => setKeyDraft(e.target.value)} disabled={keyBusy || routing?.secrets.available === false} spellCheck={false} />
            <small className={routing?.secrets.available === false ? "warn" : ""}>
              {routing?.secrets.available === false
                ? `${routing.secrets.backend} encryption is unavailable here — use TYPESAFE_API_KEY or \`jev config set apiKey …\` instead.`
                : "Encrypted with the OS keychain and kept out of state.json and every build. A 1Password reference is expanded in memory at use time. Env, the jev CLI config, and your login shell are also checked, in that order after this."}
            </small>
            {keyError && <small className="warn">{keyError}</small>}
          </label>
          <div className="key-actions">
            <button className="btn small primary" disabled={interactionLocked || !keyDraft.trim()} onClick={() => void keyAction(() => bridge.invoke("routing:setKey", { key: keyDraft }))}>Save key now</button>
            <button className="btn small" disabled={interactionLocked || !routing?.secrets.present} onClick={() => void keyAction(() => bridge.invoke("routing:clearKey", undefined))}>Clear now</button>
            <button className="btn small" disabled={interactionLocked || judgeDraftDirty} onClick={() => void runTest()} title={judgeDraftDirty ? "Save or revert the transport and executable draft before testing" : "Sends one tiny question through the currently saved transport"}>Test judge</button>
          </div>
        </div>
        {judgeDraftDirty && <p className="hint" data-testid="routing-test-draft">Transport, executable, or model draft differs from saved settings. Save or revert it before testing; the test never saves settings.</p>}
        {routing && <p className={`routing-test ${savedTestMatches ? (lastTest!.ok ? "ok" : "warn") : ""}`} data-testid="routing-verification">
          {savedTestMatches ? `${lastTest!.ok ? "Verified" : "Last test failed"} · ${testIdentity(lastTest!)} · ${new Date(lastTest!.at).toLocaleString()} · ${lastTest!.message}${lastTest!.status ? ` (HTTP ${lastTest!.status})` : ""} · ${lastTest!.ms} ms` : routing.live ? "Configured · untested" : "Unavailable · untested"}
        </p>}
        {test && test !== "running" && <p className={`routing-test ${test.ok ? "ok" : "warn"}`} data-testid="routing-test">{test.ok ? "✓ " : "✗ "}{test.message}{test.tested ? ` · tested ${testIdentity(test)}` : ""}{test.status ? ` (HTTP ${test.status})` : ""} · {test.ms} ms</p>}
        {test === "running" && <p className="routing-test">Asking Jev…</p>}
        {testResultStale && <p className="warn" data-testid="routing-test-stale">Settings changed while this test ran; its result does not verify the current configuration.</p>}
        <div className="grid2">
          <label className="field">
            <span>Judge transport</span>
            <select value={r.jev_transport} onChange={(e) => setR("jev_transport", e.target.value as RoutingPolicy["jev_transport"])}>
              <option value="auto">Auto — jev CLI when installed, else HTTPS</option>
              <option value="cli">Always the jev CLI</option>
              <option value="http">Always Modex's HTTPS call</option>
            </select>
          </label>
          <label className="field">
            <span>jev executable</span>
            <input value={r.jev_bin} onChange={(e) => setR("jev_bin", e.target.value)} spellCheck={false} />
            <small>{judgeDraftDirty ? "Draft transport or executable has not been checked. Save or revert before testing." : routingError ? "Saved transport status is unavailable; use Test judge to retry." : settings.routing.jev_transport === "http" ? "The jev CLI is not used or checked in HTTP-only mode." : routing?.transport.kind === "cli" ? `found: ${routing.transport.bin} ${routing.transport.version ?? ""}` : settings.routing.jev_transport === "auto" && routing?.transport.kind === "http" ? "Auto selected HTTPS; the jev CLI was not selected." : routing?.detail ? `CLI unavailable: ${routing.detail}` : "Checking the saved transport…"}</small>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={r.auto_by_default} onChange={(e) => setR("auto_by_default", e.target.checked)} />
          <span>New threads start with Auto on</span>
        </label>
        <div className="grid2">
          <label className="field">
            <span>Posture</span>
            <select data-testid="routing-posture" value={r.posture} onChange={(e) => setR("posture", e.target.value as RoutingPolicy["posture"])}>
              <option value="economy">Economy — one tier down</option>
              <option value="balanced">Balanced</option>
              <option value="quality">Quality — one tier up</option>
            </select>
          </label>
          <label className="field">
            <span>Reasoning effort ceiling</span>
            <select value={r.max_effort} onChange={(e) => setR("max_effort", e.target.value as EffortLevel)}>
              {EFFORT_LEVELS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Minimum judge confidence (below it, Auto keeps your model)</span>
            <input type="number" min={0} max={1} step={0.05} value={r.min_confidence} onChange={(e) => setR("min_confidence", Math.max(0, Math.min(1, Number(e.target.value) || 0)))} />
          </label>
          <label className="field">
            <span>Premium turns per day (top tier / xhigh+; blank = unlimited)</span>
            <input type="number" min={0} step={1} value={r.premium_turns_per_day ?? ""} placeholder="unlimited" onChange={(e) => setR("premium_turns_per_day", e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={r.allow_fast} onChange={(e) => setR("allow_fast", e.target.checked)} />
          <span>Allow fast mode for light, speed-sensitive turns</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={r.allow_backend_switch} onChange={(e) => setR("allow_backend_switch", e.target.checked)} />
          <span>Allow Auto to switch between Codex and Claude when a thread has no session to lose</span>
        </label>
        </section>}
        {section === "advanced" && <section id="settings-advanced" aria-labelledby="settings-advanced-title" className="settings-section" data-testid="settings-advanced-section">
          <h3 id="settings-advanced-title">Advanced routing and demo</h3>
          <label className="field">
            <span>Jev judge model</span>
            <input data-testid="jev-model" type="text" value={r.jev_model} onChange={(e) => { setR("jev_model", e.target.value); setModelError(e.target.value.trim() ? null : "Enter a Jev model id before saving."); }} onBlur={() => setR("jev_model", r.jev_model.trim())} aria-invalid={!jevModel || !!modelError} aria-describedby="jev-model-help" spellCheck={false} />
            <small id="jev-model-help">Model id used for future Auto routing decisions. Default: <code>jev-latest</code>. Existing threads keep their current backend, model, and CLI session.</small>
            {modelError && <small className="warn" role="alert">{modelError}</small>}
          </label>
          <fieldset className="settings-backends">
            <legend>Allowed coding backends when Auto can switch</legend>
            {(["codex", "claude"] as const).map((backend) => <label className="check" key={backend}>
              <input type="checkbox" checked={r.allow_backends.includes(backend)} onChange={(e) => toggleBackend(backend, e.target.checked)} />
              <span>{backend === "codex" ? "Codex" : "Claude"}</span>
            </label>)}
            <small>{r.allow_backends.some((backend) => backend === "codex" || backend === "claude")
              ? "Auto may switch among the selected coding backends when the thread has no CLI session to preserve. This list does not enable switching by itself; the Auto routing switch must also be on."
              : r.allow_backends.includes("mock")
                ? "No coding CLI is selected. Mock remains an allowed destination for offline routing when the current backend has no suitable model. Switching must also be enabled above."
                : "With an empty allowed-backend list, Auto stays on the thread’s current backend. Switching must also be enabled above."}</small>
          </fieldset>
          <p className="hint settings-effect">Saved routing settings apply to the next Auto decision, including in existing threads. They do not change a thread’s current backend, model, or CLI session.</p>
          <div className="settings-divider" />
          <h3 className="section-title">Offline demo</h3>
          <fieldset className="settings-backends settings-demo-backend">
            <legend>Routing compatibility</legend>
            <label className="check">
              <input data-testid="allow-mock-routing" type="checkbox" checked={r.allow_backends.includes("mock")} onChange={(e) => toggleLegacyMock(e.target.checked)} />
              <span>Allow Mock for offline demo routing</span>
            </label>
            <small>Mock is the offline scripted backend, not a coding CLI. Existing Mock allowlist entries stay enabled until you turn this off.</small>
          </fieldset>
          <label className="field">
            <span>Mock script</span>
            <input value={s.mock_script ?? ""} onChange={(e) => set("mock_script", e.target.value)} placeholder="/path/to/mock-script.json" spellCheck={false} />
            <small>Used only by the Mock backend for scripted offline demos and tests.</small>
          </label>
        </section>}
        </div>
        <footer className="settings-footer" data-testid="settings-actions">
          {saveError && <p className="warn" role="alert" data-testid="settings-save-error">{saveError} Your draft is still here; retry or cancel.</p>}
          <div className="row end">
            <button className="btn" disabled={interactionLocked} onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={interactionLocked} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
