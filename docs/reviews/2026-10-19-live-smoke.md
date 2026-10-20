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

## codex-cli 0.163.0 (`codex app-server`, ChatGPT account, model `gpt-6-astra`): refused by the account

| Step | Observed |
| --- | --- |
| Account | `codex login status`: "Logged in using ChatGPT" |
| Edit and check | Codex ended the turn after 3.1 s, before any model output or tool call. Its session record's `task_complete` carries `codex_error_info: "usage_limit_exceeded"`, and `token_count.rate_limits.credits` shows `has_credits: false, balance: "0"`. |
| What Modex showed | One failure card: code `rate_limited`, the summary "Codex is rate-limited or out of quota.", and the CLI's message verbatim: "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 25th, 2026 9:35 AM." The thread is in `error`. Nothing was edited and nothing ran. |
| Stop and web search | Not reached. |

**Live Codex acceptance is blocked by the account's usage limit until 2026-10-25 09:35**, or until credits
are added. It is not a Modex defect. What Modex did is correct: the refusal is classified, the CLI's
words are kept, and nothing runs. Rerun the Codex scenario after that time, with
`MODEX_LIVE_BACKENDS=codex`. CF-5's structured web-search result waits for the same run.

## Not covered here

- A native question card and live plugin generation (CF-3 and CF-7 live paths).
- Paired-client recovery on live providers.
- Windows and Linux.

These stay unverified live, as #281 asks. Human keyboard and VoiceOver review is a separate,
human-only gate.
