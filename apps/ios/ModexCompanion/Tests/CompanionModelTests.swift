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
    nonisolated(unsafe) var createdThread: CompanionThread?
    nonisolated(unsafe) var createdProjectId: String?
    nonisolated(unsafe) var createdText: String?
    nonisolated(unsafe) var createdWorktree: Bool?
    nonisolated(unsafe) var createdProvider: String?
    func enqueueSnapshot(_ pending: Pending<CompanionSnapshot>) { snapshots.append(pending) }
    func enqueueSend(_ pending: Pending<Void>) { sends.append(pending) }
    func enqueueAnswer(_ pending: Pending<Void>) { answers.append(pending) }
    func enqueueCommands(_ pending: Pending<[CompanionCommand]>) { commandLists.append(pending) }
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
