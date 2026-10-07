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

    private var api: (any CompanionClient)?
    private let store: any PairingStorage
    private let makeClient: (Pairing) -> any CompanionClient
    private let discovery: any CompanionDiscovery
    private var discoveredURL: URL?
    private var retrySavedEndpoint = false
    private var discoveryTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var drafts: [String: String] = [:]
    private var connectionRevision = 0
    private var refreshRevision = 0
    private var pairingRevision = 0
    private var sendOperation: UUID?
    private var createOperation: UUID?
    private var answerOperation: UUID?
    private var commandOperation: UUID?
    private var commandContext: String?

    init(store: any PairingStorage = PairingStore(), discovery: (any CompanionDiscovery)? = nil, makeClient: @escaping (Pairing) -> any CompanionClient = { CompanionAPI(pairing: $0) }) {
        self.store = store
        self.discovery = discovery ?? BonjourCompanionDiscovery()
        self.makeClient = makeClient
        pairing = store.load()
        if let pairing { api = makeClient(pairing) }
    }

    /// Whether there is a workspace to show: a paired Mac or the demo.
    var hasWorkspace: Bool { pairing != nil || isDemo }

    func startPolling() {
        guard pollTask == nil, api != nil else { return }
        if let pairing {
            connected = false
            discovery.start(fingerprint: pairing.fingerprint) { [weak self] url in
                guard let self, Pairing.validEndpoint(url) else { return }
                if self.discoveredURL != url { self.retrySavedEndpoint = false }
                self.discoveredURL = url
                if !self.connected {
                    self.discoveryTask?.cancel()
                    self.discoveryTask = Task { await self.refresh() }
                }
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
        discoveryTask?.cancel()
        discoveryTask = nil
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
            let first = try await client.snapshot(threadId: nil)
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
            discoveredURL = nil
            snapshot = first
            if !recoveringSameMac {
                selectedThreadId = nil
                draft = ""
                newThreadDraft = ""
                drafts = [:]
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
        discoveredURL = nil
        snapshot = first
        selectedThreadId = nil
        draft = ""
        newThreadDraft = ""
        drafts = [:]
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
        discoveredURL = nil
        connected = false
        selectedThreadId = nil
        draft = ""
        newThreadDraft = ""
        drafts = [:]
        snapshot = CompanionSnapshot(projects: [], threads: [], items: [])
        error = nil
        connectionError = nil
    }

    private func invalidateConnection() {
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
            snapshot = CompanionSnapshot(projects: snapshot.projects, threads: snapshot.threads, items: [], defaultBackend: snapshot.defaultBackend, autoByDefault: snapshot.autoByDefault)
        }
        selectedThreadId = threadId
        draft = drafts[threadId] ?? ""
        await refresh()
    }

    func refresh() async {
        guard let api, !Task.isCancelled else { return }
        let candidate = pairing.flatMap { pairing in
            !connected && !retrySavedEndpoint && discoveredURL != nil && discoveredURL != pairing.url
                ? Pairing(url: discoveredURL!, token: pairing.token, fingerprint: pairing.fingerprint) : nil
        }
        let client = candidate.map(makeClient) ?? api
        var adopted = false
        defer { if candidate != nil && !adopted { client.invalidate() } }
        let connection = connectionRevision
        let threadId = selectedThreadId
        refreshRevision += 1
        let request = refreshRevision
        do {
            let result = try await client.snapshot(threadId: threadId)
            guard connection == connectionRevision, request == refreshRevision,
                  threadId == selectedThreadId, !Task.isCancelled else { return }
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
            retrySavedEndpoint = false
            if connectionError != nil { connectionError = nil }
            if let selectedThreadId, !result.threads.contains(where: { $0.id == selectedThreadId }) {
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
            // An untrusted/stale advertisement must not starve the saved address forever.
            retrySavedEndpoint = candidate != nil
            let message = "Keep Modex open on your Mac and use the same network. Still disconnected? Open iPhone companion on your Mac and scan its pairing code again."
            if connectionError != message { connectionError = message }
        }
    }

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
            if connection == connectionRevision, answerOperation == operation, !revokeIfNeeded(error) { self.error = error.localizedDescription }
        }
    }

    private func revokeIfNeeded(_ failure: Error) -> Bool {
        guard case CompanionError.accessRevoked = failure else { return false }
        disconnect()
        error = failure.localizedDescription
        return true
    }
}
