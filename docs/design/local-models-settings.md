# Settings → Local models: design brief for LM-4 (#381)

Status: partially implemented on protected main through #498, #499, #502 and #503, checked 2026-11-12. Settings connection management, metadata discovery, model-menu filtering and draft/focus preservation are implemented. The explicit selected-model native compatibility test and configuration-bound qualification-result workflow remain unimplemented; the qualification labels below describe the required design, not a currently available tested state. Product execution remains unadmitted. The original 2026-11-03 brief was written against `b785054`; its [decision record](../reviews/2026-11-03-lm5-val-decision.md) remains dated history.

## What a person can do

1. In Settings, add a local server by name, kind and address, with an optional token.
2. See whether that server answers, and which models it lists.
3. Pick a model on a thread from the existing model menu, and see plainly where the turn will run.

## Constraints from the producers

- **One channel.** Everything goes through `local-models:command`. It's `localOnly`, so paired clients can't reach it.
- **No secrets in the renderer.** `LocalConnectionView.credential` says only `present` and `storage`. A token field is write-only: it never shows a saved value or its last characters.
- **Identity.** A target is `{connection id, revision, exact model ID}`. The same ID on two connections, or two revisions, is two targets. Show IDs exactly; never normalize them.
- **Discovery only reads.** Opening Settings or refreshing never starts inference, installs anything or downloads weights.
- **Revisions move.** Any edit to the kind, address or token bumps the revision. A thread on the old revision then refuses to run until the person selects again, and the UI must say so rather than rebinding it.
- **Selection is main's.** Only this Mac's window may select, change or clear a target. `LocalExecution.validate` decides; the UI shows its refusal text, and never hides or works around it.
- **Execution still needs admission.** Until it lands, `updateThread` throws `Local execution is unavailable.` Show that as a clear notice.

## Settings section

Add a `Local models` entry to the `sections` list in `SettingsDialog.tsx`, using the same `settings-section` structure as the others. Show no onboarding panel and no install prompts.

Each connection is a row: name, kind, address, token saved or not, health and last checked time. Its controls are Check models, Edit and Remove. The form asks for name, kind (Ollama, LM Studio, Compatible server), address, token and extra model IDs. Show main's validation text under the field it concerns, and keep what was typed when a save fails.

Removing asks for confirmation, and is refused while a live run depends on the connection. Say that past conversations stay readable.

### States

Keep **connection health** and **model status** as separate columns of meaning. A reachable server says nothing about whether a model can code.

| `DiscoveryResult` | Shown as |
| --- | --- |
| In flight | "Checking…" with a Cancel control (`op: "cancel"`) |
| `ready`, models | "Answered" with the time, and the list |
| `ready`, no models | "Answered: no models listed. You can type a model ID." |
| `ready`, `truncated` | The list, and "Only the first models are shown." |
| `unavailable: unauthorized` | "The server refused the saved token." |
| `unavailable: timeout` | "The server didn't answer in time." |
| `unavailable`, other reasons | main's `detail` text |
| `stale` | Nothing: drop the answer and keep the current view |

`credentialUnavailable` gets its own message: Modex can't read the saved token, so it sent nothing. Never show a saved list as current after a failed check; label it with the last checked time.

### Model rows

Each row shows the exact ID, where it came from (listed or typed), kind, installed and loaded (showing "unknown" when the server doesn't say), and advertised context. `advertised` capabilities read as "the server says", never as tested.

Rows with `selectable: false` stay visible but can't be chosen, and show why: "Served by a cloud service", "Embedding model" or "Doesn't generate text".

Qualification has three distinct labels: Unverified, Tested for this configuration, and Unsupported. Only a recorded `capabilityStatus` result can show the second one. Never derive it from a greeting or an advertised capability.

## Model menu and thread

Extend `ModelMenu.tsx`: local models in a group per connection, with search and a typed-ID entry. Choosing one sends `localTarget` and `localContextTokens` through `thread:update`. A context window is required, between 4,096 and 262,144 tokens, and no more than the advertised maximum.

While a target is set:
- Show **where it runs** apart from the Local/Worktree workspace choice and the harness name, for example "Runs on: Local server “Ollama” (127.0.0.1:11434), via Codex".
- Hide or disable Auto, Plan, effort, fast mode and images, with the reason. Block an image attachment before sending; don't drop it.

**Wording.** Never say "private", "offline" or "on this Mac" for a loopback address: the server may forward requests, and Codex follows a 307 with the full request body. Use "local server" and, where it matters: "Modex sends this to the address you set. It can't verify what that server does with it."

**Cold load (LM-2 step 6).** Beside the model list: "Checking models doesn't load anything. Your first message may make the server load the model, which can take a while and use a lot of memory."

## Delivered policy controls

- **Clearing to cloud.** The delivered UI asks for confirmation naming the cloud model. This is an explicit destination change; it does not admit local execution.
- **Remote clients.** Main refuses phone and paired-desktop sends on local threads, and only this Mac’s window may choose, change or clear the target. Complete paired host/model presentation and older-client acceptance remain separate requirements; they are not established by this send refusal.

## Tests

- Unit: a view reducer for every state above, including a delayed refresh after an edit, which must not appear current.
- Real Electron: add, check, select and refuse through actual controls, against a loopback fixture server, with exact request counts proving no inference. Check keyboard and minimum-window flows, and capture both themes.
- Drafts, attachments and focus survive a thread switch during a delayed refresh, and the model or address never changes silently.
- Human screen-reader checks are recorded separately and are Val's.

AC1 of #381, a real local task through the UI, needs admission and an installed model.

## Reference only

Closed #407 (`strata-integration`, pushed head `1285012`) has a `LocalModelControls.tsx` prototype. Its local worktree has another owner: read the diff on GitHub rather than resuming it.
