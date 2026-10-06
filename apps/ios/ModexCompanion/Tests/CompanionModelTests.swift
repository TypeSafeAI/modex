import Foundation
import XCTest
@testable import ModexCompanion

@MainActor final class CompanionModelTests: XCTestCase {
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
        await fulfillment(of: [pending.requested], timeout: 2)
        model.disconnect()
        await pending.resolve(.success(makeSnapshot(nil)))
        await pairing.value
        XCTAssertNil(model.pairing)
        XCTAssertNil(store.pairing)
        XCTAssertFalse(model.connected)
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

    private func fixture() -> (CompanionModel, ControlledClient) {
        let client = ControlledClient()
        return (CompanionModel(store: MemoryPairingStore(), discovery: FakeDiscovery(), makeClient: { _ in client }), client)
    }
}

@MainActor private final class FakeDiscovery: CompanionDiscovery {
    var endpoint: URL?
    var stopped = false
    func start(fingerprint: String, found: @escaping (URL) -> Void) {
        stopped = false
        if let endpoint { found(endpoint) }
    }
    func stop() { stopped = true }
}

private final class MemoryPairingStore: PairingStorage {
    var pairing: Pairing? = Pairing(url: URL(string: "https://127.0.0.1:43120")!, token: String(repeating: "a", count: 64), fingerprint: String(repeating: "b", count: 64))
    func load() -> Pairing? { pairing }
    func save(_ pairing: Pairing) throws { self.pairing = pairing }
    func clear() { pairing = nil }
}

private actor Pending<Value> {
    nonisolated let requested: XCTestExpectation
    private var continuation: CheckedContinuation<Value, Error>?
    init(requested: XCTestExpectation) { self.requested = requested }
    func value() async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            requested.fulfill()
        }
    }
    func resolve(_ result: Result<Value, Error>) { continuation?.resume(with: result); continuation = nil }
}

private actor ControlledClient: CompanionClient {
    private var snapshots: [Pending<CompanionSnapshot>] = []
    private var sends: [Pending<Void>] = []
    private var answers: [Pending<Void>] = []
    private var commandLists: [Pending<[CompanionCommand]>] = []
    private var creations: [Pending<CompanionThread>] = []
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
    func snapshot(threadId: String?) async throws -> CompanionSnapshot {
        if !snapshots.isEmpty { return try await snapshots.removeFirst().value() }
        if let createdThread {
            return CompanionSnapshot(projects: [CompanionProject(id: "p", name: "Project")], threads: [createdThread], items: [])
        }
        return makeSnapshot(threadId)
    }
    func send(threadId: String, text: String) async throws {
        if !sends.isEmpty { try await sends.removeFirst().value() }
    }
    func answer(threadId: String, itemId: String, approve: Bool) async throws {
        if !answers.isEmpty { try await answers.removeFirst().value() }
    }
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

private func makeSnapshot(_ threadId: String?) -> CompanionSnapshot {
    let threads = ["a", "b"].map { CompanionThread(id: $0, projectId: "p", title: "Thread \($0)", backend: "mock", status: "idle", updatedAt: "2026-10-04T00:00:00Z") }
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
