# CR-6 Phase 1 — native review isolation

Scope: [#325](https://github.com/TypeSafeAI/modex/issues/325), under [#319](https://github.com/TypeSafeAI/modex/issues/319). Owned worktree/branch `cr6-isolation`, based on main `203a3505bfa46b67ea4cb47254ece26ac0f2da88`. This PR adds reproducible proof tests and an investigation receipt; it does not enable review, PR questions or instructions. Both #393 and #395 were open at the dependency audit, so no Phase 2 context/UI integration was attempted. C82 remains unresolved.

## Result

Claude has a promising snapshot-only candidate with real native tool-router denials under a scripted local provider. Codex's built-in read-only profile is insufficient: it demonstrably permits shell execution, reading a synthetic credential outside the selected repository, and reading an inherited synthetic GH_TOKEN. A narrower Codex filesystem/network profile denies the tested outside reads, symlink escape, writes and network connect, but still permits shell execution. Neither result authorizes enabling the production feature. No authenticated provider inference was run; no real auth was supplied to any fixture.

The existing Modex launchers are ordinary coding backends, not a CR-6 isolation implementation. `backends/claude.ts` chat mode denies Edit/Write/NotebookEdit but retains other tools and inherited configuration. `backends/codex.ts` uses one shared app-server with per-thread sandbox/approval settings; `backends/health.ts` preserves the inherited environment unless its caller supplies another. `backends/account-codex.ts` also maintains shared account runtimes. The runner's human/rule approvals and event journal provide lifecycle and receipts, not an independent filesystem/tool boundary. Reuse those semantics later, without treating Chat mode or a denied approval as proof of complete confinement. Jev was not invoked or given context.

## Reproduce

Run `MODEX_CR6_NATIVE=1 pnpm --filter @modex/desktop test:review-isolation` on macOS with installed CLIs. Optional `MODEX_CR6_CODEX_BIN` and `MODEX_CR6_CLAUDE_BIN` select an explicit installed executable. Default `pnpm test` includes the suite with all five operational cases skipped unless explicitly enabled; skipped probes are not safety passes. Normal CI requires no provider credentials. The proof suite creates only disposable synthetic homes/repositories, fixture secrets and loopback listeners.

The receipt records binary/version, Darwin version and serialized Codex profiles for each applicable case. Claude resolves its installed binary once per suite and clones that exact executable into each disposable fixture before checking its version. Initial inspection found Claude 2.1.309; the installation changed during investigation, and the final suite exercised Claude 2.1.310 and codex-cli 0.164.0. Environment: macOS 27.0.1, Darwin 27.0.0, Node v24.22.0, pnpm 10.34.5. Results are tied to those observed versions, not all future versions or platforms.

## Evidence by boundary

| Boundary | Observed evidence | Scope and remaining gate |
| --- | --- | --- |
| Selected evidence remains usable | Codex profiles and Claude Read return the exact synthetic selected text | Plain text only; not arbitrary file parsers or production PR context |
| Worktree/outside writes | Both Codex profiles deny native touch and leave markers absent; the built-in profile also denies an overwrite of the existing selected file and preserves its bytes; Claude rejects injected Write and Bash as unavailable tools | Trusted CLI state still writes to its disposable home; no production launch claim |
| Arbitrary shell | Codex executes `/bin/sh` under both tested profiles; Claude's router rejects injected Bash and advertises exactly Read | Codex needs an independently verified tool-removal/deny boundary before use |
| Secret reads and symlinks | Built-in Codex profile reads the synthetic outside secret; snapshot profile denies it and its in-root symlink; Claude explicitly cites restricted working-directory policy for both | Tested synthetic paths only; not universal filesystem confinement |
| Inherited credentials | Codex can read an explicitly supplied synthetic GH_TOKEN even under the snapshot profile; a clean child environment has it unset | Environment allowlisting is a launcher obligation, not a sandbox property; no real credentials supplied |
| Hooks | Real Claude init-only positive control executes the fixture SessionStart hook; candidate with bare mode does not | Codex hook suppression and actual authenticated startup remain unproven |
| MCP | Real Claude positive control starts an explicitly configured fixture MCP command; candidate strict-empty config leaves its marker absent and injected MCP calls unavailable | Does not prove a future shared app-server's global MCP state is safe |
| Network writes | The identical Node socket program reaches a real listener before/after each Codex sandbox attempt; sandbox attempt returns EPERM, exit 7, and no bytes arrive | Only the tested direct IPv4 loopback path; not all transports |
| External tool request | Claude rejects injected WebFetch as unavailable and the local receiver sees only expected protocol POSTs | Provider transport itself must be allowed by a later authenticated launch design |

## Claude fixture and outer guard

`test/fixtures/code-review-native-isolation.mjs` is test infrastructure, not an application inference API. It returns deterministic Anthropic-protocol SSE data on an owned loopback port, deliberately including adversarial tool calls. The real installed Claude CLI decides whether to dispatch them; the server never fabricates permission refusals. The second request carries actual CLI tool results. Assertions require successful selected-file reading, specific unavailable-tool and restricted-path denial reasons, absent side-effect markers, and absence of the synthetic secret value. Synthetic response usage counters are not actual inference or charges.

The tested candidate uses bare mode, restricted mode, only Read, strict empty MCP configuration, disabled slash commands, dontAsk and no permission prompts. Hooks are supplied explicitly for the suppression test, and a project MCP file points to a fixture command. Separate positive controls prove both markers actually work before their absence is interpreted. The fixture caps provider rounds, response size, child output and process time; it kills only its own detached child process group and removes disposable files after setup failure or completion.

An outer Seatbelt profile allows the fixture port, denies other outbound IP destinations, denies reads/writes under the actual user home, and denies the named securityd/SecurityServer lookup services. The CLI binary is cloned into the disposable root so the guard need not grant access to its installed location in the real home. This guard protects the experiment; it is not installed in Modex and is not claimed as universal credential or process confinement. The fixture supplies a synthetic API key and synthetic GH_TOKEN only. Actual-home file and named credential-service restrictions are explicit profile rules; broader OS credential channels are not certified by these tests.

## Codex invocation and controls

Codex 0.164.0's sandbox utility requires a named permission profile. The earlier `sandbox macos` spelling treated macos as a command, and the legacy sandbox-mode-only invocation failed argument validation; neither is denial evidence. The committed suite supplies a disposable CODEX_HOME with an explicit built-in read-only extension and a separate snapshot profile using minimal runtime reads plus the selected repository and the exact test Node binary. OPENSSL_CONF points to /dev/null for the fixture child; without this the narrow profile prevented Node from loading its default OpenSSL configuration, an execution failure correctly rejected as network evidence.

Non-inference `codex features list` also advertised stable shell_tool, unified_exec, hooks and code_mode_host controls in the disposable configuration. Their presence is configuration inventory, not proof of tool suppression; these profiles do not test disabling them through the app-server.

The native network proof uses the same executable, script, environment and live receiver for the before/after positive controls and the sandboxed attempt. It requires the socket-level permission error and exact non-timeout exit; generic connection failure or timeout is insufficient. Codex warns that helper PATH aliases are not created inside the temporary CODEX_HOME; that warning is preserved and is not counted as a denial. These utility results do not certify the existing app-server launch, its hooks, its MCP tools or a model-selected tool palette.

## Negative controls and review

Three deliberately weakened test policies failed before restoration: snapshot read access changed to write (touch succeeded unexpectedly), snapshot network enabled (connect succeeded unexpectedly), and Claude restricted mode removed (the required restricted-path refusal was absent). The last is a reason-class control, not a claim that a secret leaked. All source was restored and the five-case suite passed afterward. Initial Claude init-only attempts under a network-only outer guard timed out during managed-settings retries; missing markers from those attempts remain unverified, not hook-denial evidence. The later local-provider fixture and stronger outer guard supplied the working controls.

Independent security review identified mismatched network executables, insufficient Claude experiment guarding, generic error assertions and late cleanup registration. The suite now uses matched network controls and explicit errno, a guarded disposable native CLI fixture, reason-specific assertions and immediate cleanup registration. Final independent review found no remaining important issues for this bounded Phase 1 publication. Raw original failures, negative controls and final receipts are retained outside the worktree under `/Users/buns/.codex/artifacts/modex-cr6-isolation/2026-10-23/`.

## Validation

`pnpm build` completed with exit 0 (the existing large-chunk advisory remains). `pnpm test` completed with exit 0: 2,016 passed and 21 skipped across the worktree, core, desktop, native/package, site and store suites. Five of those skips are the explicitly opt-in isolation probes; 16 are pre-existing environment gates. The separate final `MODEX_CR6_NATIVE=1 pnpm --filter @modex/desktop test:review-isolation` completed with exit 0: five passed, zero failed and zero skipped. No renderer or production behavior changed, so UI E2E was not required for this test/documentation-only slice. This is not real-app integration acceptance.

Final logs are `cr6-build.log`, `cr6-test.log` and `cr6-native-final.log` in the artifact directory above. Tested implementation source: `10326f2adf505cbb5e833c8f29a88c777ca60ff9` (signed). Subsequent receipt-only documentation does not change tested inputs.

## Sources and next action

Current primary references: [Codex permissions](https://learn.chatgpt.com/docs/permissions), [Codex approvals/security](https://learn.chatgpt.com/docs/agent-approvals-security), [Claude permission controls](https://code.claude.com/docs/en/permissions) and [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). Installed help and generated Codex app-server schemas were inspected separately from the observed enforcement tests. Documentation alone never grants support.

Next action after the producer PRs land: design and review a dedicated snapshot launch/context path around proven controls, reconcile exact native protocol capabilities, and repeat denial tests at that real application boundary. Keep CR-6 capabilities unavailable until then. A live authenticated canary requires separate explicit authorization and a cost limit; it must not be inferred from these local scripted protocol results. No merge, release, provider replay, findings publication or C82 decision is included.
