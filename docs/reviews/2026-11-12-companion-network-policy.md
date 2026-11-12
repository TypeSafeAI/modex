# Companion network policy and remaining acceptance (#109)

Val answered the outstanding VPN/bridge question on 2026-11-12: **keep the current private-IPv4 behavior**. Any non-internal interface with an IPv4 address in `10/8`, `172.16/12` or `192.168/16` remains eligible, including VPN tunnels and virtual bridges. Public, CGNAT (including `100.64/10`), link-local, internal and IPv6 addresses remain excluded. This records the decision; production filtering, address-bound listeners, pairing, discovery, certificate pinning and token rotation are unchanged.

The existing policy regression is renamed `private IPv4 VPN and virtual interfaces are supported while CGNAT is excluded`. Its assertions are unchanged: mocked `utun3` and `bridge100` private addresses are selected alongside the preferred `en0`, while the CGNAT tunnel address is excluded. This test proves selection, not physical phone connectivity. The separate socket and lifecycle tests prove listener isolation, occupied-port recovery, unaffected sockets, and revocation/stop during interface changes.

The [2026-10-28 evidence map and physical procedure](2026-10-28-companion-two-lan-acceptance.md) remains the acceptance checklist. That work landed in PR #421 (`aa2275347d5c38cf46ffd3859f01b0e695e7e073`); it is no longer an unmerged prerequisite. The listener infrastructure comes from #166, and the revocation regression shape credits @Yash990-bit's #124 work. The rejected wildcard binding is not restored.

## Fresh verification

Audit base: main `8059acc767edebc26a8c152a2522e607436b1e8c`. Build and typechecks pass. All 30 focused companion server/network/discovery tests pass, with zero skips; the real-LAN cases ran. Both desktop pairing UI cases pass. The complete local `pnpm test` suite passes 2,530 cases with 36 explicit skips, zero failures and zero cancellations. The policy assertions and all production source are unchanged. The existing test name/comment records the decision; the CI delivery adjustment below changes only the overall job budget. After renaming, the main build and all 30 focused companion cases pass again with zero skips or failures.

## Physical gate remains open

Val also confirmed on 2026-11-12 that the physical test cannot run now. Read-only inventory found one active supported private LAN and no available physical iPhone. The installed Mac app reports Modex 0.4.2 on macOS 27.2.1; this inventory does not prove that installed build passed any acceptance row. No network settings, saved pairing, installed app or physical device were changed by this audit.

Rows 1–7 of the two-LAN procedure remain unrun: two-network presentation, QR pairing from the isolated secondary LAN, Bonjour recovery across a port change, primary-interface removal, secondary DHCP change, Forget during recovery, and Turn off during recovery. Row 8 now has a settled expected policy but remains physically unrun. Socket, UI, simulator and hosted CI success do not replace those observations. Keep #109 open until the physical results identify the Mac/phone app versions, subnet roles, date and outcome for each row.

## Hosted delivery budget

The signed policy candidate `9bccbf1` passed its PR build, unit coverage, 523 desktop UI cases (eight explicit skips), seven site cases and the iPhone paired workflow. Two later queue candidates hit the overall 45-minute job limit: `a0ad2ed` reached desktop case 532 of 533 without a reported assertion failure; `c1dbbd0` reached case 467 of 531 after a separate Markdown keyboard Copy assertion failed. Both cancellations remain failed qualification attempts. They used the same macOS arm64 image as the green PR run, but coverage took 6–7 minutes instead of three and median completed UI-case time rose from 2.3 seconds to 3.5–4.0 seconds.

The required macOS job budget is increased from 45 to 60 minutes so the full test sequence, site checks and evidence uploads can finish on slower runners. Test membership, individual test timeouts, assertions, worker count, required check name, signatures and merge-queue rules are unchanged. This is a bounded delivery adjustment, not a companion runtime fix.

The Markdown renderer, its test and test support were byte-identical between the green reviewed head and the failed queue candidate. Three complete local repetitions passed all 18 rendering cases. A separate disposable probe also passed every theme/size keyboard Copy check with the native window inactive, so that hypothesis did not reproduce the failure. Its hosted cause remains unproven; no renderer or assertion change is justified by this evidence, and it must pass in the subsequent hosted qualification. No physical acceptance row is advanced by any of these runs.

The unchanged manual retry `2e4189a` later passed workflow `43228696768`: 523 desktop UI cases with eight explicit skips, eight site cases and four web cases. Its renderer/test source remained identical to `c1dbbd0`. The run took about 43 minutes and had already been superseded by another queue candidate after an upstream entry changed, so it is retained as a green runtime receipt rather than current merge acceptance. The new signed job-budget head still requires its own protected PR and queue checks.
