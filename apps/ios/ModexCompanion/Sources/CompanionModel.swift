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

    private var api: (any CompanionClient)?
    private let store: any PairingStorage
    private let makeClient: (Pairing) -> any CompanionClient
    private var pollTask: Task<Void, Never>?
    private var drafts: [String: String] = [:]
    private var connectionRevision = 0
    private var refreshRevision = 0
    private var pairingRevision = 0
    private var sendOperation: UUID?
    private var answerOperation: UUID?

    init(store: any PairingStorage = PairingStore(), makeClient: @escaping (Pairing) -> any CompanionClient = { CompanionAPI(pairing: $0) }) {
        self.store = store
        self.makeClient = makeClient
        pairing = store.load()
        if let pairing { api = makeClient(pairing) }
    }

    func startPolling() {
        guard pollTask == nil, pairing != nil else { return }
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
    }

    func pair(link: String) async {
        pairingRevision += 1
        let attempt = pairingRevision
        do {
            let candidate = try Pairing.from(link: link)
            let client = makeClient(candidate)
            let first = try await client.snapshot(threadId: nil)
            guard attempt == pairingRevision, !Task.isCancelled else { return }
            try store.save(candidate)
            stopPolling()
            invalidateConnection()
            pairing = candidate
            api = client
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
        invalidateConnection()
        store.clear()
        pairing = nil
        api = nil
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
        guard let api else { return }
        let connection = connectionRevision
        let threadId = selectedThreadId
        refreshRevision += 1
        let request = refreshRevision
        do {
            let result = try await api.snapshot(threadId: threadId)
            guard connection == connectionRevision, request == refreshRevision,
                  threadId == selectedThreadId, !Task.isCancelled else { return }
            snapshot = result
            connected = true
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
            connected = false
            connectionError = error.localizedDescription
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
            if connection == connectionRevision, sendOperation == operation { self.error = error.localizedDescription }
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
            if connection == connectionRevision, answerOperation == operation { self.error = error.localizedDescription }
        }
    }
}
