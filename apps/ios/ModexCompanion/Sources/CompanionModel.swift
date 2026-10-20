import Foundation
import SwiftUI

@MainActor final class CompanionModel: ObservableObject {
    @Published private(set) var pairing: Pairing?
    @Published private(set) var snapshot = CompanionSnapshot(projects: [], threads: [], items: [])
    @Published private(set) var selectedThreadId: String?
    @Published private(set) var connected = false
    @Published private(set) var connectionError: String?
    @Published var error: String?
    @Published var draft = ""
    @Published var newThreadDraft = ""
    @Published var sending = false
    @Published private(set) var creatingThread = false
    @Published private(set) var commands: [CompanionCommand] = []
    @Published var answeringId: String?
    @Published private(set) var isPairing = false
    /// True while showing the offline scripted workspace. It never coexists with a saved pairing.
    @Published private(set) var isDemo = false
    /// Archived threads stay hidden on the phone until asked for. Hidden again with every new workspace.
    @Published var showArchived = false
    /// A routine run on the Mac finished or failed since this phone last looked.
    @Published private(set) var routineNotice: RoutineNotice?

    private var api: (any CompanionClient)?
    private let store: any PairingStorage
    private let makeClient: (Pairing) -> any CompanionClient
    private let discovery: any CompanionDiscovery
    private let defaults: UserDefaults
    private var discoveredURLs: [URL] = []
    private var retrySavedEndpoint = false
    private var pollTask: Task<Void, Never>?
    /// The journal cursor `snapshot.items` was read at, and for which thread. Cleared whenever those
    /// items are replaced, so a delta only ever merges into the transcript it was computed against.
    private var journal: (cursor: JournalCursor, threadId: String)?
    private var drafts: [String: String] = [:]
    private var connectionRevision = 0
    private var refreshRevision = 0
    private var pairingRevision = 0
    private var sendOperation: UUID?
    private var createOperation: UUID?
    private var answerOperation: UUID?
    private var commandOperation: UUID?
    private var commandContext: String?

    init(store: any PairingStorage = PairingStore(), discovery: (any CompanionDiscovery)? = nil, defaults: UserDefaults = .standard, makeClient: @escaping (Pairing) -> any CompanionClient = { CompanionAPI(pairing: $0) }) {
        self.store = store
        self.defaults = defaults
        self.discovery = discovery ?? BonjourCompanionDiscovery()
        self.makeClient = makeClient
        pairing = store.load()
        if let pairing { api = makeClient(pairing) }
    }

    /// Whether there is a workspace to show: a paired Mac or the demo.
    var hasWorkspace: Bool { pairing != nil || isDemo }

    /// Threads the dashboard lists for a project: archived ones only while they are shown.
    func visibleThreads(in projectId: String) -> [CompanionThread] {
        snapshot.threads.filter { $0.projectId == projectId && (showArchived || $0.archived != true) }
    }

    var visibleThreadCount: Int { snapshot.threads.filter { showArchived || $0.archived != true }.count }
    var archivedThreadCount: Int { snapshot.threads.filter { $0.archived == true }.count }

    func startPolling() {
        guard pollTask == nil, api != nil else { return }
        if let pairing {
            connected = false
            discovery.start(fingerprint: pairing.fingerprint) { [weak self] url in
                guard let self, Pairing.validEndpoint(url), !self.discoveredURLs.contains(url) else { return }
                self.discoveredURLs.append(url)
                // Bound untrusted advertisements while allowing newer addresses to enter recovery.
                if self.discoveredURLs.count > 16 { self.discoveredURLs.removeFirst() }
                // Polling owns retries; discovery must not cancel or supersede an in-flight request.
            }
        }
        pollTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(2.5))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        discovery.stop()
    }

    /// Demo QR links carry no credentials. Every other link still uses pinned Mac pairing.
    func open(link: String) async -> Bool {
        if link.trimmingCharacters(in: .whitespacesAndNewlines) == "modex://demo" {
            guard pairing == nil, !isPairing else {
                error = "Keep your paired workspace, or forget that Mac before opening the demo."
                return false
            }
            if !isDemo { await startDemo() }
            return isDemo
        }
        await pair(link: link)
        return pairing != nil && error == nil
    }

    func pair(link: String) async {
        pairingRevision += 1
        let attempt = pairingRevision
        isPairing = true
        defer { if attempt == pairingRevision { isPairing = false } }
        do {
            let candidate = try Pairing.from(link: link)
            let client = makeClient(candidate)
            var adopted = false
            defer { if !adopted { client.invalidate() } }
            let first = try await client.pairingSnapshot()
            guard attempt == pairingRevision, !Task.isCancelled else { return }
            try store.save(candidate)
            let recoveringSameMac = pairing?.fingerprint == candidate.fingerprint
            stopPolling()
            invalidateConnection()
            pairing = candidate
            isDemo = false
            api?.invalidate()
            api = client
            adopted = true
            discoveredURLs = []
            snapshot = first
            if !recoveringSameMac {
                selectedThreadId = nil
                draft = ""
                newThreadDraft = ""
                drafts = [:]
                showArchived = false
            } else if let selectedThreadId, !first.threads.contains(where: { $0.id == selectedThreadId }) {
                // A rescan of the same pinned Mac keeps unsent work, except for a deleted thread.
                self.selectedThreadId = nil
                draft = ""
                drafts.removeValue(forKey: selectedThreadId)
            }
            connected = true
            connectionError = nil
            error = nil
            startPolling()
        } catch {
            guard attempt == pairingRevision, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    /// Open the scripted demo workspace. It replaces nothing persistent: the Keychain is
    /// untouched and leaving the demo returns to the welcome screen.
    func startDemo() async {
        guard pairing == nil, !isPairing else { return }
        let connection = connectionRevision
        let attempt = pairingRevision
        let client = DemoCompanionClient()
        guard let first = try? await client.snapshot(threadId: nil), pairing == nil, !isPairing,
              connection == connectionRevision, attempt == pairingRevision, !Task.isCancelled else { return }
        stopPolling()
        invalidateConnection()
        api?.invalidate()
        api = client
        isDemo = true
        discoveredURLs = []
        snapshot = first
        selectedThreadId = nil
        draft = ""
        newThreadDraft = ""
        drafts = [:]
        showArchived = false
        connected = true
        connectionError = nil
        error = nil
        startPolling()
    }

    func disconnect() {
        stopPolling()
        pairingRevision += 1
        isPairing = false
        invalidateConnection()
        if pairing != nil { store.clear() }
        pairing = nil
        isDemo = false
        api?.invalidate()
        api = nil
        discoveredURLs = []
        connected = false
        selectedThreadId = nil
        draft = ""
        newThreadDraft = ""
        drafts = [:]
        showArchived = false
        snapshot = CompanionSnapshot(projects: [], threads: [], items: [])
        error = nil
        connectionError = nil
    }

    private func invalidateConnection() {
        journal = nil
        routineNotice = nil
        connectionRevision += 1
        refreshRevision += 1
        sendOperation = nil
        createOperation = nil
        answerOperation = nil
        commandOperation = nil
        commandContext = nil
        retrySavedEndpoint = false
        sending = false
        answeringId = nil
        creatingThread = false
        commands = []
    }

    func select(_ threadId: String) async {
        if let selectedThreadId { drafts[selectedThreadId] = draft }
        if selectedThreadId != threadId {
            journal = nil
            snapshot = CompanionSnapshot(projects: snapshot.projects, threads: snapshot.threads, items: [], defaultBackend: snapshot.defaultBackend, autoByDefault: snapshot.autoByDefault)
        }
        selectedThreadId = threadId
        draft = drafts[threadId] ?? ""
        await refresh()
    }

    func refresh() async {
        guard let api, !Task.isCancelled else { return }
        let candidate = pairing.flatMap { pairing -> Pairing? in
            guard !connected else { return nil }
            if retrySavedEndpoint {
                retrySavedEndpoint = false
                return nil
            }
            guard let index = discoveredURLs.firstIndex(where: { $0 != pairing.url }) else { return nil }
            let url = discoveredURLs.remove(at: index)
            discoveredURLs.append(url)
            // Alternate the saved address with a fair rotation of advertised candidates.
            retrySavedEndpoint = true
            return Pairing(url: url, token: pairing.token, fingerprint: pairing.fingerprint)
        }
        let client = candidate.map(makeClient) ?? api
        var adopted = false
        defer { if candidate != nil && !adopted { client.invalidate() } }
        let connection = connectionRevision
        let threadId = selectedThreadId
        let after = journal.flatMap { $0.threadId == threadId ? $0.cursor : nil }
        refreshRevision += 1
        let request = refreshRevision
        do {
            let response = try await client.snapshot(threadId: threadId, after: after)
            guard connection == connectionRevision, request == refreshRevision,
                  threadId == selectedThreadId, !Task.isCancelled else { return }
            // Only the newest request applies, so `snapshot.items` is still what `after` describes.
            let items = response.delta && after != nil ? CompanionSnapshot.merge(snapshot.items, changed: response.items) : response.items
            journal = threadId.flatMap { id in response.journal.map { (cursor: $0, threadId: id) } }
            let result = CompanionSnapshot(projects: response.projects, threads: response.threads, items: items, defaultBackend: response.defaultBackend, autoByDefault: response.autoByDefault)
            if let candidate {
                // Save a new address only after the original pinned certificate and token succeed.
                try store.save(candidate)
                self.pairing = candidate
                api.invalidate()
                self.api = client
                adopted = true
            }
            // Rebuilding an unchanged workspace replaces open menu actions during polling.
            if snapshot != result { snapshot = result }
            if !connected { connected = true }
            noticeRoutineRuns(response.routineRuns)
            retrySavedEndpoint = false
            if connectionError != nil { connectionError = nil }
            if let selectedThreadId, !result.threads.contains(where: { $0.id == selectedThreadId }) {
                journal = nil
                self.selectedThreadId = nil
                draft = ""
                drafts.removeValue(forKey: selectedThreadId)
                snapshot = CompanionSnapshot(projects: result.projects, threads: result.threads, items: [], defaultBackend: result.defaultBackend, autoByDefault: result.autoByDefault)
            }
        } catch {
            guard connection == connectionRevision, request == refreshRevision,
                  threadId == selectedThreadId, !Task.isCancelled else { return }
            if revokeIfNeeded(error) { return }
            if connected { connected = false }
            let message = "Keep Modex open on your Mac and use the same network. Still disconnected? Open iPhone companion on your Mac and scan its pairing code again."
            if connectionError != message { connectionError = message }
        }
    }

    /// Says once that routine runs ended since the last look, however many there were. The first
    /// look at a Mac only remembers where it is, so pairing never replays old runs.
    private func noticeRoutineRuns(_ runs: [CompanionRoutineRun]) {
        guard let pairing else { return }
        let key = "routineRunsSeen.\(pairing.fingerprint)"
        let newest = runs.map(\.endedAt).max()
        // A Mac with no runs yet sets the mark too, so its first runs are news.
        guard let seen = defaults.string(forKey: key) else {
            defaults.set(newest ?? "", forKey: key)
            return
        }
        let fresh = runs.filter { $0.endedAt > seen }
        guard let newest, !fresh.isEmpty else { return }
        defaults.set(newest, forKey: key)
        routineNotice = RoutineNotice(runs: fresh)
    }

    func dismissRoutineNotice() { routineNotice = nil }

    func send() async {
        guard let api, let threadId = selectedThreadId else { return }
        let submittedDraft = draft
        let text = submittedDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        let connection = connectionRevision
        let operation = UUID()
        sendOperation = operation
        sending = true
        defer { if sendOperation == operation { sending = false; sendOperation = nil } }
        do {
            try await api.send(threadId: threadId, text: text)
            guard connection == connectionRevision, sendOperation == operation else { return }
            if selectedThreadId == threadId {
                if draft == submittedDraft { draft = "" }
                drafts[threadId] = draft
            } else if drafts[threadId] == submittedDraft {
                drafts[threadId] = ""
            }
            await refresh()
        } catch {
            if connection == connectionRevision, sendOperation == operation, !revokeIfNeeded(error) { self.error = error.localizedDescription }
        }
    }

    func createThread(projectId: String, worktree: Bool, provider: String) async -> String? {
        guard let api, !creatingThread else { return nil }
        let submittedDraft = newThreadDraft
        let text = submittedDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let connection = connectionRevision
        let operation = UUID()
        createOperation = operation
        creatingThread = true
        defer { if createOperation == operation { creatingThread = false; createOperation = nil } }
        do {
            let thread = try await api.createThread(projectId: projectId, text: text, worktree: worktree, provider: provider)
            guard connection == connectionRevision, createOperation == operation else { return nil }
            if newThreadDraft == submittedDraft { newThreadDraft = "" }
            await select(thread.id)
            guard connection == connectionRevision, createOperation == operation else { return nil }
            return thread.id
        } catch {
            if connection == connectionRevision, createOperation == operation, !revokeIfNeeded(error) { self.error = error.localizedDescription }
            return nil
        }
    }

    func loadCommands(projectId: String, backend: String) async {
        guard let api, !Task.isCancelled else { return }
        let connection = connectionRevision
        let operation = UUID()
        let context = "\(projectId)\u{0}\(backend)"
        commandOperation = operation
        if commandContext != context { commands = [] }
        do {
            let result = try await api.commands(projectId: projectId, backend: backend)
            if connection == connectionRevision, commandOperation == operation, !Task.isCancelled {
                commands = result
                commandContext = context
            }
        } catch {
            if connection == connectionRevision, commandOperation == operation, !Task.isCancelled, !revokeIfNeeded(error) { self.error = error.localizedDescription }
        }
    }

    func availableCommands(projectId: String, backend: String) -> [CompanionCommand] {
        commandContext == "\(projectId)\u{0}\(backend)" ? commands : []
    }

    func answer(itemId: String, approve: Bool) async {
        guard let api, let selectedThreadId, answeringId == nil else { return }
        let connection = connectionRevision
        let operation = UUID()
        answerOperation = operation
        answeringId = itemId
        defer { if answerOperation == operation { answeringId = nil; answerOperation = nil } }
        do {
            try await api.answer(threadId: selectedThreadId, itemId: itemId, approve: approve)
            guard connection == connectionRevision, answerOperation == operation else { return }
            await refresh()
        } catch {
            await refused(error, connection: connection, operation: operation)
        }
    }

    /// "ask", "always" or "yolo" for the selected thread. The Mac applies it to what is already waiting for "yolo" only.
    func setApprovals(_ policy: String) async {
        guard let api, let selectedThreadId else { return }
        let connection = connectionRevision
        do {
            try await api.setApprovals(threadId: selectedThreadId, policy: policy)
            guard connection == connectionRevision else { return }
            await refresh()
        } catch {
            if connection == connectionRevision, !revokeIfNeeded(error) { self.error = error.localizedDescription }
        }
    }

    /// Puts a thread away or brings it back. True once the Mac confirmed and the workspace refreshed.
    func setArchived(_ archived: Bool, threadId: String) async -> Bool {
        guard let api else { return false }
        let connection = connectionRevision
        do {
            try await api.setArchived(threadId: threadId, archived: archived)
            guard connection == connectionRevision else { return false }
            await refresh()
            return connection == connectionRevision
        } catch {
            if connection == connectionRevision, !revokeIfNeeded(error) { self.error = error.localizedDescription }
            return false
        }
    }

    /// Approve this request and everything else in the thread except extra sandbox access.
    func approveAlways(itemId: String) async {
        guard let api, let selectedThreadId, answeringId == nil else { return }
        let connection = connectionRevision
        let operation = UUID()
        answerOperation = operation
        answeringId = itemId
        defer { if answerOperation == operation { answeringId = nil; answerOperation = nil } }
        do {
            try await api.setApprovals(threadId: selectedThreadId, policy: "always")
            guard connection == connectionRevision, answerOperation == operation else { return }
            try await api.answer(threadId: selectedThreadId, itemId: itemId, approve: true)
            guard connection == connectionRevision, answerOperation == operation else { return }
            await refresh()
        } catch {
            await refused(error, connection: connection, operation: operation)
        }
    }

    /// An answer the Mac did not take. It most often refuses because the request was answered on the Mac,
    /// withdrawn or stopped, so the card is read again rather than left actionable until the next poll.
    private func refused(_ failure: Error, connection: Int, operation: UUID) async {
        guard connection == connectionRevision, answerOperation == operation, !revokeIfNeeded(failure) else { return }
        error = failure.localizedDescription
        await refresh()
    }

    private func revokeIfNeeded(_ failure: Error) -> Bool {
        guard case CompanionError.accessRevoked = failure else { return false }
        disconnect()
        error = failure.localizedDescription
        return true
    }
}

/// What the phone says about routine runs that ended: one line, never one alert per run.
struct RoutineNotice: Equatable {
    let text: String
    /// The thread of the newest run, to open from the notice.
    let threadId: String?
    let failed: Bool

    init(runs: [CompanionRoutineRun]) {
        let newest = runs.max { $0.endedAt < $1.endedAt }!
        let unsuccessful = runs.filter { $0.status != "completed" }
        failed = !unsuccessful.isEmpty
        threadId = newest.threadId
        if runs.count == 1 {
            switch newest.status {
            case "completed": text = "Routine “\(newest.routine)” finished."
            case "interrupted": text = "Routine “\(newest.routine)” was interrupted."
            default: text = "Routine “\(newest.routine)” failed."
            }
        } else {
            let names = Array(Set(runs.map(\.routine))).sorted().joined(separator: ", ")
            text = unsuccessful.isEmpty
                ? "\(runs.count) routine runs finished: \(names)."
                : "\(runs.count) routine runs ended, \(unsuccessful.count) without finishing: \(names)."
        }
    }
}
