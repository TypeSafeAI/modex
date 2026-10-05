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
    @Published var sending = false
    @Published var answeringId: String?
    @Published private(set) var isPairing = false

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
    private var answerOperation: UUID?

    init(store: any PairingStorage = PairingStore(), discovery: (any CompanionDiscovery)? = nil, makeClient: @escaping (Pairing) -> any CompanionClient = { CompanionAPI(pairing: $0) }) {
        self.store = store
        self.discovery = discovery ?? BonjourCompanionDiscovery()
        self.makeClient = makeClient
        pairing = store.load()
        if let pairing { api = makeClient(pairing) }
    }

    func startPolling() {
        guard pollTask == nil, let pairing else { return }
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
            stopPolling()
            invalidateConnection()
            pairing = candidate
            api?.invalidate()
            api = client
            adopted = true
            discoveredURL = nil
            snapshot = first
            selectedThreadId = nil
            draft = ""
            drafts = [:]
            connected = true
            connectionError = nil
            error = nil
            startPolling()
        } catch {
            guard attempt == pairingRevision, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func disconnect() {
        stopPolling()
        pairingRevision += 1
        isPairing = false
        invalidateConnection()
        store.clear()
        pairing = nil
        api?.invalidate()
        api = nil
        discoveredURL = nil
        connected = false
        selectedThreadId = nil
        draft = ""
        drafts = [:]
        snapshot = CompanionSnapshot(projects: [], threads: [], items: [])
        error = nil
        connectionError = nil
    }

    private func invalidateConnection() {
        connectionRevision += 1
        refreshRevision += 1
        sendOperation = nil
        answerOperation = nil
        retrySavedEndpoint = false
        sending = false
        answeringId = nil
    }

    func select(_ threadId: String) async {
        if let selectedThreadId { drafts[selectedThreadId] = draft }
        if selectedThreadId != threadId {
            snapshot = CompanionSnapshot(projects: snapshot.projects, threads: snapshot.threads, items: [])
        }
        selectedThreadId = threadId
        draft = drafts[threadId] ?? ""
        await refresh()
    }

    func refresh() async {
        guard let api, let pairing, !Task.isCancelled else { return }
        let candidate = !connected && !retrySavedEndpoint && discoveredURL != nil && discoveredURL != pairing.url
            ? Pairing(url: discoveredURL!, token: pairing.token, fingerprint: pairing.fingerprint) : nil
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
            snapshot = result
            connected = true
            retrySavedEndpoint = false
            connectionError = nil
            if let selectedThreadId, !result.threads.contains(where: { $0.id == selectedThreadId }) {
                self.selectedThreadId = nil
                draft = ""
                drafts.removeValue(forKey: selectedThreadId)
                snapshot = CompanionSnapshot(projects: result.projects, threads: result.threads, items: [])
            }
        } catch {
            guard connection == connectionRevision, request == refreshRevision,
                  threadId == selectedThreadId, !Task.isCancelled else { return }
            if revokeIfNeeded(error) { return }
            connected = false
            // An untrusted/stale advertisement must not starve the saved address forever.
            retrySavedEndpoint = candidate != nil
            connectionError = "Your Mac is temporarily unavailable. Pairing is saved; reconnecting automatically."
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
