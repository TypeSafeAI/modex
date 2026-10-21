# Live smoke acceptance through the app, 2026-10-19

Part of [#281](https://github.com/TypeSafeAI/modex/issues/281) (CF-8), tracker
[#273](https://github.com/TypeSafeAI/modex/issues/273). Val authorized one short, benign live run per CLI
on the signed-in accounts on 2026-10-19.

`e2e/live-smoke.spec.ts` drives the real app, main process and native adapter. It is opt-in
(`MODEX_LIVE_SMOKE=1`) because it spends real usage, so CI skips it. To run it:

```sh
env -u CLAUDECODE <other CLAUDE_* vars> MODEX_LIVE_SMOKE=1 MODEX_LIVE_BACKENDS=claude,codex \
  MODEX_LIVE_REPORT=/tmp/live npx playwright test e2e/live-smoke.spec.ts --workers=1
```

Each scenario runs in a disposable repository with `greeting.txt` = `hello`, in agent mode, and
approves any card the CLI asks for. It has three parts:

1. **Edit and check.** "Replace hello with hello, live, then run `grep -q 'hello, live' greeting.txt`
   and report its exit code." It asserts the file's bytes, a tool item for the check with outcome
   `succeeded` (and exit code 0 for Codex, which reports one), an assistant answer, and no failure
   card.
2. **Stop mid-command.** "Run `python3 -c "import time; time.sleep(30); open('live-stop.txt', 'w')"`."
   Two seconds after the call starts, the test presses Stop. It asserts the thread is idle, the
   call is `done` and not succeeded, and, 31 seconds later, that `live-stop.txt` was never written.
3. **Codex only: one web search.** The search result's shape (keys only) is read from Codex's own
   session record, for CF-5's structured web-search item.

A turn the CLI refuses settles with the thread in `error`. The report records the failure card's
code, its summary and the CLI's own message.

## Claude Code 2.1.304 (`claude -p`, Haiku): passed

| Step | Observed |
| --- | --- |
| Edit and check | `$ cat greeting.txt` succeeded; `Edit` of `greeting.txt` succeeded; `$ grep -q 'hello, live' greeting.txt` succeeded. The file reads `hello, live`. There were no approval cards: agent mode allowed the edit and both commands. |
| Final answer | One assistant item with phase `unspecified`. Claude Code reports no message phase, so Modex claims none (CF-1). There was one reasoning item, with outcome `succeeded`. |
| Stop mid-command | The thread was idle 2.4 s after Stop. The call ended `interrupted`. The notice says "Stopped. Claude did not end the turn within 1.5 s of the interrupt, so Modex terminated it." (CF-2's bounded exit). No failure card. `live-stop.txt` was never written. |

## codex-cli 0.163.0 (`codex app-server`, ChatGPT account, model `gpt-6-astra`)

### 2026-10-19: refused by the account

Codex ended the turn after 3.1 s, before any model output or tool call. Its session record's
`task_complete` carries `codex_error_info: "usage_limit_exceeded"`, and
`token_count.rate_limits.credits` shows `has_credits: false, balance: "0"`. Modex showed one failure
card: code `rate_limited`, the summary "Codex is rate-limited or out of quota.", and the CLI's
message verbatim ("You've hit your usage limit. … try again at Oct 25th, 2026 9:35 AM."). Nothing was
edited and nothing ran. That was correct behaviour, not a Modex defect.

### 2026-10-20, 07:44Z, after Val added credits: Stop claimed a stop that did not happen

| Step | Observed |
| --- | --- |
| Edit and check | A commentary message, then `apply_patch` on `greeting.txt` succeeded, and `$ grep -q 'hello, live' greeting.txt` succeeded with exit code 0. The final answer has phase `final`. There were no approval cards. |
| Stop mid-command | **Failed.** The thread was idle 1.6 s after Stop, and the call read `done` with outcome `interrupted`, but `live-stop.txt` was written 30 s later. |

The cause is in Codex's session record. With `unified_exec` on (stable and enabled in 0.163.0),
Codex ran the command through its code-mode `exec` tool as
`tools.exec_command({ cmd, yield_time_ms: 1000 })`. After one second the call returned
`session_id: 63519`, and the process went on in a **background terminal**. Stop's `turn/interrupt`
ended the turn (`turn_aborted`, reason `interrupted`), but Codex does not end background terminals
when a turn is interrupted. Codex never completed the command item, and Modex closed the open item
as `interrupted` with no evidence that the process had ended.

**Fix (this PR):**
- Modex opts into the app-server's experimental methods (`capabilities.experimentalApi`).
- When Codex reports a turn interrupted with commands still open, Modex lists the thread's
  background terminals (`thread/backgroundTerminals/list`). It terminates those started by this
  turn's own commands (`…/terminate`), never an earlier turn's, such as a dev server.
- Modex then lists the terminals again. A command reads `interrupted` only once Codex no longer lists
  it. Anything Codex cannot confirm, including an older CLI without these methods, reads `unknown`,
  with a notice that it may still be running.

### 2026-10-20, 07:54Z, with the fix: passed

| Step | Observed |
| --- | --- |
| Edit and check | As above: commentary, then `apply_patch` succeeded and the check succeeded with exit code 0. The final answer has phase `final`. |
| Stop mid-command | Codex again moved the command to a background terminal (`session_id: 84807`) after 1 s. The thread was idle 99 ms after Stop. The call ended `interrupted`, the notice reads "Stopped.", and there was no failure card. **`live-stop.txt` was never written**, checked 31 s later. |
| Web search | One `webSearch` item, outcome `succeeded`, but its title is "search " with no query (see below). |

**Web search is not structured yet (CF-5).** Codex 0.163.0 ran the search inside the code-mode
`exec` tool (`tools.web__run({ search_query: [{ q }] })`), so the session record has no
`web_search_call` item and the spec's rollout shape is `null`. The app-server's `webSearch` item can
carry `query`, an `action` (`search` with `query`/`queries`, `openPage` with `url`, `findInPage`)
and opaque `results`. Modex read only `query`, at `item/started`, where it was empty.

**Follow-up, 08:57Z.** With Val's approval, one more small live turn captured the app-server's own
`webSearch` notifications. They are in `test/fixtures/codex-websearch-0.163.0.json` and the
[evidence guide](../conversation-evidence.md#what-each-cli-provides). The completed item carries the
query, the action and `text_result` entries with a title, URL, domain and snippet. Modex now shows
those as the search's results (CF-5).

## Not covered here

- A native question card and live plugin generation (CF-3 and CF-7 live paths).
- Paired-client recovery on live providers.
- Windows and Linux.

These stay unverified live, as #281 asks. Human keyboard and VoiceOver review is a separate,
human-only gate.
