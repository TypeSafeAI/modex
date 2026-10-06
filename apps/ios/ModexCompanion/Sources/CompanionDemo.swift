import Foundation

/// A scripted, offline workspace so App Review and first-time users can explore the app
/// without a paired Mac. It opens no network connection and nothing it shows runs anywhere:
/// approvals and follow-ups only update this in-memory script.
actor DemoCompanionClient: CompanionClient {
    static let projectId = "demo"
    static let launchThreadId = "demo-launch"
    static let scrollThreadId = "demo-scroll"
    static let notesThreadId = "demo-notes"

    private struct Entry {
        var thread: CompanionThread
        var items: [CompanionItem]
    }

    private let project = CompanionProject(id: DemoCompanionClient.projectId, name: "Modex demo")
    private var entries: [Entry]
    private let notesFinishAt: Date
    private var notesFinished = false
    private var sequence = 0

    init(now: Date = .now, notesDelay: Duration = .seconds(6)) {
        notesFinishAt = now.addingTimeInterval(Double(notesDelay.components.seconds) + Double(notesDelay.components.attoseconds) / 1e18)
        let stamp = Self.stamp(now)
        entries = [
            Entry(
                thread: CompanionThread(id: Self.launchThreadId, projectId: Self.projectId, title: "Review launch changes", backend: "claude", status: "waiting", updatedAt: stamp),
                items: [
                    CompanionItem(id: "launch-1", kind: "user", text: "Review the landing page changes and fix the iPhone line.", title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: stamp),
                    CompanionItem(id: "launch-2", kind: "tool", text: nil, title: "Read apps/site/index.html", question: nil, detail: nil, answer: nil, status: "done", level: nil, at: stamp),
                    CompanionItem(id: "launch-3", kind: "assistant", text: "The hero still says **Coming soon** for iPhone. I can replace it with the TestFlight link and keep the rest of the copy unchanged.", title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: stamp),
                    CompanionItem(id: "launch-approval", kind: "approval", text: nil, title: nil, question: "Apply the copy change to apps/site/index.html?", detail: "Replaces the iPhone \"Coming soon\" line with a TestFlight link. One file changes.", answer: nil, status: nil, level: nil, at: stamp),
                ]
            ),
            Entry(
                thread: CompanionThread(id: Self.scrollThreadId, projectId: Self.projectId, title: "Fix scroll jump in thread view", backend: "codex", status: "idle", updatedAt: stamp),
                items: [
                    CompanionItem(id: "scroll-1", kind: "user", text: "The transcript jumps to the top when a new item arrives.", title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: stamp),
                    CompanionItem(id: "scroll-2", kind: "tool", text: nil, title: "Edit src/renderer/components/Transcript.tsx", question: nil, detail: nil, answer: nil, status: "done", level: nil, at: stamp),
                    CompanionItem(id: "scroll-3", kind: "assistant", text: "The list scrolled on every count change. It now anchors to the newest item only when you were already at the bottom. The 12 transcript tests pass.", title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: stamp),
                ]
            ),
            Entry(
                thread: CompanionThread(id: Self.notesThreadId, projectId: Self.projectId, title: "Draft release notes for v0.0.8", backend: "claude", status: "running", updatedAt: stamp),
                items: [
                    CompanionItem(id: "notes-1", kind: "user", text: "Draft release notes from the pull requests merged since v0.0.7.", title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: stamp),
                    CompanionItem(id: "notes-2", kind: "tool", text: nil, title: "Run git log v0.0.7..HEAD", question: nil, detail: nil, answer: nil, status: "running", level: nil, at: stamp),
                ]
            ),
        ]
    }

    func snapshot(threadId: String?) async throws -> CompanionSnapshot {
        finishNotesIfDue()
        let items = threadId.flatMap { id in entries.first { $0.thread.id == id }?.items } ?? []
        return CompanionSnapshot(projects: [project], threads: entries.map(\.thread), items: items)
    }

    func createThread(projectId: String, text: String, worktree: Bool, provider: String) async throws -> CompanionThread {
        guard projectId == Self.projectId else { throw CompanionError.message("Choose the demo project.") }
        guard ["auto", "codex", "claude"].contains(provider) else { throw CompanionError.message("Choose a valid demo provider.") }
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.count <= 20_000 else { throw CompanionError.message("Enter a message under 20,000 characters.") }
        let stamp = Self.stamp(.now)
        let thread = CompanionThread(id: nextId("thread"), projectId: projectId, title: String(prompt.prefix(60)), backend: provider == "auto" ? "codex" : provider, status: "idle", updatedAt: stamp)
        let location = worktree ? "Worktree" : "Local"
        let notice = CompanionItem(id: nextId("notice"), kind: "notice", text: "Demo · \(location) · \(provider). These choices are simulated. No worktree, skill or coding process runs on a Mac.", title: nil, question: nil, detail: nil, answer: nil, status: nil, level: "info", at: stamp)
        let index = entries.count
        entries.append(Entry(thread: thread, items: [notice]))
        try await send(threadId: thread.id, text: prompt)
        return entries[index].thread
    }

    func commands(projectId: String, backend: String) async throws -> [CompanionCommand] {
        guard projectId == Self.projectId else { throw CompanionError.message("Choose the demo project.") }
        guard ["codex", "claude"].contains(backend) else { throw CompanionError.message("Choose a valid demo provider.") }
        let prefix = backend == "claude" ? "/" : "$"
        return [CompanionCommand(id: "skill:demo-review", title: "demo-review", detail: "Demo skill · scripted reply only", insertion: "\(prefix)demo-review ", kind: "skill")]
    }

    func send(threadId: String, text: String) async throws {
        guard let index = entries.firstIndex(where: { $0.thread.id == threadId }) else {
            throw CompanionError.message("That demo thread is no longer available.")
        }
        guard entries[index].thread.status == "idle" else {
            throw CompanionError.message("Wait for this demo thread to finish before sending a follow-up.")
        }
        append(CompanionItem(id: nextId("user"), kind: "user", text: text, title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: Self.stamp(.now)), to: index, status: "running")
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            await self?.reply(threadId: threadId, to: text)
        }
    }

    func answer(threadId: String, itemId: String, approve: Bool) async throws {
        guard let index = entries.firstIndex(where: { $0.thread.id == threadId }),
              let item = entries[index].items.firstIndex(where: { $0.id == itemId && $0.kind == "approval" }) else {
            throw CompanionError.message("That demo approval is no longer available.")
        }
        guard entries[index].items[item].answer == nil else {
            throw CompanionError.message("This demo approval was already answered.")
        }
        let original = entries[index].items[item]
        let stamp = Self.stamp(.now)
        entries[index].items[item] = CompanionItem(id: original.id, kind: original.kind, text: original.text, title: original.title, question: original.question, detail: original.detail, answer: approve ? "yes" : "no", status: original.status, level: original.level, at: original.at)
        if approve {
            append(CompanionItem(id: nextId("tool"), kind: "tool", text: nil, title: "Apply patch to apps/site/index.html", question: nil, detail: nil, answer: nil, status: "done", level: nil, at: stamp), to: index, status: "idle")
            append(CompanionItem(id: nextId("assistant"), kind: "assistant", text: "Applied. The hero now links to TestFlight. In a paired workspace this edit would have run on your Mac; the demo only records your decision.", title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: stamp), to: index, status: "idle")
        } else {
            append(CompanionItem(id: nextId("assistant"), kind: "assistant", text: "Understood. I left apps/site/index.html unchanged. Send a follow-up if you want a different change.", title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: stamp), to: index, status: "idle")
        }
    }

    private func reply(threadId: String, to text: String) {
        guard let index = entries.firstIndex(where: { $0.thread.id == threadId }) else { return }
        let quoted = text.count > 80 ? String(text.prefix(77)) + "…" : text
        let reply = "Got it: \"\(quoted)\". In a paired workspace, Claude or Codex on your Mac would continue this thread. The demo answers in its place so you can see how replies arrive."
        append(CompanionItem(id: nextId("assistant"), kind: "assistant", text: reply, title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: Self.stamp(.now)), to: index, status: "idle")
    }

    private func finishNotesIfDue() {
        guard !notesFinished, Date.now >= notesFinishAt, let index = entries.firstIndex(where: { $0.thread.id == Self.notesThreadId }),
              entries[index].thread.status == "running" else { return }
        notesFinished = true
        let stamp = Self.stamp(.now)
        if let tool = entries[index].items.firstIndex(where: { $0.id == "notes-2" }) {
            let running = entries[index].items[tool]
            entries[index].items[tool] = CompanionItem(id: running.id, kind: running.kind, text: running.text, title: running.title, question: running.question, detail: running.detail, answer: running.answer, status: "done", level: running.level, at: running.at)
        }
        append(CompanionItem(id: nextId("assistant"), kind: "assistant", text: "**v0.0.8**\n\n- Tabbed workspace replaces the right rail\n- Mac App Store release path\n- Polished empty workspace start screen\n\nWant me to open a pull request with these notes?", title: nil, question: nil, detail: nil, answer: nil, status: nil, level: nil, at: stamp), to: index, status: "idle")
    }

    private func append(_ item: CompanionItem, to index: Int, status: String) {
        entries[index].items.append(item)
        let thread = entries[index].thread
        entries[index].thread = CompanionThread(id: thread.id, projectId: thread.projectId, title: thread.title, backend: thread.backend, status: status, updatedAt: item.at)
    }

    private func nextId(_ kind: String) -> String {
        sequence += 1
        return "demo-\(kind)-\(sequence)"
    }

    private static func stamp(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
