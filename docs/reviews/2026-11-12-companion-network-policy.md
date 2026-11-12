# Companion network policy and remaining acceptance (#109)

Val answered the outstanding VPN/bridge question on 2026-11-12: **keep the current private-IPv4 behavior**. Any non-internal interface with an IPv4 address in `10/8`, `172.16/12` or `192.168/16` remains eligible, including VPN tunnels and virtual bridges. Public, CGNAT (including `100.64/10`), link-local, internal and IPv6 addresses remain excluded. This records the decision; production filtering, address-bound listeners, pairing, discovery, certificate pinning and token rotation are unchanged.

The existing policy regression is renamed `private IPv4 VPN and virtual interfaces are supported while CGNAT is excluded`. Its assertions are unchanged: mocked `utun3` and `bridge100` private addresses are selected alongside the preferred `en0`, while the CGNAT tunnel address is excluded. This test proves selection, not physical phone connectivity. The separate socket and lifecycle tests prove listener isolation, occupied-port recovery, unaffected sockets, and revocation/stop during interface changes.

The [2026-10-28 evidence map and physical procedure](2026-10-28-companion-two-lan-acceptance.md) remains the acceptance checklist. That work landed in PR #421 (`aa2275347d5c38cf46ffd3859f01b0e695e7e073`); it is no longer an unmerged prerequisite. The listener infrastructure comes from #166, and the revocation regression shape credits @Yash990-bit's #124 work. The rejected wildcard binding is not restored.

## Fresh verification

Audit base: main `8059acc767edebc26a8c152a2522e607436b1e8c`. Build and typechecks pass. All 30 focused companion server/network/discovery tests pass, with zero skips; the real-LAN cases ran. Both desktop pairing UI cases pass. The complete local `pnpm test` suite passes 2,530 cases with 36 explicit skips, zero failures and zero cancellations. This increment changes only the existing test name/comment and documentation; the policy assertions and all production source are unchanged. After renaming, the main build and all 30 focused companion cases pass again with zero skips or failures.

## Physical gate remains open

Val also confirmed on 2026-11-12 that the physical test cannot run now. Read-only inventory found one active supported private LAN and no available physical iPhone. The installed Mac app reports Modex 0.4.2 on macOS 27.2.1; this inventory does not prove that installed build passed any acceptance row. No network settings, saved pairing, installed app or physical device were changed by this audit.

Rows 1–7 of the two-LAN procedure remain unrun: two-network presentation, QR pairing from the isolated secondary LAN, Bonjour recovery across a port change, primary-interface removal, secondary DHCP change, Forget during recovery, and Turn off during recovery. Row 8 now has a settled expected policy but remains physically unrun. Socket, UI, simulator and hosted CI success do not replace those observations. Keep #109 open until the physical results identify the Mac/phone app versions, subnet roles, date and outcome for each row.
