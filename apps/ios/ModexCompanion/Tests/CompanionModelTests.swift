import Combine
import Foundation
import XCTest
@testable import ModexCompanion

@MainActor final class CompanionModelTests: XCTestCase {
    func testUnchangedPollingDoesNotInvalidateThePresentedWorkspace() async {
        let (model, client) = fixture()
        client.createdThread = CompanionThread(id: "same", projectId: "p", title: "Original", backend: "codex", status: "idle", updatedAt: "now")
        await model.refresh()
        var publications = 0
        let subscription = model.objectWillChange.sink { publications += 1 }
        defer { subscription.cancel() }

        await model.refresh()
        XCTAssertEqual(publications, 0, "An unchanged poll must not rebuild presented menus or interrupt interaction.")

        client.createdThread = CompanionThread(id: "same", projectId: "p", title: "Updated", backend: "claude", status: "running", updatedAt: "later")
        await model.refresh()
        XCTAssertGreaterThan(publications, 0, "Actual workspace changes must still publish.")
        XCTAssertEqual(model.snapshot.threads.first?.id, "same")
        XCTAssertEqual(model.snapshot.threads.first?.title, "Updated")
        XCTAssertEqual(model.snapshot.threads.first?.status, "running")
    }

    func testRepeatedOfflinePollsStayStableAndTheSameSnapshotCanRecover() async {
        let (model, client) = fixture()
        await model.refresh()
        var publications = 0
        let subscription = model.objectWillChange.sink { publications += 1 }
        defer { subscription.cancel() }
        for attempt in 0..<2 {
            let pending = Pending<CompanionSnapshot>(requested: expectation(description: "offline poll \(attempt)"))
            await client.enqueueSnapshot(pending)
            let refresh = Task { await model.refresh() }
            await fulfillment(of: [pending.requested], timeout: 2)
            await pending.resolve(.failure(URLError(.notConnectedToInternet)))
            await refresh.value
            XCTAssertFalse(model.connected)
            XCTAssertNotNil(model.connectionError)
            if attempt == 0 {
                XCTAssertGreaterThan(publications, 0)
                publications = 0
            } else {
                XCTAssertEqual(publications, 0, "Repeated identical failures must not rebuild recovery controls.")
            }
        }
        await model.refresh()
        XCTAssertTrue(model.connected, "The same workspace snapshot must still recover its connection state.")
        XCTAssertNil(model.connectionError)
        XCTAssertGreaterThan(publications, 0)
    }

    func testOfflinePairingSurvivesRelaunchAndReconnectsAtANewAddress() async {
        let store = MemoryPairingStore()
        let original = store.pairing!
        let oldClient = ControlledClient()
        let discovery = FakeDiscovery()
        let model = CompanionModel(store: store, discovery: discovery, makeClient: { _ in oldClient })
        let pending = Pending<CompanionSnapshot>(requested: expectation(description: "offline"))
        await oldClient.enqueueSnapshot(pending)
        let refresh = Task { await model.refresh() }
        await fulfillment(of: [pending.requested], timeout: 2)
        await pending.resolve(.failure(URLError(.notConnectedToInternet)))
        await refresh.value
        XCTAssertEqual(store.pairing, original)
        XCTAssertEqual(model.pairing, original)
        XCTAssertFalse(model.connected)
        XCTAssertTrue(model.connectionError?.contains("scan") == true, "Offline recovery must explain how to scan a fresh pairing code.")

        let moved = URL(string: "https://192.168.1.23:45123")!
        let restoredDiscovery = FakeDiscovery()
        restoredDiscovery.endpoint = moved
        let restored = CompanionModel(store: store, discovery: restoredDiscovery, makeClient: { _ in ControlledClient() })
        XCTAssertEqual(restored.pairing, original, "Launching must restore the saved Mac without scanning.")
        restored.startPolling()
        restored.stopPolling()
        await restored.refresh()
        XCTAssertTrue(restored.connected)
        XCTAssertEqual(store.pairing?.url, moved)
        XCTAssertEqual(store.pairing?.token, original.token)
        XCTAssertEqual(store.pairing?.fingerprint, original.fingerprint)
    }

    func testMacRevocationClearsTrustAndCannotReconnectFromDiscovery() async {
        let store = MemoryPairingStore()
        let client = ControlledClient()
        let discovery = FakeDiscovery()
        let model = CompanionModel(store: store, discovery: discovery, makeClient: { _ in client })
        let pending = Pending<CompanionSnapshot>(requested: expectation(description: "revoked"))
        await client.enqueueSnapshot(pending)
        let refresh = Task { await model.refresh() }
        await fulfillment(of: [pending.requested], timeout: 2)
        await pending.resolve(.failure(CompanionError.accessRevoked))
        await refresh.value
        XCTAssertNil(store.pairing)
        XCTAssertNil(model.pairing)
        XCTAssertTrue(model.snapshot.threads.isEmpty)
        XCTAssertTrue(discovery.stopped)
        model.startPolling()
        await model.refresh()
        XCTAssertFalse(model.connected)
        XCTAssertNotNil(model.error)
    }

    func testUnverifiedDiscoveredAddressCannotReplaceSavedPairing() async {
        let store = MemoryPairingStore()
        let original = store.pairing!
        let client = ControlledClient()
        let discovery = FakeDiscovery()
        discovery.endpoint = URL(string: "https://192.168.1.77:45123")!
        let model = CompanionModel(store: store, discovery: discovery, makeClient: { _ in client })
        let pending = Pending<CompanionSnapshot>(requested: expectation(description: "certificate rejected"))
        await client.enqueueSnapshot(pending)
        // Emit synchronously, then cancel polling so this test owns the one request below.
        model.startPolling()
        model.stopPolling()
        let refresh = Task { await model.refresh() }
        await fulfillment(of: [pending.requested], timeout: 2)
        await pending.resolve(.failure(URLError(.serverCertificateUntrusted)))
        await refresh.value
        XCTAssertEqual(store.pairing, original)
        XCTAssertEqual(model.pairing, original)
        XCTAssertFalse(model.connected)
        await model.refresh()
        XCTAssertTrue(model.connected)
        XCTAssertEqual(store.pairing, original, "A failed discovery candidate must not prevent recovery at the saved address.")
    }

    func testDiscoveryTriesEachAddressAndAlternatesTheSavedEndpoint() async {
        let store = MemoryPairingStore()
        let original = store.pairing!
        let endpoints = (1...3).map { URL(string: "https://192.168.1.\($0):45123")! }
        let clients = Dictionary(uniqueKeysWithValues: ([original.url] + endpoints).map { ($0, ControlledClient()) })
        clients.values.forEach { $0.snapshotFailure = URLError(.notConnectedToInternet) }
        clients[endpoints[0]]!.snapshotFailure = URLError(.serverCertificateUntrusted)
        clients[endpoints[1]]!.snapshotFailure = nil
        let discovery = FakeDiscovery()
        discovery.endpoints = endpoints
        var candidates: [Pairing] = []
        let model = CompanionModel(store: store, discovery: discovery, makeClient: {
            candidates.append($0)
            return clients[$0.url]!
        })
        model.startPolling()
        model.stopPolling()

        await model.refresh()
        XCTAssertFalse(model.connected)
        XCTAssertEqual(store.pairing, original, "The untrusted first address must not replace saved trust.")
        let firstRequests = await clients[endpoints[0]]!.snapshotRequests
        XCTAssertEqual(firstRequests, 1)
        await model.refresh()
        let savedRequests = await clients[original.url]!.snapshotRequests
        XCTAssertEqual(savedRequests, 1, "Retry the saved address between advertised candidates.")
        await model.refresh()
        XCTAssertTrue(model.connected, "A later unreachable advertisement must not hide a reachable address.")
        XCTAssertEqual(store.pairing?.url, endpoints[1])
        XCTAssertTrue(candidates.allSatisfy { $0.token == original.token && $0.fingerprint == original.fingerprint })
    }

    func testDiscoveryKeepsABoundedFairRotationDespiteDuplicateAdvertisements() async {
        let store = MemoryPairingStore()
        let original = store.pairing!
        let endpoints = (1...20).map { URL(string: "https://192.168.1.\($0):45123")! }
        let clients = Dictionary(uniqueKeysWithValues: ([original.url] + endpoints).map { ($0, ControlledClient()) })
        clients.values.forEach { $0.snapshotFailure = URLError(.notConnectedToInternet) }
        let discovery = FakeDiscovery()
        discovery.endpoints = endpoints + Array(repeating: endpoints.last!, count: 20)
        let model = CompanionModel(store: store, discovery: discovery, makeClient: { clients[$0.url]! })
        model.startPolling()
        model.stopPolling()

        for _ in 0..<64 { await model.refresh() }

        let savedRequests = await clients[original.url]!.snapshotRequests
        XCTAssertEqual(savedRequests, 32, "Advertisements must not starve the saved endpoint.")
        for (index, endpoint) in endpoints.enumerated() {
            let requests = await clients[endpoint]!.snapshotRequests
            XCTAssertEqual(requests, index < 4 ? 0 : 2, "Retain 16 addresses and visit each once per rotation; duplicates must not bias the order.")
        }
        XCTAssertEqual(store.pairing, original)
    }

    func testAdvertisementsDoNotCancelAnInFlightRecovery() async {
        let store = MemoryPairingStore()
        let original = store.pairing!
        let moved = URL(string: "https://192.168.1.23:45123")!
        let client = ControlledClient()
        client.snapshotFailure = URLError(.notConnectedToInternet)
        let pending = Pending<CompanionSnapshot>(requested: expectation(description: "recovery request"))
        await client.enqueueSnapshot(pending)
        let discovery = FakeDiscovery()
        discovery.endpoint = moved
        let model = CompanionModel(store: store, discovery: discovery, makeClient: { _ in client })
        let recovered = expectation(description: "original request completes recovery")
        let subscription = model.$connected.filter { $0 }.prefix(1).sink { _ in recovered.fulfill() }
        defer { model.stopPolling(); subscription.cancel() }
        model.startPolling()
        await fulfillment(of: [pending.requested], timeout: 2)
        for _ in 0..<3 { discovery.emit(moved) }
        discovery.emit(URL(string: "https://192.168.1.24:45123")!)
        await pending.resolve(.success(makeSnapshot(nil)))
        await fulfillment(of: [recovered], timeout: 1)

        XCTAssertTrue(model.connected)
        XCTAssertEqual(store.pairing, Pairing(url: moved, token: original.token, fingerprint: original.fingerprint))
        let requests = await client.snapshotRequests
        XCTAssertEqual(requests, 1, "Discovery must not start overlapping refreshes.")
    }

    func testRevocationAtADiscoveredAddressClearsAllRecoveryCandidates() async {
        let store = MemoryPairingStore()
        let client = ControlledClient()
        client.snapshotFailure = CompanionError.accessRevoked
        let discovery = FakeDiscovery()
        discovery.endpoints = [URL(string: "https://192.168.1.23:45123")!, URL(string: "https://192.168.1.24:45123")!]
        let model = CompanionModel(store: store, discovery: discovery, makeClient: { _ in client })
        model.startPolling()
        model.stopPolling()
        await model.refresh()
        await model.refresh()
        XCTAssertNil(model.pairing)
        XCTAssertNil(store.pairing)
        XCTAssertFalse(model.connected)
        XCTAssertTrue(discovery.stopped)
        let requests = await client.snapshotRequests
        XCTAssertEqual(requests, 1, "Revoked trust must not try another candidate.")
    }

    func testThreadSelectionClearsOldItemsAndRejectsAnOlderRefresh() async {
        let (model, client) = fixture()
        await model.select("a")
        let old = Pending<CompanionSnapshot>(requested: expectation(description: "old refresh"))
        await client.enqueueSnapshot(old)
        let refresh = Task { await model.refresh() }
        await fulfillment(of: [old.requested], timeout: 2)

        let next = Pending<CompanionSnapshot>(requested: expectation(description: "new selection"))
        await client.enqueueSnapshot(next)
        let selection = Task { await model.select("b") }
        await fulfillment(of: [next.requested], timeout: 2)
        XCTAssertTrue(model.snapshot.items.isEmpty, "The old transcript must disappear while the new thread loads.")
        await next.resolve(.success(makeSnapshot("b")))
        await selection.value
        await old.resolve(.success(makeSnapshot("a")))
        await refresh.value
        XCTAssertEqual(model.selectedThreadId, "b")
        XCTAssertEqual(model.snapshot.items.first?.text, "Thread b")
    }

    func testDisconnectRejectsARefreshAlreadyInFlight() async {
        let (model, client) = fixture()
        let pending = Pending<CompanionSnapshot>(requested: expectation(description: "refresh"))
        await client.enqueueSnapshot(pending)
        let refresh = Task { await model.refresh() }
        await fulfillment(of: [pending.requested], timeout: 2)
        model.disconnect()
        await pending.resolve(.success(makeSnapshot("a")))
        await refresh.value
        XCTAssertNil(model.pairing)
        XCTAssertFalse(model.connected)
        XCTAssertTrue(model.snapshot.threads.isEmpty)
    }

    func testOlderRefreshFailureCannotReplaceANewerSuccess() async {
        let (model, client) = fixture()
        let pending = Pending<CompanionSnapshot>(requested: expectation(description: "old refresh"))
        await client.enqueueSnapshot(pending)
        let refresh = Task { await model.refresh() }
        await fulfillment(of: [pending.requested], timeout: 2)
        await model.refresh()
        await pending.resolve(.failure(CompanionError.message("Old connection failure")))
        await refresh.value
        XCTAssertTrue(model.connected)
        XCTAssertNil(model.connectionError)
    }

    func testSendCompletionClearsOnlyTheSubmittedThreadsDraft() async {
        for otherDraft in ["Same message", "A different message"] {
            let (model, client) = fixture()
            await model.select("a")
            model.draft = "Same message"
            let pending = Pending<Void>(requested: expectation(description: "send"))
            await client.enqueueSend(pending)
            let send = Task { await model.send() }
            await fulfillment(of: [pending.requested], timeout: 2)
            await model.select("b")
            model.draft = otherDraft
            await pending.resolve(.success(()))
            await send.value
            XCTAssertEqual(model.draft, otherDraft, "Sending in a different thread must preserve this draft.")
            await model.select("a")
            XCTAssertEqual(model.draft, "", "The successfully sent draft must be cleared in its own thread.")
        }
    }

    func testEditsMadeDuringSendArePreserved() async {
        let (model, client) = fixture()
        await model.select("a")
        model.draft = "Send this"
        let pending = Pending<Void>(requested: expectation(description: "send"))
        await client.enqueueSend(pending)
        let send = Task { await model.send() }
        await fulfillment(of: [pending.requested], timeout: 2)
        model.draft = "Keep this newer draft"
        await pending.resolve(.success(()))
        await send.value
        XCTAssertEqual(model.draft, "Keep this newer draft")
    }

    func testCreateThreadSelectsTheNewThreadAndClearsOnlyTheSubmittedDraft() async {
        let (model, client) = fixture()
        model.newThreadDraft = "Build the mobile flow"
        client.createdThread = CompanionThread(id: "new", projectId: "p", title: "Build the mobile flow", backend: "codex", status: "idle", updatedAt: "now")

        _ = await model.createThread(projectId: "p", worktree: true, provider: "claude")

        XCTAssertEqual(client.createdProjectId, "p")
        XCTAssertEqual(client.createdText, "Build the mobile flow")
        XCTAssertEqual(client.createdWorktree, true)
        XCTAssertEqual(client.createdProvider, "claude")
        XCTAssertEqual(model.selectedThreadId, "new")
        XCTAssertEqual(model.newThreadDraft, "")
    }

    func testCreateThreadPreservesThePreviousThreadsUnsentDraft() async {
        let (model, client) = fixture()
        await model.select("a")
        model.draft = "Keep my follow-up"
        model.newThreadDraft = "Create another thread"
        client.createdThread = CompanionThread(id: "new", projectId: "p", title: "New", backend: "codex", status: "idle", updatedAt: "now")
        _ = await model.createThread(projectId: "p", worktree: false, provider: "codex")
        client.createdThread = nil
        await model.select("a")
        XCTAssertEqual(model.draft, "Keep my follow-up")
    }

    func testRescanningTheSameMacPreservesAllDraftsButAnotherMacClearsThem() async throws {
        for sameMac in [true, false] {
            let (model, _) = fixture()
            await model.select("a")
            model.draft = "Keep thread A"
            await model.select("b")
            model.draft = "Keep thread B"
            model.newThreadDraft = "Keep my new task"
            let original = try XCTUnwrap(model.pairing)
            let replacement = Pairing(url: URL(string: "https://192.168.1.24:43210")!, token: String(repeating: "c", count: 64), fingerprint: sameMac ? original.fingerprint : String(repeating: "d", count: 64))
            let encoded = try JSONEncoder().encode(replacement).base64EncodedString()
            await model.pair(link: "modex://pair?data=\(encoded)")
            model.stopPolling()
            XCTAssertEqual(model.pairing, replacement)
            XCTAssertEqual(model.newThreadDraft, sameMac ? "Keep my new task" : "")
            await model.select("b")
            XCTAssertEqual(model.draft, sameMac ? "Keep thread B" : "")
            await model.select("a")
            XCTAssertEqual(model.draft, sameMac ? "Keep thread A" : "")
        }
    }

    func testOldCreationCannotClearANewCreationsBusyState() async throws {
        let (model, client) = fixture()
        let pairing = try XCTUnwrap(model.pairing)
        let encoded = try JSONEncoder().encode(pairing).base64EncodedString()
        let old = Pending<CompanionThread>(requested: expectation(description: "old creation"))
        await client.enqueueCreation(old)
        model.newThreadDraft = "Old request"
        let oldCreation = Task { await model.createThread(projectId: "p", worktree: false, provider: "codex") }
        await fulfillment(of: [old.requested], timeout: 2)
        model.disconnect()
        await model.pair(link: "modex://pair?data=\(encoded)")
        model.stopPolling()
        let current = Pending<CompanionThread>(requested: expectation(description: "current creation"))
        await client.enqueueCreation(current)
        model.newThreadDraft = "Current request"
        let currentCreation = Task { await model.createThread(projectId: "p", worktree: false, provider: "codex") }
        await fulfillment(of: [current.requested], timeout: 2)
        await old.resolve(.failure(CompanionError.message("Old error")))
        let oldResult = await oldCreation.value
        XCTAssertNil(oldResult)
        XCTAssertNil(model.error)
        XCTAssertTrue(model.creatingThread, "An old request must not unlock duplicate creation.")
        XCTAssertEqual(model.newThreadDraft, "Current request")
        await current.resolve(.success(makeSnapshot("b").threads[1]))
        let currentResult = await currentCreation.value
        XCTAssertEqual(currentResult, "b")
        XCTAssertFalse(model.creatingThread)
    }

    func testCreationCannotNavigateAfterDisconnectDuringRefresh() async {
        let (model, client) = fixture()
        client.createdThread = makeSnapshot("b").threads[1]
        let pending = Pending<CompanionSnapshot>(requested: expectation(description: "creation refresh"))
        await client.enqueueSnapshot(pending)
        model.newThreadDraft = "Create a thread"
        let creation = Task { await model.createThread(projectId: "p", worktree: false, provider: "codex") }
        await fulfillment(of: [pending.requested], timeout: 2)
        model.disconnect()
        await pending.resolve(.success(makeSnapshot("b")))
        let result = await creation.value
        XCTAssertNil(result, "A late response must not navigate into a forgotten workspace.")
        XCTAssertNil(model.selectedThreadId)
        XCTAssertTrue(model.snapshot.threads.isEmpty)
    }

    func testCommandResultsStayScopedToTheirProjectAndProvider() async {
        let (model, client) = fixture()
        let codex = Pending<[CompanionCommand]>(requested: expectation(description: "codex commands"))
        let claude = Pending<[CompanionCommand]>(requested: expectation(description: "claude commands"))
        await client.enqueueCommands(codex)
        await client.enqueueCommands(claude)
        let oldRequest = Task { await model.loadCommands(projectId: "p", backend: "codex") }
        await fulfillment(of: [codex.requested], timeout: 2)
        let currentRequest = Task { await model.loadCommands(projectId: "p", backend: "claude") }
        await fulfillment(of: [claude.requested], timeout: 2)
        XCTAssertTrue(model.availableCommands(projectId: "p", backend: "claude").isEmpty)
        await claude.resolve(.success([CompanionCommand(id: "command:check", title: "check", detail: "Check", insertion: "/check ", kind: "command")]))
        await currentRequest.value
        await codex.resolve(.success([CompanionCommand(id: "skill:verify", title: "verify", detail: "Verify", insertion: "$verify ", kind: "skill")]))
        await oldRequest.value
        XCTAssertEqual(model.availableCommands(projectId: "p", backend: "claude").map(\.id), ["command:check"])
        XCTAssertTrue(model.availableCommands(projectId: "p", backend: "codex").isEmpty)
    }

    func testCancelledCommandPickerDoesNotPublishResultsOrErrors() async {
        let command = CompanionCommand(id: "skill:old", title: "old", detail: "Skill", insertion: "$old ", kind: "skill")
        for result: Result<[CompanionCommand], Error> in [.success([command]), .failure(CancellationError())] {
            let (model, client) = fixture()
            let pending = Pending<[CompanionCommand]>(requested: expectation(description: "cancelled commands"))
            await client.enqueueCommands(pending)
            let request = Task { await model.loadCommands(projectId: "p", backend: "codex") }
            await fulfillment(of: [pending.requested], timeout: 2)
            request.cancel()
            await pending.resolve(result)
            await request.value
            XCTAssertNil(model.error)
            XCTAssertTrue(model.commands.isEmpty)
        }
    }

    func testDisconnectResetsPendingActionsAndIgnoresTheirErrors() async {
        let (model, client) = fixture()
        await model.select("a")
        model.draft = "Send this"
        let pending = Pending<Void>(requested: expectation(description: "send"))
        await client.enqueueSend(pending)
        let send = Task { await model.send() }
        await fulfillment(of: [pending.requested], timeout: 2)
        model.disconnect()
        XCTAssertFalse(model.sending)
        await pending.resolve(.failure(CompanionError.message("Old send failure")))
        await send.value
        XCTAssertNil(model.error)
    }

    func testInitialPairingUsesPermissionAwareSnapshotWhileRecoveryDoesNot() async throws {
        let store = MemoryPairingStore()
        let original = store.pairing!
        let link = try JSONEncoder().encode(original).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let moved = URL(string: "https://192.168.1.24:43210")!
        let discovery = FakeDiscovery()
        discovery.endpoint = moved
        let savedClient = ControlledClient()
        let recoveredClient = ControlledClient()
        let model = CompanionModel(store: store, discovery: discovery, makeClient: { $0.url == moved ? recoveredClient : savedClient })
        await model.pair(link: "modex://pair?data=\(link)")
        model.stopPolling()
        savedClient.snapshotFailure = URLError(.cannotConnectToHost)
        await model.refresh()
        await model.refresh()

        let pairingRequests = await savedClient.pairingSnapshotRequests
        let recoveryPairingRequests = await recoveredClient.pairingSnapshotRequests
        let recoveryRequests = await recoveredClient.snapshotRequests
        XCTAssertEqual(pairingRequests, 1)
        XCTAssertEqual(recoveryPairingRequests, 0, "Bonjour recovery must not wait for first-use permission again.")
        XCTAssertGreaterThan(recoveryRequests, 0)
        XCTAssertEqual(store.pairing?.url, moved)
        XCTAssertTrue(model.connected)
    }

    func testDisconnectRejectsAnUnfinishedPairingAttempt() async throws {
        let store = MemoryPairingStore()
        let candidate = try JSONEncoder().encode(store.pairing!).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let client = ControlledClient()
        let model = CompanionModel(store: store, makeClient: { _ in client })
        defer { model.stopPolling() }
        let pending = Pending<CompanionSnapshot>(requested: expectation(description: "pair"))
        await client.enqueueSnapshot(pending)
        let pairing = Task { await model.pair(link: "modex://pair?data=\(candidate)") }
        await fulfillment(of: [pending.requested], timeout: 10)
        model.disconnect()
        await pending.resolve(.success(makeSnapshot(nil)))
        await pairing.value
        XCTAssertNil(model.pairing)
        XCTAssertNil(store.pairing)
        XCTAssertFalse(model.connected)
    }

    func testAlwaysAllowSetsThePolicyBeforeApprovingTheRequest() async {
        let (model, client) = fixture()
        await model.select("a")
        await model.approveAlways(itemId: "approval-a")
        let calls = await client.calls
        XCTAssertEqual(calls, ["policy:always", "answer:approval-a"])
        await model.setApprovals("yolo")
        let after = await client.calls
        XCTAssertEqual(after.last, "policy:yolo")
    }

    func testThreadsDecodeTheirApprovalPolicyAndPullRequestStatus() throws {
        let json = #"{"id":"abcdef12","projectId":"p","title":"T","backend":"claude","status":"idle","updatedAt":"now","approvals":"yolo","worktree":true,"pr":{"number":7,"state":"merged"},"retiredPr":7,"archived":true}"#
        let thread = try JSONDecoder().decode(CompanionThread.self, from: Data(json.utf8))
        XCTAssertEqual(thread.approvalPolicy, "yolo")
        XCTAssertEqual(thread.pr, CompanionThread.PullRequestBadge(number: 7, state: "merged"))
        XCTAssertEqual(thread.retiredPr, 7)
        XCTAssertEqual(thread.archived, true)
        let old = try JSONDecoder().decode(CompanionThread.self, from: Data(#"{"id":"a","projectId":"p","title":"T","backend":"codex","status":"idle","updatedAt":"now"}"#.utf8))
        XCTAssertEqual(old.approvalPolicy, "ask", "an older Mac that sends no policy means ask")
        XCTAssertNil(old.archived, "an older Mac archives nothing")
    }

    func testArchivedThreadsStayHiddenUntilShownAndArchivingGoesThroughTheMac() async {
        let (model, client) = fixture()
        client.archivedIds = ["b"]
        await model.refresh()
        XCTAssertFalse(model.showArchived, "Archived threads are hidden by default.")
        XCTAssertEqual(model.archivedThreadCount, 1)
        XCTAssertEqual(model.visibleThreadCount, 1)
        XCTAssertEqual(model.visibleThreads(in: "p").map(\.id), ["a"])
        XCTAssertEqual(model.snapshot.threads.count, 2, "The Mac still sends archived threads so they can be shown without another request.")
        model.showArchived = true
        XCTAssertEqual(model.visibleThreads(in: "p").map(\.id), ["a", "b"])
        XCTAssertEqual(model.visibleThreadCount, 2)
        model.showArchived = false

        let archived1 = await model.setArchived(true, threadId: "a")

        XCTAssertTrue(archived1)
        var calls = await client.calls
        XCTAssertEqual(calls.last, "archive:a:true")
        XCTAssertEqual(model.visibleThreads(in: "p"), [], "The Mac's answer hides the newly archived thread at once.")
        XCTAssertEqual(model.archivedThreadCount, 2)
        let archived2 = await model.setArchived(false, threadId: "b")
        XCTAssertTrue(archived2)
        calls = await client.calls
        XCTAssertEqual(calls.last, "archive:b:false")
        XCTAssertEqual(model.visibleThreads(in: "p").map(\.id), ["b"])
        XCTAssertNil(model.error)

        client.archiveFailure = CompanionError.message("Wait for this thread to finish before archiving it.")
        let archived3 = await model.setArchived(true, threadId: "b")
        XCTAssertFalse(archived3)
        XCTAssertEqual(model.error, "Wait for this thread to finish before archiving it.")
        XCTAssertEqual(model.visibleThreads(in: "p").map(\.id), ["b"], "A refusal changes nothing.")

        model.showArchived = true
        model.disconnect()
        XCTAssertFalse(model.showArchived, "A new workspace starts with archived threads hidden again.")
    }

    func testDisconnectResetsApprovalAndIgnoresItsLateError() async {
        let (model, client) = fixture()
        await model.select("a")
        let pending = Pending<Void>(requested: expectation(description: "answer"))
        await client.enqueueAnswer(pending)
        let answer = Task { await model.answer(itemId: "approval-a", approve: true) }
        await fulfillment(of: [pending.requested], timeout: 2)
        model.disconnect()
        XCTAssertNil(model.answeringId)
        await pending.resolve(.failure(CompanionError.message("Old approval failure")))
        await answer.value
        XCTAssertNil(model.error)
    }

    func testARefusedAnswerRefreshesSoTheCardShowsWhatHappenedOnTheMac() async {
        let (model, client) = fixture()
        await model.select("a")
        let before = await client.snapshotRequests
        let refused = Pending<Void>(requested: expectation(description: "answer"))
        await refused.resolve(.failure(CompanionError.message("This approval is no longer pending.")))
        await client.enqueueAnswer(refused)
        await model.answer(itemId: "approval-a", approve: true)
        await fulfillment(of: [refused.requested], timeout: 2)
        let after = await client.snapshotRequests
        XCTAssertEqual(after, before + 1, "A 409 most often means the Mac or another client already settled it, so read its current state.")
        XCTAssertEqual(model.error, "This approval is no longer pending.")
        XCTAssertNil(model.answeringId)
    }

    func testARefusedAlwaysAllowAlsoRefreshes() async {
        let (model, client) = fixture()
        await model.select("a")
        let before = await client.snapshotRequests
        let refused = Pending<Void>(requested: expectation(description: "answer"))
        await refused.resolve(.failure(CompanionError.message("This approval is no longer pending.")))
        await client.enqueueAnswer(refused)
        await model.approveAlways(itemId: "approval-a")
        await fulfillment(of: [refused.requested], timeout: 2)
        let after = await client.snapshotRequests
        XCTAssertEqual(after, before + 1)
        XCTAssertEqual(model.error, "This approval is no longer pending.")
    }

    func testPendingRetainsTheFirstResultBeforeARequest() async {
        let results: [Result<Int, Error>] = [.success(42), .failure(PendingFixtureFailure.expected)]
        for result in results {
            await assertPendingResult(result, beforeRequest: true)
        }
    }

    func testPendingRetainsTheFirstResultAfterARequest() async {
        let results: [Result<Int, Error>] = [.success(42), .failure(PendingFixtureFailure.expected)]
        for result in results {
            await assertPendingResult(result, beforeRequest: false)
        }
    }

    func testPendingDoesNotSuspendAReaderCancelledBeforeRegistration() async {
        let pending = Pending<Int>(requested: expectation(description: "cancelled reader requested"))
        let completed = expectation(description: "cancelled reader completed")
        var received: Result<Int, Error>?
        let reader = Task {
            do { received = .success(try await pending.value()) }
            catch { received = .failure(error) }
            completed.fulfill()
        }
        // This MainActor task cannot begin until the test yields below.
        reader.cancel()
        await fulfillment(of: [pending.requested], timeout: 2)
        // Release the old helper too: a failing regression must not leave its reader suspended.
        await pending.resolve(.success(99))
        await fulfillment(of: [completed], timeout: 2)
        guard case .failure(let error)? = received else {
            XCTFail("A reader cancelled before registration must finish with cancellation.")
            return
        }
        XCTAssertTrue(error is CancellationError)
    }

    private func assertPendingResult(_ first: Result<Int, Error>, beforeRequest: Bool) async {
        let pending = Pending<Int>(requested: expectation(description: "reader requested"))
        let completed = expectation(description: "reader completed")
        var received: Result<Int, Error>?
        if beforeRequest {
            await pending.resolve(first)
            await pending.resolve(.success(-1))
        }
        let reader = Task {
            do { received = .success(try await pending.value()) }
            catch { received = .failure(error) }
            completed.fulfill()
        }
        await fulfillment(of: [pending.requested], timeout: 2)
        if !beforeRequest { await pending.resolve(first) }
        // Original RED: early 42 is lost, so this cleanup settlement produces 99.
        await pending.resolve(.success(99))
        // Bound teardown if registration failed: no unbounded await of reader.value.
        reader.cancel()
        await pending.resolve(.failure(CancellationError()))
        await fulfillment(of: [completed], timeout: 2)
        switch (first, received) {
        case (.success(let expected), .success(let actual)?):
            XCTAssertEqual(actual, expected)
        case (.failure, .failure(let error)?):
            XCTAssertTrue(error is PendingFixtureFailure, "Preserve the original error, not teardown cancellation.")
        default:
            XCTFail("The reader must receive its first settlement.")
        }
    }

    private func fixture() -> (CompanionModel, ControlledClient) {
        let client = ControlledClient()
        return (CompanionModel(store: MemoryPairingStore(), discovery: FakeDiscovery(), makeClient: { _ in client }), client)
    }

    func testJournalDeltasMergeIntoTheTranscriptTheyWereReadAgainst() async {
        let client = JournalClient()
        let model = CompanionModel(store: MemoryPairingStore(), discovery: FakeDiscovery(), makeClient: { _ in client })
        let journal = JournalCursor(id: "j1", cursor: 4)
        await client.reply(journalItems(["u1": "hi", "a1": "Hel"]), journal: journal)
        await model.select("a")
        XCTAssertEqual(model.snapshot.items.map(\.text), ["hi", "Hel"])

        // After sleep the phone sends its cursor and gets only what changed: an update and a new item.
        await client.reply(journalItems(["a1": "Hello", "t1": "done"]), journal: JournalCursor(id: "j1", cursor: 9), delta: true)
        await model.refresh()
        let afterSent = await client.afters.last
        XCTAssertEqual(afterSent ?? nil, journal, "The phone resumes from the cursor its transcript was read at.")
        XCTAssertEqual(model.snapshot.items.map(\.id), ["u1", "a1", "t1"], "Changed items replace theirs in place and new ones append once.")
        XCTAssertEqual(model.snapshot.items.map(\.text), ["hi", "Hello", "done"])

        // Nothing changed: an empty delta keeps the transcript and publishes nothing.
        await client.reply([], journal: JournalCursor(id: "j1", cursor: 9), delta: true)
        var publications = 0
        let subscription = model.objectWillChange.sink { publications += 1 }
        await model.refresh()
        subscription.cancel()
        XCTAssertEqual(publications, 0)
        XCTAssertEqual(model.snapshot.items.count, 3)

        // Another thread starts from a full transcript, never from this thread's cursor.
        await client.reply(journalItems(["b1": "other"]), journal: JournalCursor(id: "j1", cursor: 12))
        await model.select("b")
        let switched = await client.afters.last
        XCTAssertNil(switched ?? nil)
        XCTAssertEqual(model.snapshot.items.map(\.id), ["b1"])
    }

    func testRoutineRunsThatEndAreAnnouncedOnceAndNeverReplayedOnFirstSight() async {
        let defaults = UserDefaults(suiteName: "routine-notices-\(UUID().uuidString)")!
        let client = RoutineClient()
        let model = CompanionModel(store: MemoryPairingStore(), discovery: FakeDiscovery(), defaults: defaults, makeClient: { _ in client })
        await client.set([routineRun("r1", "Nightly review", "completed", "2026-10-15T01:00:00.000Z", thread: "a")])
        await model.refresh()
        XCTAssertNil(model.routineNotice, "A Mac's existing runs are not news the first time the phone sees them.")

        // A Mac that had no runs when first seen: its first run is news.
        let freshDefaults = UserDefaults(suiteName: "routine-notices-\(UUID().uuidString)")!
        let freshClient = RoutineClient()
        let fresh = CompanionModel(store: MemoryPairingStore(), discovery: FakeDiscovery(), defaults: freshDefaults, makeClient: { _ in freshClient })
        await fresh.refresh()
        await freshClient.set([routineRun("f1", "First routine", "completed", "2026-10-15T00:30:00.000Z", thread: "a")])
        await fresh.refresh()
        XCTAssertEqual(fresh.routineNotice?.text, "Routine “First routine” finished.")

        await client.set([
            routineRun("r2", "Nightly review", "completed", "2026-10-15T02:00:00.000Z", thread: "b"),
            routineRun("r1", "Nightly review", "completed", "2026-10-15T01:00:00.000Z", thread: "a"),
        ])
        await model.refresh()
        XCTAssertEqual(model.routineNotice?.text, "Routine “Nightly review” finished.")
        XCTAssertEqual(model.routineNotice?.threadId, "b")
        XCTAssertEqual(model.routineNotice?.failed, false)
        model.dismissRoutineNotice()
        await model.refresh()
        XCTAssertNil(model.routineNotice, "A run is announced once.")

        // Asleep through several runs: one notice, not one per run.
        await client.set([
            routineRun("r4", "Dependency audit", "failed", "2026-10-15T04:00:00.000Z", thread: "a"),
            routineRun("r3", "Nightly review", "completed", "2026-10-15T03:00:00.000Z", thread: "b"),
            routineRun("r2", "Nightly review", "completed", "2026-10-15T02:00:00.000Z", thread: "b"),
        ])
        await model.refresh()
        XCTAssertEqual(model.routineNotice?.text, "2 routine runs ended, 1 without finishing: Dependency audit, Nightly review.")
        XCTAssertEqual(model.routineNotice?.failed, true)
        XCTAssertEqual(model.routineNotice?.threadId, "a")
    }
}

private func journalItems(_ pairs: KeyValuePairs<String, String>) -> [CompanionItem] {
    pairs.map { CompanionItem(id: $0.key, kind: "assistant", text: $0.value, title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: "2026-10-15T00:00:00Z") }
}

/// Answers each snapshot with the next scripted reply and records the journal cursor it was sent.
private actor JournalClient: CompanionClient {
    private var replies: [CompanionSnapshot] = []
    private(set) var afters: [JournalCursor?] = []
    func reply(_ items: [CompanionItem], journal: JournalCursor, delta: Bool = false) {
        var snapshot = makeSnapshot(nil)
        snapshot = CompanionSnapshot(projects: snapshot.projects, threads: snapshot.threads, items: items)
        snapshot.journal = journal
        snapshot.delta = delta
        replies.append(snapshot)
    }
    func snapshot(threadId: String?) async throws -> CompanionSnapshot { try await snapshot(threadId: threadId, after: nil) }
    func snapshot(threadId: String?, after: JournalCursor?) async throws -> CompanionSnapshot {
        afters.append(after)
        return replies.isEmpty ? makeSnapshot(threadId) : replies.removeFirst()
    }
    func createThread(projectId: String, text: String, worktree: Bool, provider: String) async throws -> CompanionThread { throw CompanionError.message("unused") }
    func commands(projectId: String, backend: String) async throws -> [CompanionCommand] { [] }
    func send(threadId: String, text: String) async throws {}
    func answer(threadId: String, itemId: String, approve: Bool) async throws {}
}

private func routineRun(_ id: String, _ routine: String, _ status: String, _ endedAt: String, thread: String) -> CompanionRoutineRun {
    CompanionRoutineRun(id: id, routine: routine, status: status, endedAt: endedAt, threadId: thread)
}

/// Answers every snapshot with the routine runs it was last given.
private actor RoutineClient: CompanionClient {
    private var runs: [CompanionRoutineRun] = []
    func set(_ runs: [CompanionRoutineRun]) { self.runs = runs }
    func snapshot(threadId: String?) async throws -> CompanionSnapshot {
        var snapshot = makeSnapshot(threadId)
        snapshot.routineRuns = runs
        return snapshot
    }
    func createThread(projectId: String, text: String, worktree: Bool, provider: String) async throws -> CompanionThread { throw CompanionError.message("unused") }
    func commands(projectId: String, backend: String) async throws -> [CompanionCommand] { [] }
    func send(threadId: String, text: String) async throws {}
    func answer(threadId: String, itemId: String, approve: Bool) async throws {}
}

@MainActor private final class FakeDiscovery: CompanionDiscovery {
    var endpoint: URL?
    var endpoints: [URL] = []
    var stopped = false
    private var found: ((URL) -> Void)?
    func start(fingerprint: String, found: @escaping (URL) -> Void) {
        stopped = false
        self.found = found
        if let endpoint { found(endpoint) }
        endpoints.forEach(found)
    }
    func emit(_ endpoint: URL) { found?(endpoint) }
    func stop() { stopped = true; found = nil }
}

private final class MemoryPairingStore: PairingStorage {
    var pairing: Pairing? = Pairing(url: URL(string: "https://127.0.0.1:43120")!, token: String(repeating: "a", count: 64), fingerprint: String(repeating: "b", count: 64))
    func load() -> Pairing? { pairing }
    func save(_ pairing: Pairing) throws { self.pairing = pairing }
    func clear() { pairing = nil }
}

private enum PendingFixtureFailure: Error { case expected }

private actor Pending<Value> {
    nonisolated let requested: XCTestExpectation
    private var continuation: CheckedContinuation<Value, Error>?
    private var firstResult: Result<Value, Error>?
    init(requested: XCTestExpectation) { self.requested = requested }
    func value() async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            if let firstResult {
                continuation.resume(with: firstResult)
            } else if Task.isCancelled {
                // A timed-out test can cancel a reader before this actor receives it.
                continuation.resume(throwing: CancellationError())
            } else {
                self.continuation = continuation
            }
            requested.fulfill()
        }
    }
    func resolve(_ result: Result<Value, Error>) {
        guard firstResult == nil else { return }
        firstResult = result
        continuation?.resume(with: result)
        continuation = nil
    }
}

private actor ControlledClient: CompanionClient {
    private var snapshots: [Pending<CompanionSnapshot>] = []
    private var sends: [Pending<Void>] = []
    private var answers: [Pending<Void>] = []
    private var commandLists: [Pending<[CompanionCommand]>] = []
    private var creations: [Pending<CompanionThread>] = []
    private(set) var calls: [String] = []
    private(set) var snapshotRequests = 0
    private(set) var pairingSnapshotRequests = 0
    nonisolated(unsafe) var snapshotFailure: Error?
    nonisolated(unsafe) var archiveFailure: Error?
    nonisolated(unsafe) var archivedIds: Set<String> = []
    nonisolated(unsafe) var createdThread: CompanionThread?
    nonisolated(unsafe) var createdProjectId: String?
    nonisolated(unsafe) var createdText: String?
    nonisolated(unsafe) var createdWorktree: Bool?
    nonisolated(unsafe) var createdProvider: String?
    func enqueueSnapshot(_ pending: Pending<CompanionSnapshot>) { snapshots.append(pending) }
    func enqueueSend(_ pending: Pending<Void>) { sends.append(pending) }
    func enqueueAnswer(_ pending: Pending<Void>) { answers.append(pending) }
    func enqueueCommands(_ pending: Pending<[CompanionCommand]>) { commandLists.append(pending) }
    func enqueueCreation(_ pending: Pending<CompanionThread>) { creations.append(pending) }
    func pairingSnapshot() async throws -> CompanionSnapshot {
        pairingSnapshotRequests += 1
        return try await snapshot(threadId: nil)
    }
    func snapshot(threadId: String?) async throws -> CompanionSnapshot {
        snapshotRequests += 1
        if !snapshots.isEmpty { return try await snapshots.removeFirst().value() }
        if let snapshotFailure { throw snapshotFailure }
        if let createdThread {
            return CompanionSnapshot(projects: [CompanionProject(id: "p", name: "Project")], threads: [createdThread], items: [])
        }
        return makeSnapshot(threadId, archived: archivedIds)
    }
    func send(threadId: String, text: String) async throws {
        if !sends.isEmpty { try await sends.removeFirst().value() }
    }
    func setArchived(threadId: String, archived: Bool) async throws {
        calls.append("archive:\(threadId):\(archived)")
        if let archiveFailure { throw archiveFailure }
        if archived { archivedIds.insert(threadId) } else { archivedIds.remove(threadId) }
    }
    func answer(threadId: String, itemId: String, approve: Bool) async throws {
        calls.append("answer:\(itemId)")
        if !answers.isEmpty { try await answers.removeFirst().value() }
    }
    func setApprovals(threadId: String, policy: String) async throws { calls.append("policy:\(policy)") }
    func createThread(projectId: String, text: String, worktree: Bool, provider: String) async throws -> CompanionThread {
        createdProjectId = projectId
        createdText = text
        createdWorktree = worktree
        createdProvider = provider
        if !creations.isEmpty { return try await creations.removeFirst().value() }
        return createdThread!
    }
    func commands(projectId: String, backend: String) async throws -> [CompanionCommand] {
        if !commandLists.isEmpty { return try await commandLists.removeFirst().value() }
        return []
    }
}

private func makeSnapshot(_ threadId: String?, archived: Set<String> = []) -> CompanionSnapshot {
    let threads = ["a", "b"].map { CompanionThread(id: $0, projectId: "p", title: "Thread \($0)", backend: "mock", status: "idle", updatedAt: "2026-10-04T00:00:00Z", archived: archived.contains($0) ? true : nil) }
    let items = threadId.map { [CompanionItem(id: "item-\($0)", kind: "assistant", text: "Thread \($0)", title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: "2026-10-04T00:00:00Z")] } ?? []
    return CompanionSnapshot(projects: [CompanionProject(id: "p", name: "Project")], threads: threads, items: items)
}

@MainActor final class DemoWorkspaceModelTests: XCTestCase {
    func testDemoWorkspaceNeedsNoPairingAndLeavesNothingBehind() async {
        let store = EmptyPairingStore()
        let discovery = RecordingDiscovery()
        let model = CompanionModel(store: store, discovery: discovery, makeClient: { _ in
            XCTFail("The demo must not create a network client.")
            return UnreachableClient()
        })
        XCTAssertNil(model.pairing)
        XCTAssertFalse(model.hasWorkspace)

        await model.startDemo()
        model.stopPolling()
        XCTAssertTrue(model.isDemo)
        XCTAssertTrue(model.hasWorkspace)
        XCTAssertTrue(model.connected)
        XCTAssertNil(model.pairing, "The demo must not pretend to be a paired Mac.")
        XCTAssertFalse(store.saved, "The demo must not write to the Keychain.")
        XCTAssertFalse(discovery.started, "The demo must not browse the local network.")
        XCTAssertEqual(model.snapshot.threads.count, 3)

        let waiting = model.snapshot.threads.first { $0.status == "waiting" }
        XCTAssertNotNil(waiting)
        await model.select(waiting!.id)
        let approval = model.snapshot.items.first { $0.kind == "approval" && $0.answer == nil }
        XCTAssertNotNil(approval, "The demo must offer an approval to answer.")
        await model.answer(itemId: approval!.id, approve: true)
        XCTAssertEqual(model.snapshot.items.first { $0.id == approval!.id }?.answer, "yes")
        XCTAssertEqual(model.snapshot.threads.first { $0.id == waiting!.id }?.status, "idle")
        XCTAssertNil(model.error)

        model.draft = "Ship it"
        await model.send()
        XCTAssertEqual(model.draft, "")
        XCTAssertEqual(model.snapshot.items.last?.kind, "user")
        XCTAssertEqual(model.snapshot.items.last?.text, "Ship it")

        model.disconnect()
        XCTAssertFalse(model.isDemo)
        XCTAssertFalse(model.hasWorkspace)
        XCTAssertNil(model.pairing)
        XCTAssertTrue(model.snapshot.threads.isEmpty)
    }

    func testDemoArchivesAndRestoresThreadsWithoutAMac() async {
        let model = CompanionModel(store: EmptyPairingStore(), discovery: RecordingDiscovery(), makeClient: { _ in
            XCTFail("The demo must not create a network client.")
            return UnreachableClient()
        })
        await model.startDemo()
        model.stopPolling()
        let project = DemoCompanionClient.projectId
        let scroll = DemoCompanionClient.scrollThreadId
        XCTAssertEqual(model.archivedThreadCount, 0)
        XCTAssertEqual(model.visibleThreads(in: project).count, 3)

        let archived4 = await model.setArchived(true, threadId: DemoCompanionClient.launchThreadId)

        XCTAssertFalse(archived4, "A thread waiting for an answer cannot be put away.")
        XCTAssertNotNil(model.error)
        model.error = nil
        XCTAssertEqual(model.archivedThreadCount, 0)

        let archived5 = await model.setArchived(true, threadId: scroll)

        XCTAssertTrue(archived5)
        XCTAssertNil(model.error)
        XCTAssertEqual(model.archivedThreadCount, 1)
        XCTAssertFalse(model.visibleThreads(in: project).contains { $0.id == scroll }, "Archived demo threads are hidden by default too.")
        model.showArchived = true
        XCTAssertTrue(model.visibleThreads(in: project).contains { $0.id == scroll })
        let archived6 = await model.setArchived(false, threadId: scroll)
        XCTAssertTrue(archived6)
        XCTAssertNil(model.snapshot.threads.first { $0.id == scroll }?.archived)

        let archived7 = await model.setArchived(true, threadId: scroll)

        XCTAssertTrue(archived7)
        await model.select(scroll)
        model.draft = "Bring it back"
        await model.send()
        XCTAssertEqual(model.draft, "")
        XCTAssertNil(model.snapshot.threads.first { $0.id == scroll }?.archived, "A new message brings an archived thread back, as on the Mac.")
        XCTAssertEqual(model.archivedThreadCount, 0)

        model.disconnect()
        XCTAssertFalse(model.showArchived)
    }

    func testDemoThreadCreationAndSkillsNeedNoMac() async throws {
        let store = EmptyPairingStore()
        let discovery = RecordingDiscovery()
        let model = CompanionModel(store: store, discovery: discovery, makeClient: { _ in
            XCTFail("Demo creation and skills must not create a network client.")
            return UnreachableClient()
        })
        await model.startDemo()
        model.stopPolling()
        for provider in ["codex", "claude", "auto"] {
            let backend = provider == "auto" ? "codex" : provider
            await model.loadCommands(projectId: "demo", backend: backend)
            let commands = model.availableCommands(projectId: "demo", backend: backend)
            let skill = try XCTUnwrap(commands.first { $0.kind == "skill" })
            XCTAssertEqual(skill.insertion, backend == "claude" ? "/demo-review " : "$demo-review ")
            for worktree in [false, true] {
                model.newThreadDraft = skill.insertion + "Review this demo"
                let createdId = await model.createThread(projectId: "demo", worktree: worktree, provider: provider)
                let id = try XCTUnwrap(createdId)
                XCTAssertEqual(model.selectedThreadId, id)
                XCTAssertEqual(model.snapshot.threads.first { $0.id == id }?.backend, backend)
                XCTAssertEqual(model.snapshot.items.last?.text, skill.insertion + "Review this demo")
                XCTAssertEqual(model.snapshot.items.first?.kind, "notice")
                XCTAssertTrue(model.snapshot.items.first?.text?.contains(worktree ? "Worktree" : "Local") == true)
                XCTAssertEqual(model.newThreadDraft, "")
                XCTAssertNil(model.error)
            }
        }
        model.newThreadDraft = "Discard this demo draft"
        await model.startDemo()
        model.stopPolling()
        XCTAssertEqual(model.newThreadDraft, "")
        XCTAssertEqual(model.snapshot.threads.count, 3)
        XCTAssertTrue(model.commands.isEmpty)
        model.disconnect()
        XCTAssertFalse(store.saved)
        XCTAssertFalse(store.cleared)
        XCTAssertFalse(discovery.started)
    }

    func testDemoCommandsAndCreationRejectUnknownContext() async throws {
        let client = DemoCompanionClient()
        await XCTAssertThrowsErrorAsync(try await client.commands(projectId: "real-project", backend: "codex"))
        await XCTAssertThrowsErrorAsync(try await client.commands(projectId: "demo", backend: "unknown"))
        await XCTAssertThrowsErrorAsync(try await client.createThread(projectId: "real-project", text: "hello", worktree: false, provider: "codex"))
        await XCTAssertThrowsErrorAsync(try await client.createThread(projectId: "demo", text: "hello", worktree: false, provider: "unknown"))
        await XCTAssertThrowsErrorAsync(try await client.createThread(projectId: "demo", text: "  ", worktree: false, provider: "codex"))
        let snapshot = try await client.snapshot(threadId: nil)
        XCTAssertEqual(snapshot.threads.count, 3)
    }

    func testDemoRunningThreadFinishesOnItsOwn() async throws {
        let client = DemoCompanionClient(notesDelay: .zero)
        let before = try await client.snapshot(threadId: DemoCompanionClient.notesThreadId)
        XCTAssertEqual(before.threads.first { $0.id == DemoCompanionClient.notesThreadId }?.status, "idle")
        XCTAssertEqual(before.items.last?.kind, "assistant")
        try await client.send(threadId: DemoCompanionClient.notesThreadId, text: "Continue the notes")
        let followup = try await client.snapshot(threadId: DemoCompanionClient.notesThreadId)
        XCTAssertEqual(followup.threads.first { $0.id == DemoCompanionClient.notesThreadId }?.status, "running")
        XCTAssertEqual(followup.items.last?.text, "Continue the notes", "The seeded completion must not replay during a follow-up.")
        let fresh = DemoCompanionClient(notesDelay: .seconds(60))
        let pending = try await fresh.snapshot(threadId: DemoCompanionClient.notesThreadId)
        XCTAssertEqual(pending.threads.first { $0.id == DemoCompanionClient.notesThreadId }?.status, "running")
        await XCTAssertThrowsErrorAsync(try await fresh.send(threadId: DemoCompanionClient.notesThreadId, text: "Too early"))
    }

    func testDemoCannotEnterWhileAMacIsPaired() async {
        let model = CompanionModel(store: PairedStore(), discovery: RecordingDiscovery(), makeClient: { _ in UnreachableClient() })
        await model.startDemo()
        XCTAssertFalse(model.isDemo)
        XCTAssertNotNil(model.pairing)
    }

    func testDemoLinkIsExactAndNeverCreatesOrClearsPairing() async {
        let store = EmptyPairingStore()
        let model = CompanionModel(store: store, discovery: RecordingDiscovery(), makeClient: { _ in
            XCTFail("A demo link must never create a network client.")
            return UnreachableClient()
        })
        for link in ["https://demo", "modex://demo?host=evil", "modex://demo/path", "modex://demo#pair", "modex://user@demo"] {
            let accepted = await model.open(link: link)
            XCTAssertFalse(accepted)
            XCTAssertFalse(model.isDemo)
        }
        let accepted = await model.open(link: "modex://demo")
        XCTAssertTrue(accepted)
        model.stopPolling()
        await model.select(DemoCompanionClient.launchThreadId)
        await model.answer(itemId: "launch-approval", approve: false)
        XCTAssertEqual(model.snapshot.items.first { $0.id == "launch-approval" }?.answer, "no")
        await model.startDemo()
        model.stopPolling()
        await model.select(DemoCompanionClient.launchThreadId)
        XCTAssertNil(model.snapshot.items.first { $0.id == "launch-approval" }?.answer, "Reset restores the approval.")
        model.disconnect()
        XCTAssertFalse(store.saved)
        XCTAssertFalse(store.cleared, "Leaving a demo must not delete any saved Keychain entry.")
    }

    func testDemoLinkCannotReplaceSavedMac() async {
        let store = MemoryPairingStore()
        let original = store.pairing
        let model = CompanionModel(store: store, discovery: RecordingDiscovery(), makeClient: { _ in UnreachableClient() })
        let accepted = await model.open(link: "modex://demo")
        XCTAssertFalse(accepted)
        XCTAssertFalse(model.isDemo)
        XCTAssertEqual(model.pairing, original)
        XCTAssertEqual(store.pairing, original)
    }
}

private func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
    do {
        _ = try await expression()
        XCTFail("Expected an error.", file: file, line: line)
    } catch {}
}

private final class EmptyPairingStore: PairingStorage {
    var saved = false
    var cleared = false
    func load() -> Pairing? { nil }
    func save(_ pairing: Pairing) throws { saved = true }
    func clear() { cleared = true }
}

private final class PairedStore: PairingStorage {
    func load() -> Pairing? { Pairing(url: URL(string: "https://127.0.0.1:43120")!, token: String(repeating: "a", count: 64), fingerprint: String(repeating: "b", count: 64)) }
    func save(_ pairing: Pairing) throws {}
    func clear() {}
}

@MainActor private final class RecordingDiscovery: CompanionDiscovery {
    var started = false
    func start(fingerprint: String, found: @escaping (URL) -> Void) { started = true }
    func stop() {}
}

private struct UnreachableClient: CompanionClient {
    func createThread(projectId: String, text: String, worktree: Bool, provider: String) async throws -> CompanionThread { throw CompanionError.message("unreachable") }
    func commands(projectId: String, backend: String) async throws -> [CompanionCommand] { throw CompanionError.message("unreachable") }
    func snapshot(threadId: String?) async throws -> CompanionSnapshot { throw CompanionError.message("unreachable") }
    func send(threadId: String, text: String) async throws { throw CompanionError.message("unreachable") }
    func answer(threadId: String, itemId: String, approve: Bool) async throws { throw CompanionError.message("unreachable") }
}

/// Native question cards (docs/human-requests.md, CF-3 #276): the phone draws the Mac's questions, answers them
/// through the Mac's broker and keeps unsent answers, secrets included, only in memory.
@MainActor final class QuestionCardTests: XCTestCase {
    /// The Mac's `phoneItem` for an open Codex question, as the snapshot carries it.
    private static let openQuestionJSON = """
    {"id":"q1","kind":"question","at":"2026-10-22T00:00:00Z","blocking":true,"questions":[
      {"id":"q-env","header":"Environment","text":"Which environment?","options":[{"label":"staging","description":"Safe"},{"label":"production","description":""}],"allowOther":true,"secret":false},
      {"id":"q-token","header":"Token","text":"Paste the deploy token","options":null,"allowOther":true,"secret":true}]}
    """

    func testAQuestionCardDecodesItsQuestionsAndHowItClosed() throws {
        let open = try JSONDecoder().decode(CompanionItem.self, from: Data(Self.openQuestionJSON.utf8))
        XCTAssertEqual(open.kind, "question")
        XCTAssertEqual(open.questions?.map(\.id), ["q-env", "q-token"])
        XCTAssertEqual(open.questions?.first?.options?.map(\.label), ["staging", "production"])
        XCTAssertEqual(open.questions?.last?.options, nil)
        XCTAssertEqual(open.questions?.last?.secret, true)
        XCTAssertTrue(open.isOpenQuestion)

        let answered = try JSONDecoder().decode(CompanionItem.self, from: Data("""
        {"id":"q2","kind":"question","at":"now","blocking":true,"questions":[],"answers":{"q-token":["(hidden)"]},"answeredBy":"phone","delivery":"sent"}
        """.utf8))
        XCTAssertEqual(answered.answers, ["q-token": ["(hidden)"]])
        XCTAssertEqual(answered.answeredBy, "phone")
        XCTAssertEqual(answered.delivery, "sent")
        XCTAssertFalse(answered.isOpenQuestion)
        let withdrawn = try JSONDecoder().decode(CompanionItem.self, from: Data(#"{"id":"q3","kind":"question","at":"now","questions":[],"withdrawn":"stopped"}"#.utf8))
        XCTAssertFalse(withdrawn.isOpenQuestion)
        let sending = try JSONDecoder().decode(CompanionItem.self, from: Data(#"{"id":"q4","kind":"question","at":"now","questions":[],"delivery":"sending"}"#.utf8))
        XCTAssertFalse(sending.isOpenQuestion, "an answer the Mac took is never answerable again here")
    }

    func testAnsweringSendsEachQuestionsAnswerAndKeepsSecretWhitespace() async throws {
        let (model, client) = try questionFixture()
        await model.select("a")
        model.setQuestionDraft(itemId: "q1", questionId: "q-env", QuestionDraft(choice: "production"))
        model.setQuestionDraft(itemId: "q1", questionId: "q-token", QuestionDraft(text: "  tok 1  "))
        await model.answerQuestion(itemId: "q1")
        let sent = await client.sent
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.threadId, "a")
        XCTAssertEqual(sent.first?.answers, ["q-env": ["production"], "q-token": ["  tok 1  "]], "a secret is sent exactly as typed")
        XCTAssertNil(model.error)
        XCTAssertNil(model.answeringId)
        XCTAssertEqual(model.questionDraft(itemId: "q1", questionId: "q-token"), QuestionDraft(), "a sent answer leaves no draft")
    }

    func testOtherTextAnswersAChoiceQuestion() async throws {
        let (model, client) = try questionFixture()
        await model.select("a")
        model.setQuestionDraft(itemId: "q1", questionId: "q-env", QuestionDraft(choice: CompanionQuestion.otherChoice, text: " canary "))
        model.setQuestionDraft(itemId: "q1", questionId: "q-token", QuestionDraft(text: "t"))
        await model.answerQuestion(itemId: "q1")
        let sent = await client.sent
        XCTAssertEqual(sent.first?.answers["q-env"], ["canary"])
    }

    func testAnIncompleteAnswerIsRefusedHereAndNothingIsSent() async throws {
        let (model, client) = try questionFixture()
        await model.select("a")
        model.setQuestionDraft(itemId: "q1", questionId: "q-env", QuestionDraft(choice: "staging"))
        model.setQuestionDraft(itemId: "q1", questionId: "q-token", QuestionDraft(text: "   "))
        await model.answerQuestion(itemId: "q1")
        let sent = await client.sent
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(model.questionNotice, QuestionNotice(itemId: "q1", text: "Token needs an answer."), "said on the card, not as a connection problem")
        XCTAssertNil(model.error)
        model.setQuestionDraft(itemId: "q1", questionId: "q-token", QuestionDraft(text: "t"))
        XCTAssertNil(model.questionNotice, "editing the card clears its notice")
        XCTAssertEqual(model.questionDraft(itemId: "q1", questionId: "q-env"), QuestionDraft(choice: "staging"), "the rest of the draft stays")
    }

    func testARefusalShowsTheMacsReasonRereadsTheCardAndDropsTheClosedDraft() async throws {
        let (model, client) = try questionFixture()
        await model.select("a")
        model.setQuestionDraft(itemId: "q1", questionId: "q-env", QuestionDraft(choice: "staging"))
        model.setQuestionDraft(itemId: "q1", questionId: "q-token", QuestionDraft(text: "secret-xyz"))
        // Another client won: the Mac answers 409 and the card now reads as answered on the Mac.
        await client.refuse(with: "This question was already answered.", closing: true)
        let before = await client.snapshotRequests
        await model.answerQuestion(itemId: "q1")
        let after = await client.snapshotRequests
        XCTAssertEqual(model.error, "This question was already answered.")
        XCTAssertEqual(after, before + 1, "the phone reads the card again after a refusal")
        XCTAssertEqual(model.snapshot.items.first?.answeredBy, "desktop")
        XCTAssertEqual(model.questionDraft(itemId: "q1", questionId: "q-token"), QuestionDraft(), "a closed card's draft, and its secret, are gone")
    }

    func testDraftsSurviveSwitchingThreadsButNotDisconnecting() async throws {
        let (model, _) = try questionFixture()
        await model.select("a")
        model.setQuestionDraft(itemId: "q1", questionId: "q-token", QuestionDraft(text: "secret-xyz"))
        await model.select("b")
        await model.select("a")
        XCTAssertEqual(model.questionDraft(itemId: "q1", questionId: "q-token"), QuestionDraft(text: "secret-xyz"))
        model.disconnect()
        XCTAssertEqual(model.questionDraft(itemId: "q1", questionId: "q-token"), QuestionDraft(), "forgetting the Mac forgets unsent answers")
    }

    func testDraftsAreScopedToTheirThread() async throws {
        let (model, _) = try questionFixture()
        await model.select("a")
        model.setQuestionDraft(itemId: "q1", questionId: "q-token", QuestionDraft(text: "for a"))
        await model.select("b")
        XCTAssertEqual(model.questionDraft(itemId: "q1", questionId: "q-token"), QuestionDraft(), "another thread's card with the same id starts empty")
    }

    func testUnsentAnswersNeverReachUserDefaults() async throws {
        let suite = "modex-question-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let client = QuestionClient(item: try JSONDecoder().decode(CompanionItem.self, from: Data(Self.openQuestionJSON.utf8)))
        let model = CompanionModel(store: QuestionPairingStore(), discovery: QuestionDiscovery(), defaults: defaults, makeClient: { _ in client })
        await model.select("a")
        model.setQuestionDraft(itemId: "q1", questionId: "q-token", QuestionDraft(text: "secret-xyz"))
        await model.select("b")
        let stored = defaults.dictionaryRepresentation().map { "\($0.key)=\($0.value)" }.joined(separator: "\n")
        XCTAssertFalse(stored.contains("secret-xyz"))
        XCTAssertFalse(UserDefaults.standard.dictionaryRepresentation().description.contains("secret-xyz"))
    }

    func testTheNetworkClientNamesTheQuestionKindSoTheMacSendsCards() {
        XCTAssertTrue(CompanionAPI.itemKinds.split(separator: ",").contains("question"))
        XCTAssertTrue(CompanionAPI.itemKinds.split(separator: ",").contains("approval"))
    }

    private func questionFixture() throws -> (CompanionModel, QuestionClient) {
        let client = QuestionClient(item: try JSONDecoder().decode(CompanionItem.self, from: Data(Self.openQuestionJSON.utf8)))
        return (CompanionModel(store: QuestionPairingStore(), discovery: QuestionDiscovery(), makeClient: { _ in client }), client)
    }
}

@MainActor private final class QuestionDiscovery: CompanionDiscovery {
    func start(fingerprint: String, found: @escaping (URL) -> Void) {}
    func stop() {}
}

private final class QuestionPairingStore: PairingStorage {
    var pairing: Pairing? = Pairing(url: URL(string: "https://127.0.0.1:43120")!, token: String(repeating: "a", count: 64), fingerprint: String(repeating: "b", count: 64))
    func load() -> Pairing? { pairing }
    func save(_ pairing: Pairing) throws { self.pairing = pairing }
    func clear() { pairing = nil }
}

/// Two threads, each with one open question card "q1". Records every answer sent.
private actor QuestionClient: CompanionClient {
    private var item: CompanionItem
    private var refusal: (message: String, closing: Bool)?
    private(set) var sent: [(threadId: String, itemId: String, answers: [String: [String]])] = []
    private(set) var snapshotRequests = 0
    init(item: CompanionItem) { self.item = item }
    func refuse(with message: String, closing: Bool) { refusal = (message, closing) }
    func snapshot(threadId: String?) async throws -> CompanionSnapshot {
        snapshotRequests += 1
        let threads = ["a", "b"].map { CompanionThread(id: $0, projectId: "p", title: "Thread \($0)", backend: "codex", status: "waiting", updatedAt: "now") }
        return CompanionSnapshot(projects: [CompanionProject(id: "p", name: "Project")], threads: threads, items: threadId == nil ? [] : [item])
    }
    func answerQuestion(threadId: String, itemId: String, answers: [String: [String]]) async throws {
        if let refusal {
            if refusal.closing {
                var closed = item
                closed.answers = ["q-env": ["staging"], "q-token": ["(hidden)"]]
                closed.answeredBy = "desktop"
                closed.delivery = "sent"
                item = closed
            }
            throw CompanionError.message(refusal.message)
        }
        sent.append((threadId, itemId, answers))
    }
    func createThread(projectId: String, text: String, worktree: Bool, provider: String) async throws -> CompanionThread { throw CompanionError.message("unused") }
    func commands(projectId: String, backend: String) async throws -> [CompanionCommand] { [] }
    func send(threadId: String, text: String) async throws {}
    func answer(threadId: String, itemId: String, approve: Bool) async throws {}
}
