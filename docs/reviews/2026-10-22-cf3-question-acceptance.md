# CF-3: human acceptance for a native question

Steps for Val to accept a native Codex question in the real app, on the Mac and on the iPhone. They
are the CF-3 rows of [#281](https://github.com/TypeSafeAI/modex/issues/281)'s checklist (CF-8), from
[#276](https://github.com/TypeSafeAI/modex/issues/276). Automated coverage is listed in
[human-requests.md](../human-requests.md#tests); these steps are what it cannot prove: a real
model, keyboard-only use, VoiceOver, and a physical phone.

Record for each run: the Modex build (commit or version), `codex --version`, the Codex model, the
Companion build, the iPhone model and iOS version, the date, and pass/fail per step with a note or
screenshot. Leave a step unticked, with the reason, if it cannot be run.

## Setup

1. Install the candidate Modex build. For step D4, start it with the event journal on
   (`MODEX_EVENT_JOURNAL=1 open -a Modex`, as in [event-journal.md](../event-journal.md)), and note
   whether it was on.
2. Make Codex offer its question tool on an ordinary turn:
   `codex features enable default_mode_request_user_input`. It is under development and off by
   default, so turn it off again after the run (`codex features disable default_mode_request_user_input`).
   Use a thread on the Codex CLI account. An app-owned ChatGPT account runs Codex with its own
   `CODEX_HOME`, which this setting does not reach. If Plan mode later switches to Codex's native plan
   mode ([decision](2026-10-22-cf3-plan-mode-decision.md)), a Plan turn needs no flag.
3. Open a disposable project (an empty git repository is enough), on the Read only sandbox.
4. For the phone steps: a Companion build containing the native question card (built from the PR
   that adds it, and uploaded to TestFlight by Val), paired with this Mac.

**A prompt that asks.** In a new Codex thread:

> Before doing anything, use your question tool to ask me two questions in one request: which
> environment to target (options: staging, production; other answers allowed), and a deploy token
> (a secret). Then reply with only the environment I chose and the number of characters in the token.

If Codex answers in prose instead of showing a card, note the codex-cli version and the run's rollout
(the #348 capture saw a `request_user_input_async` form without the flag), and stop: that is a
capability gap, not a failed acceptance.

## Desktop, keyboard only

Use only the keyboard from the composer onwards; no pointer.

- [ ] **D1. The card is reachable and labelled.** While the question waits:
  - the turn header reads "Waiting for your answer";
  - Tab reaches the card's first control;
  - the options are radio buttons, with arrow keys moving between them;
  - the token field is a password field that shows bullets.
- [ ] **D2. An incomplete answer is refused in place.** Choose an environment, leave the token empty
  and submit. The card says the token needs an answer, focus stays on the card, and the agent hears
  nothing (the thread is still waiting).
- [ ] **D3. Drafts survive navigation.** Type part of the token, switch to another thread with the
  keyboard, and come back. The choice and the text are still there.
- [ ] **D4. Submit.** Finish the token with a leading and a trailing space, then submit from the
  keyboard. The card closes as answered, the token shows "(hidden)", and the model's reply gives the
  environment and the exact character count, spaces included.
  - With the journal on, search the Modex home directory for the token:
    `grep -ra "<token>" ~/.modex` (or `$MODEX_HOME`). Nothing matches.
- [ ] **D5. Stop withdraws.** Ask again, then press Stop while the card waits. The card reads
  "not answered" with no controls, and nothing more reaches Codex.

## Desktop, VoiceOver

Turn VoiceOver on (⌘F5) and repeat D1, D2 and D4 by VoiceOver navigation.

- [ ] **V1.** The card is announced as a question. Each question's header and text are read before
  its controls. Each option is read with its description and its selected state. The token field is
  announced as a secure text field.
- [ ] **V2.** The refusal in D2 is announced, or reachable right after submitting, without a pointer.
- [ ] **V3.** The answered card announces its answers with the token as "hidden", and never reads
  the token aloud.

## iPhone

- [ ] **P1. A native card, not a notice.** Open the waiting thread on the phone. The question shows
  as a card with option rows, an Other row, and a secure token field, not as "Answer it in Modex on
  your Mac."
- [ ] **P2. An incomplete answer.** Tap Send answer with nothing chosen. The card says the first
  question "needs an answer", in the question's own header; the Mac's card is still open.
- [ ] **P3. Answer from the phone.** Choose staging, type a token, and send. The phone's card reads
  "Answered on your phone" with the token "(hidden)". The Mac's card shows "Answered on your phone."
  The model's reply is right.
- [ ] **P4. The other client won.** Ask again. Answer on the Mac first, then send from the phone. The
  phone shows "This question was already answered." and its card rereads as answered on the Mac.
  The model replies once, with the Mac's answer.
- [ ] **P5. VoiceOver on the phone.** With VoiceOver on, each option is read with its description and
  selected state, the token field is read as secure, and Send answer is reachable by swiping.
- [ ] **P6. Older phone.** If an older Companion (0.3.0 (8) or earlier) is at hand, its view of the
  same question is the text notice, with no buttons.

## After the run

- Turn the Codex feature off again: `codex features disable default_mode_request_user_input`.
- Attach the record to #281's CF-3 rows and to #276. Leave failed or unrun steps open with the next
  action.
