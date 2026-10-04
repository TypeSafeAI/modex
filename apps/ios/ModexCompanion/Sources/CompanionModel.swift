import Foundation
import SwiftUI

@MainActor final class CompanionModel: ObservableObject {
    @Published private(set) var pairing: Pairing? = PairingStore.load()
    @Published private(set) var snapshot = CompanionSnapshot(projects: [], threads: [], items: [])
    @Published private(set) var selectedThreadId: String?
    @Published private(set) var connected = false
    @Published private(set) var connectionError: String?
    @Published var error: String?
    @Published var draft = ""
    @Published var sending = false
    @Published var answeringId: String?

    private var api: CompanionAPI?
    private var pollTask: Task<Void, Never>?
    private var drafts: [String: String] = [:]

    init() {
        if let pairing { api = CompanionAPI(pairing: pairing) }
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
        do {
            let candidate = try Pairing.from(link: link)
            let client = CompanionAPI(pairing: candidate)
            let first = try await client.snapshot()
            try PairingStore.save(candidate)
            pairing = candidate
            api = client
            snapshot = first
            selectedThreadId = nil
            connected = true
            connectionError = nil
            error = nil
            startPolling()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func disconnect() {
        stopPolling()
        PairingStore.clear()
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

    func select(_ threadId: String) async {
        if let selectedThreadId { drafts[selectedThreadId] = draft }
        selectedThreadId = threadId
        draft = drafts[threadId] ?? ""
        await refresh()
    }

    func refresh() async {
        guard let api else { return }
        do {
            let result = try await api.snapshot(threadId: selectedThreadId)
            snapshot = result
            connected = true
            connectionError = nil
            if let selectedThreadId, !result.threads.contains(where: { $0.id == selectedThreadId }) {
                self.selectedThreadId = nil
            }
        } catch {
            connected = false
            connectionError = error.localizedDescription
        }
    }

    func send() async {
        guard let api, let selectedThreadId else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        defer { sending = false }
        do {
            try await api.send(threadId: selectedThreadId, text: text)
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            drafts[selectedThreadId] = draft
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func answer(itemId: String, approve: Bool) async {
        guard let api, let selectedThreadId, answeringId == nil else { return }
        answeringId = itemId
        defer { answeringId = nil }
        do {
            try await api.answer(threadId: selectedThreadId, itemId: itemId, approve: approve)
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
}
