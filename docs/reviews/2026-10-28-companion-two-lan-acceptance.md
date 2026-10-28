# Companion on two LANs: evidence map and physical acceptance (#109)

Base: `main` at `6c9000f` (includes `203a350`). Branch `companion-109-evidence`. This increment adds
evidence only: two regression tests, one policy-pinning test, this procedure, and the question to
Val below. It changes no production code, address policy, pairing or authentication.

The listener and lifecycle test infrastructure comes from #166. The in-flight revocation cases
reuse the shape of @Yash990-bit's #124 regression work (revoke while a request is mid-body, then
assert the old token is refused), which #109 credits; #124's wildcard binding itself was not
merged and is not reintroduced here. The #406 revocation-during-rebind test is the base for the
new race tests.

## The four requirements and what each test proves

All automated tests below run on this Mac with a real LAN address, so the LAN-gated cases ran,
not skipped. They prove behaviour over real sockets on one Mac. They do not prove reachability
from a phone on a second physical LAN; that is the procedure further down.

### 1. Bind only the supported local addresses

| Test | File | Proves |
| --- | --- | --- |
| `supported address selection excludes public, CGNAT, link-local, internal and IPv6 addresses` | `companion-network.test.ts` | With mocked `os.networkInterfaces`, selection keeps `10/8`, `192.168/16` and `172.16/12` and drops `8.8.8.8`, `100.64/10`, `169.254/16`, `172.32.x`, loopback and IPv6. `en0` ranks first. |
| `the production listener never accepts the excluded loopback endpoint` | `companion-network.test.ts` | With the real address filter, the LAN listener answers and the same port on `127.0.0.1` refuses the connection: there is no wildcard socket. |
| `a VPN or virtual interface with a private address currently gets a listener (policy pending on #109)` | `companion-network.test.ts` (new) | Pins today's policy: `utun3` with `10.8.0.2` and `bridge100` with `10.211.55.2` are selected beside `en0`; a Tailscale-style `utun1` with `100.108.0.2` is not. A decision on the question below flips this test red before the filter changes. |

Limit: the filter is by address range only. Whether VPN tunnels and virtual bridges should get a
listener is [asked of Val on #109](https://github.com/TypeSafeAI/modex/issues/109#issuecomment-6464762470).

### 2. A reachable endpoint per network, pinned certificate, no credentials in Bonjour

| Test | File | Proves |
| --- | --- | --- |
| `each supported address has a reachable advertised listener; removing one preserves the other connection` | `companion-network.test.ts` | Loopback and the LAN address each get a listener and an advertisement; the LAN endpoint answers a pinned-certificate request with the advertised fingerprint; the advertisements never contain the token. |
| `companion preserves pairing across offline startup, network recovery and port changes` | `companion.test.ts` | After an offline launch and a port move, the advertised port matches the new listener and the advertisement never contains the token. |
| `pairing network selection keeps each QR and copied link together across revocation and address removal` | `e2e/companion.spec.ts` | The Mac UI offers one QR and copied link per address, and keeps them paired with their address through revocation and removal. UI state only. |
| `testDiscoveryAcceptsOnlyLocalEndpointsForTheSavedIdentity`, `testUnverifiedDiscoveredAddressCannotReplaceSavedPairing`, `testDiscoveryTriesEachAddressAndAlternatesTheSavedEndpoint`, `testDiscoveryKeepsABoundedFairRotationDespiteDuplicateAdvertisements` | `apps/ios/ModexCompanion/Tests` | The phone treats discovery as untrusted candidates, accepts only private IPv4 HTTPS endpoints, verifies the pinned certificate before adopting an address, and rotates through every advertised address so one unreachable network cannot hide another. |

Limit: the phone-side tests are model tests against a fixture, and the simulator LAN run uses one
LAN. Pairing by QR and by Bonjour from a phone on a second subnet is the physical gate.

### 3. Keep token and certificate; tear down only affected interfaces; DHCP, offline, occupied ports, stop and revoke races

| Test | File | Proves |
| --- | --- | --- |
| `each supported address has a reachable advertised listener; removing one preserves the other connection` | `companion-network.test.ts` | Removing the preferred address keeps the established keep-alive socket on the other address (same socket object), the token and the fingerprint; the removed endpoint refuses; the address returning adds only the missing listener. |
| `a failed address does not prevent a healthy address from starting or recovering` | `companion-network.test.ts` | A bind failure on one address (`192.0.2.1`) leaves the other listening, at start and on refresh. |
| `an occupied port on a new interface does not move or disconnect the existing interface` | `companion-network.test.ts` | A new address whose preferred port is taken gets another port; the existing listener keeps its port and socket. |
| `companion preserves pairing across offline startup, network recovery and port changes` | `companion.test.ts` | No interfaces at launch is a recoverable outage; the token and certificate survive network recovery and a port change. Revocation replaces the token, and the replacement survives a server restart; Turn off survives a refresh. |
| `stop wins while adding another listener`, `dispose wins while adding another listener` | `companion-network.test.ts` | A socket that is bound but not yet published when Turn off or quit runs is closed, never published, and a later refresh adds nothing. |
| `stop cancels companion startup before it finishes listening` (stop, dispose) | `companion.test.ts` | Turn off during the first start leaves the service disabled. |
| `shutdown closes a TCP socket that has not completed TLS`, `dispose does not wait for a connection that never finished its TLS handshake` | both | Half-open sockets do not hold Turn off. |
| `revoking access during a DHCP rebind rejects the old token on the replacement listener` (#406) | `companion-network.test.ts` | Forget paired phones while the replacement socket is bound but unpublished: the replacement refuses the old token and accepts the new one with the same certificate. |
| `the interface list changes while resetAccess runs: no listener survives with the old token` (new) | `companion-network.test.ts` | A removed listener is still closing when Forget paired phones runs and the removed interface returns. The kept interface refuses the old token on its unchanged socket and accepts the new one; after the next reconcile both endpoints carry only the new token. |
| `the interface list changes while stop runs: no listener survives with the old token` (new) | `companion-network.test.ts` | The same mid-close window with Turn off: both endpoints refuse connections, nothing is advertised, and a later monitor tick with the returned interface does not re-enable the listener. |

### 4. Allowed and excluded interface behaviour, secondary-LAN discovery end to end

Allowed and excluded interfaces are covered under 1 and 3 with mocked interfaces and real sockets.
Secondary-LAN discovery end to end has no automated proof and gets the physical procedure below.

## Red/green for the new race tests

The tests pass against current production code. Each was shown to fail against a deliberate
mutation of the generated JavaScript only (`dist/src/main/engine/companion.js`), restored and
confirmed byte-identical afterwards. No production change was made, because neither mutation
reflects a defect in `main`.

| Mutation | Test | Failure |
| --- | --- | --- |
| `resetAccess` skips the token rotation while a reconcile is in flight | `…while resetAccess runs…` | `Expected "actual" to be strictly unequal` at the rotated-token check |
| `dispose` leaves live listeners to the in-flight reconcile | `…while stop runs…` | `published.size` was `1`, expected `0` (a listener survived Turn off) |

Raw logs are kept outside the worktree under `Documents/Codex/artifacts/modex-109-evidence/2026-10-28/mutation-{a,b}.log`.

## Physical acceptance procedure for Val

Do this on a Mac with two private LANs on different subnets, for example Ethernet on one
router and Wi-Fi on another, or Wi-Fi plus a second router on Ethernet. The phone joins only the
secondary LAN (the one that is not `en0`). Record the versions and results in the table at the
end. Do not record pairing tokens, QR payloads, certificate keys or raw diagnostics.

Before starting, on the Mac:

```sh
sw_vers
networksetup -listallhardwareports
ifconfig | grep "inet "
```

Note which interface is primary (`en0`, usually Wi-Fi) and which is secondary, and the subnet
of each as a label such as `A: 192.168.1/24`, `B: 10.0.0/24`. Confirm the phone is on B and
cannot reach A (the two routers are not bridged).

1. **Turn on with two networks.** Open iPhone companion, Turn on companion. Mac network must
   list both addresses. Expected: one QR and copied link per address, both with the same
   certificate fingerprint. Pick the B address.
2. **Pair by QR on the secondary LAN.** On a phone with no saved Mac, scan the B QR. Expected:
   projects and a thread load; the pairing is saved. Reading the A QR instead from the phone on
   B must fail to connect (no route), proving B was the endpoint used.
3. **Recover by Bonjour on the secondary LAN.** Force-quit and relaunch the phone app. Expected:
   it reconnects to the B address without rescanning. Then, in the Mac app, Turn off and Turn
   on again so the port may change, and relaunch the phone. Expected: it finds the Mac again
   through Bonjour and connects on B with the original pinned certificate.
4. **Primary LAN change.** Disconnect or renew the A interface (unplug Ethernet, or Wi-Fi off
   and on) while B stays up and the phone shows a thread. Expected: the phone keeps working or
   reconnects within seconds without re-pairing; the Mac's Mac network list drops and restores A;
   the B QR and link are unchanged.
5. **Secondary LAN DHCP change.** Change the Mac's B address (renew the DHCP lease with a
   different reservation, or set a different manual address in the same subnet, then back to
   DHCP). Expected: the Mac shows the new B address with the same fingerprint; the phone
   recovers through Bonjour without rescanning and without accepting a different certificate.
6. **Forget during recovery.** Repeat the B address change, and while the phone is reconnecting
   choose Forget paired phones. Expected: the phone loses access and cannot regain it by
   relaunching or discovery; scanning the new B QR pairs again.
7. **Turn off during recovery.** Repeat the B address change, and while the phone is
   reconnecting choose Turn off. Expected: no endpoint answers on A or B until Turn on; after
   Turn on the saved pairing works again without rescanning.
8. **Excluded interfaces.** If the Mac has a VPN (`utun`) or a virtual bridge up during the
   test, note whether Mac network lists its address. That is the policy question on #109 and
   is recorded, not judged, here.

| Acceptance | Result | Versions and evidence |
| --- | --- | --- |
| 1. Two addresses listed, one QR and link each | Pending Val | |
| 2. Pair by QR on the secondary LAN | Pending Val | |
| 3. Recover by Bonjour on the secondary LAN, across a port change | Pending Val | |
| 4. Primary LAN change leaves the secondary connection alone | Pending Val | |
| 5. Secondary LAN DHCP change recovers without rescanning | Pending Val | |
| 6. Forget paired phones during recovery revokes, rescan pairs | Pending Val | |
| 7. Turn off during recovery silences both LANs, Turn on restores | Pending Val | |
| 8. VPN or bridge interfaces listed (policy, see question) | Pending Val | |

Record: macOS version, Modex version and commit, Companion version and build, interface roles,
subnet labels, date.

## Verification of this increment

`pnpm build && pnpm test` on this Mac (macOS 27.0.1, Node 24.22.0), exit 0:

| Suite | Tests | Passed | Skipped |
| --- | --- | --- | --- |
| worktree scripts | 117 | 117 | 0 |
| core | 16 | 16 | 0 |
| desktop | 2012 | 1995 | 17 |
| desktop native | 26 | 21 | 5 |
| site | 10 | 10 | 0 |
| store-desktop | 16 | 16 | 0 |

The three new tests ran and passed; none of the LAN-gated companion cases were skipped. The
skips are the unrelated, pre-existing ones. No e2e run: nothing user-visible changed. The raw
log is next to the mutation logs under `Documents/Codex/artifacts/modex-109-evidence/2026-10-28/`.
