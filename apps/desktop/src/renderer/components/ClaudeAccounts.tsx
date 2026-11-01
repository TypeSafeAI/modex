import { useEffect, useRef, useState } from "react";
import type { ClaudeAccountsStatus } from "../../shared/types";
import { bridge } from "../bridge";
import { SecretInput, SecretOption } from "../streamer";

/**
 * Modex's Claude account pool, inside Settings → Coding CLIs → Claude Code. Separate Claude Code
 * profiles (their own browser login) and OrcaRouter gateway keys, an active account for new
 * conversations, and rotation on usage limits. Keys go to main once and never come back.
 */
export function ClaudeAccounts({ disabled, onChanged }: { disabled: boolean; onChanged: () => void }) {
  const [status, setStatus] = useState<ClaudeAccountsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState("");
  const [adding, setAdding] = useState<"profile" | "gateway" | null>(null);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const busyRef = useRef(false);

  useEffect(() => {
    let current = true;
    void bridge.invoke("claudeAccounts:status", undefined).then((result) => { if (current) setStatus(result); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, []);

  /** Resolves true when the change was made; a refusal leaves its reason in the status line. */
  const act = async (pending: string, action: () => Promise<ClaudeAccountsStatus>, done: string | (() => string)): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setDetail(pending);
    try { setStatus(await action()); setDetail(typeof done === "function" ? done() : done); setFailed(false); return true; }
    catch (error) { setDetail((error as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || "The account change did not complete."); return false; }
    finally { busyRef.current = false; setBusy(false); onChanged(); }
  };

  const active = status?.accounts.find((account) => account.id === status.active);
  const off = disabled || busy || !status;
  const resetForm = () => { setAdding(null); setLabel(""); setKey(""); setModel(""); };

  return (
    <div className="claude-accounts" data-testid="claude-accounts">
      <label className="field connection-account"><span>Account for new Claude conversations</span>
        <select data-testid="claude-account-select" disabled={off} value={status?.active ?? ""} onChange={(event) => { const accountId = event.target.value || null; void act("Updating account…", () => bridge.invoke("claudeAccounts:select", { accountId }), "Account selected for new conversations."); }}>
          <SecretOption value="">Claude Code's own login</SecretOption>
          {status?.accounts.map((account) => <SecretOption key={account.id} value={account.id}>{account.label} · {account.kind === "gateway" ? "OrcaRouter" : "profile"} · {account.cooldownUntil ? "usage limit" : account.signedIn ? "ready" : "sign in needed"}</SecretOption>)}
        </select>
        <small>Existing conversations keep their original account.</small>
      </label>
      {!!status?.accounts.length && <label className="check">
        <SecretInput data-testid="claude-account-rotate" type="checkbox" disabled={off} checked={status.rotate} onChange={(event) => { const rotate = event.target.checked; void act("Updating rotation…", () => bridge.invoke("claudeAccounts:rotate", { rotate }), rotate ? "Rotation on." : "Rotation off."); }} />
        <span>Rotate when an account hits its usage limit<small> — the account sits out until its limit resets; a turn that had not started work retries on the next account</small></span>
      </label>}
      {!!status?.accounts.length && <ul className="claude-account-list" aria-label="Claude accounts">
        {status.accounts.map((account) => <li key={account.id} data-testid="claude-account-row">
          <div><strong>{account.label}</strong><small>{account.cooldownUntil ? `Usage limit until ${new Date(account.cooldownUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : account.detail}</small></div>
          <div className="connection-actions">
            {account.kind === "profile" && <button type="button" className="btn small" disabled={off} onClick={() => { let message = ""; void act("Complete sign-in in your browser, then return here. Waiting for Claude Code to confirm…", async () => { const reply = await bridge.invoke("claudeAccounts:login", { accountId: account.id }); message = reply.result.detail; return reply.status; }, () => message); }}>{account.signedIn ? "Sign in again" : "Sign in"}</button>}
            <button type="button" className="btn small ghost" disabled={off} onClick={() => { void act("Removing account…", () => bridge.invoke("claudeAccounts:remove", { accountId: account.id }), `Removed ${account.label}.`); }}>Remove</button>
          </div>
        </li>)}
      </ul>}
      {adding ? <form className="claude-account-form" data-testid="claude-account-form" onSubmit={(event) => {
        event.preventDefault();
        const name = label;
        void act("Saving account…", () => adding === "gateway" ? bridge.invoke("claudeAccounts:addGateway", { label: name, key, ...(model.trim() ? { model: model.trim() } : {}) }) : bridge.invoke("claudeAccounts:addProfile", { label: name }),
          adding === "gateway" ? `Saved ${name.trim()}. Its key is protected in OS storage; a completed turn verifies model access.` : `Added ${name.trim()}. Sign in to it next.`).then((saved) => { if (saved) resetForm(); });
      }}>
        <label className="field"><span>Name</span><SecretInput data-testid="claude-account-label" value={label} maxLength={80} placeholder={adding === "gateway" ? "OrcaRouter team key" : "Work Max plan"} onChange={(event) => setLabel(event.target.value)} spellCheck={false} /></label>
        {adding === "gateway" && <>
          <label className="field"><span>OrcaRouter key</span><SecretInput data-testid="claude-account-key" type="password" autoComplete="off" value={key} placeholder="sk-orca-…" onChange={(event) => setKey(event.target.value)} spellCheck={false} /></label>
          <label className="field"><span>Model (optional)</span><SecretInput data-testid="claude-account-model" value={model} placeholder="orcarouter/auto or anthropic/claude-opus-4.8" onChange={(event) => setModel(event.target.value)} spellCheck={false} /></label>
        </>}
        <div className="connection-actions">
          <button type="submit" className="btn small primary" disabled={off || !label.trim() || (adding === "gateway" && !key.trim())}>Save account</button>
          <button type="button" className="btn small ghost" disabled={busy} onClick={resetForm}>Cancel</button>
        </div>
      </form> : <div className="connection-actions">
        <button type="button" className="btn small" data-testid="claude-account-add-profile" disabled={off} onClick={() => setAdding("profile")}>Add Claude account</button>
        <button type="button" className="btn small" data-testid="claude-account-add-gateway" disabled={off || status?.available === false} onClick={() => setAdding("gateway")}>Add OrcaRouter key</button>
      </div>}
      <p className="connection-feedback" role="status" data-testid="claude-accounts-status">{detail || (failed ? "Account pool unavailable. Refresh to retry." : active ? `New conversations use ${active.label}.` : status?.detail ?? "Checking Claude accounts…")}</p>
    </div>
  );
}
