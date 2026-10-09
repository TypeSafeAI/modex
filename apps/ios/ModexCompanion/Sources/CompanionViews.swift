import AVFoundation
import SwiftUI

private enum Palette {
    static let background = Color(red: 0.043, green: 0.059, blue: 0.106)
    static let surface = Color(red: 0.082, green: 0.106, blue: 0.169)
    static let raised = Color(red: 0.133, green: 0.157, blue: 0.227)
    static let line = Color.white.opacity(0.085)
    static let accent = Color(red: 0.953, green: 0.525, blue: 0.631)
    static let muted = Color(red: 0.667, green: 0.647, blue: 0.722)
}

struct CompanionRootView: View {
    @EnvironmentObject private var model: CompanionModel
    @State private var showPairing = false
    private struct NewThreadRequest: Identifiable {
        let id = UUID()
        let projectId: String
    }
    @State private var newThreadRequest: NewThreadRequest?
    @State private var showForgetConfirmation = false
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.hasWorkspace { dashboard }
                else { onboarding }
            }
            .background(Palette.background.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: String.self) { id in
                if let thread = model.snapshot.threads.first(where: { $0.id == id }) {
                    ThreadDetailView(thread: thread)
                }
            }
        }
        .tint(Palette.accent)
        .sheet(isPresented: $showPairing) { PairingSheet() }
        .sheet(item: $newThreadRequest) { request in
            NewThreadSheet(initialProjectId: request.projectId) { id in
                newThreadRequest = nil
                path.append(id)
            }
        }
        .onChange(of: model.snapshot.threads.map(\.id)) { _, ids in
            path.removeAll { !ids.contains($0) }
        }
        .alert("Forget this Mac?", isPresented: $showForgetConfirmation) {
            Button("Forget Mac", role: .destructive) { model.disconnect() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("You can reconnect by scanning the pairing code on your Mac.") }
        .alert("Connection issue", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK", role: .cancel) { model.error = nil }
        } message: { Text(model.error ?? "") }
    }

    private var onboarding: some View {
        GeometryReader { geometry in
        ScrollView {
        VStack(alignment: .leading, spacing: 0) {
            brand
            Spacer()
            ZStack {
                RoundedRectangle(cornerRadius: 34).fill(Palette.accent.opacity(0.07)).frame(width: 226, height: 226)
                RoundedRectangle(cornerRadius: 28).stroke(Palette.accent.opacity(0.26), lineWidth: 1).frame(width: 226, height: 226)
                Image("ModexMark")
                    .resizable().scaledToFit()
                    .frame(width: 104, height: 132)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity)
            .padding(.bottom, 48)
            Text("Stay close to the work.")
                .font(.system(size: 38, weight: .semibold, design: .rounded))
                .tracking(-1.5)
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
            Text("Follow your agent threads, send the next thought, and review approvals from your iPhone.")
                .font(.system(size: 16))
                .foregroundStyle(Palette.muted)
                .lineSpacing(4)
                .padding(.top, 13)
            Button { showPairing = true } label: {
                HStack { Image(systemName: "qrcode.viewfinder"); Text("Pair with your Mac"); Spacer(); Image(systemName: "arrow.up.right") }
                    .font(.system(size: 15, weight: .semibold))
                    .padding(19)
                    .foregroundStyle(Palette.background)
                    .background(Palette.accent, in: RoundedRectangle(cornerRadius: 17))
            }
            .accessibilityIdentifier("pair-button")
            .padding(.top, 34)
            Button { Task { await model.startDemo() } } label: {
                HStack { Image(systemName: "play.circle"); Text("Explore a demo workspace"); Spacer() }
                    .font(.system(size: 15, weight: .semibold))
                    .padding(19)
                    .foregroundStyle(.white)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 17))
                    .overlay(RoundedRectangle(cornerRadius: 17).stroke(Palette.line, lineWidth: 1))
            }
            .accessibilityIdentifier("demo-button")
            .padding(.top, 12)
            Text("Pairing needs a Mac running Modex on the same network. The demo needs nothing.")
                .font(.system(size: 12))
                .foregroundStyle(Palette.muted)
                .frame(maxWidth: .infinity)
                .padding(.top, 17)
            Spacer().frame(height: 28)
        }
        .padding(.horizontal, 26)
        .padding(.top, 24)
        .frame(minHeight: geometry.size.height)
        }
        .scrollIndicators(.hidden)
        }
    }

    private var dashboard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    brand
                    Spacer()
                    Button { newThreadRequest = NewThreadRequest(projectId: "") } label: {
                        Image(systemName: "square.and.pencil").font(.headline)
                            .frame(width: 44, height: 44).background(Palette.accent, in: RoundedRectangle(cornerRadius: 9))
                            .foregroundStyle(Palette.background)
                    }
                    .disabled(!model.connected)
                    .opacity(model.connected ? 1 : 0.4)
                    .accessibilityLabel("New thread")
                    .accessibilityIdentifier("new-thread")
                    Menu {
                        if model.isDemo {
                            Button("Pair with your Mac…") { showPairing = true }
                            Button("Reset demo workspace") { Task { await model.startDemo() } }
                            Button("Leave demo workspace", role: .destructive) { model.disconnect() }
                        } else {
                            Button("Scan pairing code", systemImage: "qrcode.viewfinder") { showPairing = true }
                            Button("Forget paired Mac…", role: .destructive) { showForgetConfirmation = true }
                        }
                    } label: {
                        Image(systemName: "ellipsis").font(.headline)
                            .frame(width: 44, height: 44).background(Palette.surface, in: RoundedRectangle(cornerRadius: 9))
                    }
                    .accessibilityLabel("Workspace options")
                    .accessibilityIdentifier("workspace-options")
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Workspace").font(.largeTitle.weight(.semibold)).tracking(-1)
                    if model.isDemo {
                        Label("Demo workspace · not connected to a Mac", systemImage: "play.circle.fill")
                            .font(.subheadline).foregroundStyle(Palette.muted)
                            .accessibilityIdentifier("demo-status")
                    } else if model.connected {
                        Label("Mac connected", systemImage: "checkmark.circle.fill")
                            .font(.subheadline).foregroundStyle(Palette.muted)
                    }
                }
                if !model.connected && !model.isDemo {
                    if model.connectionError != nil {
                        ConnectionRecoveryCard { showPairing = true }
                    } else {
                        HStack(spacing: 10) {
                            ProgressView().tint(Palette.accent)
                            Text("Connecting to your Mac…").font(.subheadline).foregroundStyle(Palette.muted)
                        }
                    }
                }
                HStack(alignment: .firstTextBaseline) {
                    Text("PROJECTS").font(.caption.weight(.bold)).tracking(1.7).foregroundStyle(Palette.muted)
                    Spacer()
                    Text("\(model.snapshot.threads.count) \(model.snapshot.threads.count == 1 ? "thread" : "threads")").font(.caption).foregroundStyle(Palette.muted)
                }
                if model.snapshot.projects.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Label(model.connected ? "Open a project on your Mac" : "Waiting for your workspace", systemImage: "folder")
                            .font(.headline)
                        Text(model.connected ? "In Modex on your Mac, choose Open Project. It will appear here so you can start a thread." : "Your projects and threads will appear when your Mac reconnects.")
                            .font(.subheadline).foregroundStyle(Palette.muted)
                    }
                    .workspaceCard()
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 16, alignment: .top)], alignment: .leading, spacing: 16) {
                        ForEach(model.snapshot.projects) { project in
                            let threads = model.snapshot.threads.filter { $0.projectId == project.id }
                            VStack(alignment: .leading, spacing: 14) {
                                Label(project.name, systemImage: "folder")
                                    .font(.headline).foregroundStyle(.white)
                                    .fixedSize(horizontal: false, vertical: true)
                                if threads.isEmpty {
                                    Text("No threads yet. Start with a question or a task.")
                                        .font(.subheadline).foregroundStyle(Palette.muted)
                                }
                                ForEach(threads) { thread in
                                    NavigationLink(value: thread.id) { ThreadRow(thread: thread) }
                                        .buttonStyle(.plain)
                                        .accessibilityIdentifier("thread-\(thread.id)")
                                }
                                Button { newThreadRequest = NewThreadRequest(projectId: project.id) } label: {
                                    Label("New thread", systemImage: "plus")
                                }
                                .buttonStyle(ActionButtonStyle(prominent: false))
                                .disabled(!model.connected)
                                .accessibilityLabel("New thread in \(project.name)")
                            }
                            .workspaceCard()
                        }
                    }
                }
            }
            .frame(maxWidth: 1040)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh() }
        .scrollIndicators(.hidden)
    }

    private var brand: some View {
        HStack(spacing: 9) {
            Image("ModexMark")
                .resizable().scaledToFit()
                .frame(width: 20, height: 26)
                .accessibilityHidden(true)
            Text("MODEX").font(.system(size: 13, weight: .heavy, design: .rounded)).tracking(3.2).foregroundStyle(.white)
        }
    }
}

/// Shared raised surface, with modest corners and an edge that stays visible in dark mode.
private struct WorkspaceCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(LinearGradient(colors: [Palette.surface, Palette.surface.opacity(0.65)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.line, lineWidth: 1))
            .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 6)
    }
}

private extension View {
    func workspaceCard() -> some View { modifier(WorkspaceCard()) }
}

private struct ConnectionRecoveryCard: View {
    @EnvironmentObject private var model: CompanionModel
    @State private var retrying = false
    let onPair: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Reconnect to your Mac", systemImage: "wifi.exclamationmark")
                .font(.headline).foregroundStyle(Palette.accent)
            Text(model.connectionError ?? "Keep Modex open on your Mac and connect both devices to the same network. You can also scan a fresh pairing code.")
                .font(.subheadline).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("connection-status")
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { scanButton; retryButton }
                VStack(spacing: 10) { scanButton; retryButton }
            }
            Text("On your Mac: Modex → iPhone companion → pairing code. Your saved pairing stays until a new connection succeeds.")
                .font(.caption).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .workspaceCard()
    }

    private var scanButton: some View {
        Button(action: onPair) { Label("Scan pairing code", systemImage: "qrcode.viewfinder").fixedSize() }
            .buttonStyle(ActionButtonStyle(prominent: true))
            .accessibilityIdentifier("repair-pairing")
    }

    private var retryButton: some View {
        Button {
            retrying = true
            Task { await model.refresh(); retrying = false }
        } label: { Text(retrying ? "Trying…" : "Try again").fixedSize() }
            .buttonStyle(ActionButtonStyle(prominent: false))
            .disabled(retrying)
            .accessibilityIdentifier("retry-connection")
    }
}

private struct ThreadRow: View {
    let thread: CompanionThread

    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 11).fill(Palette.accent.opacity(0.11)).frame(width: 40, height: 40)
                .overlay(Image(systemName: thread.status == "waiting" ? "hand.raised" : "bubble.left.and.text.bubble.right").foregroundStyle(Palette.accent))
            VStack(alignment: .leading, spacing: 5) {
                Text(thread.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).lineLimit(2)
                Text("\(thread.backend.capitalized) · \(thread.status == "waiting" ? "Approval needed" : thread.status.capitalized)\(taskSummary(thread).map { " · \($0)" } ?? "")")
                    .font(.system(size: 12)).foregroundStyle(thread.status == "waiting" ? Palette.accent : Palette.muted)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.muted)
        }
        .padding(15)
        .background(Palette.raised.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line, lineWidth: 1))
    }
}

/// "Worktree · PR #12 open", "Finished · PR #12 merged", or nil for a plain checkout.
private func taskSummary(_ thread: CompanionThread) -> String? {
    if let merged = thread.retiredPr { return "Finished · PR #\(merged) merged" }
    guard thread.worktree == true else { return nil }
    if let pr = thread.pr { return "Worktree · PR #\(pr.number) \(pr.state)" }
    return "Worktree"
}

private func policyTitle(_ policy: String) -> String {
    switch policy {
    case "always": return "Always allow"
    case "yolo": return "YOLO"
    default: return "Ask each time"
    }
}

private struct ThreadDetailView: View {
    @EnvironmentObject private var model: CompanionModel
    @Environment(\.dismiss) private var dismiss
    let thread: CompanionThread
    @State private var approvalToConfirm: String?
    @State private var showCommands = false
    @State private var confirmYolo = false
    @State private var alwaysToConfirm: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 13) {
                Button { dismiss() } label: { Image(systemName: "arrow.left").font(.system(size: 17, weight: .medium)).frame(width: 36, height: 36).background(Palette.surface, in: RoundedRectangle(cornerRadius: 11)) }
                    .accessibilityLabel("Back to threads")
                VStack(alignment: .leading, spacing: 2) {
                    Text(thread.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Text("\(model.isDemo ? "Demo · " : "")\(thread.backend.capitalized) · \(currentStatus.capitalized)\(taskSummary(current).map { " · \($0)" } ?? "")").font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(2)
                }
                Spacer()
                Menu {
                    Button { Task { await model.setApprovals("ask") } } label: { Label("Ask each time", systemImage: policy == "ask" ? "checkmark" : "hand.raised") }
                    Button { Task { await model.setApprovals("always") } } label: { Label("Always allow", systemImage: policy == "always" ? "checkmark" : "checkmark.shield") }
                    Button(role: .destructive) { confirmYolo = true } label: { Label("YOLO", systemImage: policy == "yolo" ? "checkmark" : "bolt") }
                } label: {
                    Text(policyTitle(policy)).font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(policy == "yolo" ? Color.orange : policy == "always" ? Palette.accent : Palette.muted)
                        .padding(.horizontal, 10).frame(height: 30)
                        .background(Palette.surface, in: Capsule())
                }
                .accessibilityLabel("Approvals: \(policyTitle(policy))")
                .accessibilityIdentifier("thread-approvals")
                Circle().fill(currentStatus == "waiting" ? Palette.accent : currentStatus == "running" ? Color.green : Palette.muted).frame(width: 8, height: 8)
            }
            .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 16)
            Rectangle().fill(Palette.line).frame(height: 1)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(model.snapshot.items) { item in
                            ItemView(item: item, busy: model.answeringId == item.id,
                                     approve: { approvalToConfirm = item.id },
                                     approveAlways: { alwaysToConfirm = item.id },
                                     deny: { Task { await model.answer(itemId: item.id, approve: false) } })
                                .id(item.id)
                        }
                        if currentStatus == "running" {
                            HStack(spacing: 8) { ProgressView().tint(Palette.accent); Text(model.isDemo ? "Working in the demo" : "Working on your Mac").foregroundStyle(Palette.muted).font(.system(size: 12)) }
                                .padding(.vertical, 10)
                        }
                    }
                    .padding(.horizontal, 20).padding(.vertical, 23)
                }
                .scrollIndicators(.hidden)
                .onChange(of: model.snapshot.items.count) { _, _ in
                    if let last = model.snapshot.items.last { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
        }
        .background(Palette.background.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .toolbar(.hidden, for: .navigationBar)
        .task { await model.select(thread.id) }
        .confirmationDialog("Approve this action?", isPresented: Binding(get: { approvalToConfirm != nil }, set: { if !$0 { approvalToConfirm = nil } }), titleVisibility: .visible) {
            Button("Approve once") { if let id = approvalToConfirm { Task { await model.answer(itemId: id, approve: true) } }; approvalToConfirm = nil }
            Button("Cancel", role: .cancel) { approvalToConfirm = nil }
        } message: { Text(model.isDemo ? "This is the demo. Nothing runs on a Mac; your answer is only recorded here." : "The action will run on your Mac in this thread.") }
        .confirmationDialog("Always allow in this thread?", isPresented: Binding(get: { alwaysToConfirm != nil }, set: { if !$0 { alwaysToConfirm = nil } }), titleVisibility: .visible) {
            Button("Approve and always allow") { if let id = alwaysToConfirm { Task { await model.approveAlways(itemId: id) } }; alwaysToConfirm = nil }
            Button("Cancel", role: .cancel) { alwaysToConfirm = nil }
        } message: { Text("This and every later action in this thread runs on your Mac without asking. Requests for extra sandbox access still ask. Change it any time from the Approvals menu.") }
        .confirmationDialog("Turn on YOLO for this thread?", isPresented: $confirmYolo, titleVisibility: .visible) {
            Button("Turn on YOLO", role: .destructive) { Task { await model.setApprovals("yolo") } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Every action in this thread runs on your Mac without asking, including access outside the sandbox. Your Never rules on the Mac still refuse.") }
        .sheet(isPresented: $showCommands) {
            CommandSheet(projectId: thread.projectId, backend: thread.backend) { insertion in
                insert(insertion, into: &model.draft)
                showCommands = false
            }
        }
    }

    private var current: CompanionThread { model.snapshot.threads.first(where: { $0.id == thread.id }) ?? thread }
    private var policy: String { current.approvalPolicy }
    private var currentStatus: String { current.status }

    private var composer: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Palette.line).frame(height: 1)
            HStack(alignment: .bottom, spacing: 11) {
                Button { showCommands = true } label: {
                    Text("/").font(.system(size: 18, weight: .semibold, design: .monospaced))
                        .frame(width: 43, height: 43)
                        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.line, lineWidth: 1))
                }
                .accessibilityLabel("Skills and commands")
                .accessibilityIdentifier("thread-commands")
                TextField("Send a follow-up…", text: $model.draft, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.system(size: 15))
                    .padding(.horizontal, 15).padding(.vertical, 12)
                    .background(Palette.raised, in: RoundedRectangle(cornerRadius: 16))
                    .accessibilityIdentifier("followup-input")
                Button { Task { await model.send() } } label: {
                    Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold))
                        .frame(width: 43, height: 43)
                        .background(Palette.accent, in: RoundedRectangle(cornerRadius: 14))
                        .foregroundStyle(Palette.background)
                }
                .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.sending || !model.connected || currentStatus != "idle" || current.retiredPr != nil)
                .opacity(currentStatus == "idle" ? 1 : 0.45)
                .accessibilityLabel("Send follow-up")
                .accessibilityIdentifier("send-followup")
            }
            .padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 10)
        }
        .background(Palette.background)
    }
}

private struct NewThreadSheet: View {
    @EnvironmentObject private var model: CompanionModel
    @Environment(\.dismiss) private var dismiss
    let initialProjectId: String
    let onCreated: (String) -> Void
    @State private var projectId = ""
    @State private var worktree = false
    @State private var provider = "codex"
    @State private var showCommands = false
    @State private var showPairing = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("New thread").font(.largeTitle.weight(.semibold)).tracking(-1)
                        Text(model.isDemo ? "Creates a demo thread with scripted replies. Location and provider choices are simulated; nothing runs on a Mac." : "Runs on your Mac using its saved provider and model.")
                            .font(.subheadline).foregroundStyle(Palette.muted)
                    }
                    if !model.connected && !model.isDemo {
                        ConnectionRecoveryCard { showPairing = true }
                    }
                    contextControls
                }
                .frame(maxWidth: 680)
                .padding(20)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                composer
                    .frame(maxWidth: 680)
                    .padding(.horizontal, 20).padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .background(Palette.background)
            }
            .background(Palette.background.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() }.foregroundStyle(Palette.muted) }
            }
        }
        .tint(Palette.accent)
        .presentationDetents([.large])
        .onAppear {
            if projectId.isEmpty { projectId = model.snapshot.projects.first(where: { $0.id == initialProjectId })?.id ?? model.snapshot.projects.first?.id ?? "" }
            provider = model.snapshot.autoByDefault ? "auto" : model.snapshot.defaultBackend
        }
        .sheet(isPresented: $showPairing) { PairingSheet() }
        .sheet(isPresented: $showCommands) {
            CommandSheet(projectId: projectId, backend: provider == "auto" ? model.snapshot.defaultBackend : provider) { insertion in
                if provider == "auto" { provider = model.snapshot.defaultBackend }
                insert(insertion, into: &model.newThreadDraft)
            }
        }
    }

    private var contextControls: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Project").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
                Picker("Project", selection: $projectId) {
                    ForEach(model.snapshot.projects) { project in Text(project.name).tag(project.id) }
                }
                .pickerStyle(.menu)
                .tint(.white)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background(Palette.raised, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("new-thread-project")
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Location").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
                Picker("Location", selection: $worktree) {
                    Text("Worktree").tag(true)
                    Text("Local").tag(false)
                }
                .pickerStyle(.segmented)
                Text(worktree ? "Create an isolated branch for this thread." : "Work directly in the project folder on your Mac.")
                    .font(.caption).foregroundStyle(Palette.muted)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Provider").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
                Picker("Provider", selection: $provider) {
                    Text("Auto").tag("auto")
                    Text("Codex").tag("codex")
                    Text("Claude").tag("claude")
                    if model.snapshot.defaultBackend == "mock" { Text("Mock").tag("mock") }
                }
                .pickerStyle(.segmented)
            }
        }
        .workspaceCard()
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Task").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
            TextField("What should we build?", text: $model.newThreadDraft, axis: .vertical)
                .lineLimit(2...4).font(.body)
                .accessibilityIdentifier("new-thread-input")
            HStack {
                Button { showCommands = true } label: {
                    HStack(spacing: 7) {
                        Text("/").font(.system(.body, design: .monospaced).weight(.bold))
                        Text("Skills").font(.subheadline.weight(.semibold))
                    }
                    .padding(.horizontal, 12).frame(minHeight: 44)
                    .background(Palette.raised, in: RoundedRectangle(cornerRadius: 8))
                }
                .disabled(!model.connected)
                .accessibilityIdentifier("new-thread-commands")
                Spacer()
                Button {
                    Task {
                        if let id = await model.createThread(projectId: projectId, worktree: worktree, provider: provider) { onCreated(id) }
                    }
                } label: {
                    if model.creatingThread {
                        ProgressView().tint(Palette.background).frame(width: 44, height: 44)
                    } else {
                        Image(systemName: "arrow.up").font(.headline).frame(width: 44, height: 44)
                    }
                }
                .background(Palette.accent, in: RoundedRectangle(cornerRadius: 8))
                .foregroundStyle(Palette.background)
                .disabled(projectId.isEmpty || model.newThreadDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.creatingThread || !model.connected)
                .accessibilityLabel("Create thread")
                .accessibilityIdentifier("create-thread")
            }
        }
        .workspaceCard()
    }
}

private struct CommandSheet: View {
    @EnvironmentObject private var model: CompanionModel
    @Environment(\.dismiss) private var dismiss
    let projectId: String
    let backend: String
    let onSelect: (String) -> Void
    @State private var query = ""
    @State private var loading = true

    private var filtered: [CompanionCommand] {
        let commands = model.availableCommands(projectId: projectId, backend: backend)
        guard !query.isEmpty else { return commands }
        return commands.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.detail.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Palette.muted)
                    TextField("Find a skill or command", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                .padding(.horizontal, 14).frame(height: 44)
                .background(Palette.raised, in: RoundedRectangle(cornerRadius: 14))
                if loading {
                    ProgressView().tint(Palette.accent).frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if filtered.isEmpty {
                    ContentUnavailableView("No commands found", systemImage: "command", description: Text("Install skills on your Mac or type a command directly."))
                        .foregroundStyle(Palette.muted)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(filtered) { command in
                                Button {
                                    onSelect(command.insertion)
                                    dismiss()
                                } label: {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(command.insertion.trimmingCharacters(in: .whitespaces))
                                            .font(.system(size: 13, weight: .semibold, design: .monospaced)).foregroundStyle(Palette.accent)
                                            .fixedSize(horizontal: false, vertical: true)
                                        Text(command.detail).font(.system(size: 13)).foregroundStyle(Palette.muted)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(14).background(Palette.surface, in: RoundedRectangle(cornerRadius: 14))
                                }.buttonStyle(.plain)
                            }
                        }
                    }.scrollIndicators(.hidden)
                }
            }
            .padding(18).background(Palette.background.ignoresSafeArea())
            .navigationTitle("Skills & commands").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.foregroundStyle(Palette.muted) } }
        }
        .presentationDetents([.medium, .large])
        .task(id: "\(projectId)\u{0}\(backend)") {
            loading = true
            await model.loadCommands(projectId: projectId, backend: backend)
            if !Task.isCancelled { loading = false }
        }
    }
}

private func insert(_ insertion: String, into text: inout String) {
    text = text.isEmpty ? insertion : text + (text.last?.isWhitespace == true ? "" : " ") + insertion
}

private struct ItemView: View {
    let item: CompanionItem
    let busy: Bool
    let approve: () -> Void
    var approveAlways: () -> Void = {}
    let deny: () -> Void

    var body: some View {
        switch item.kind {
        case "user":
            HStack { Spacer(minLength: 40); Text(item.text ?? "").font(.system(size: 14)).textSelection(.enabled).padding(15).background(Palette.accent.opacity(0.17), in: RoundedRectangle(cornerRadius: 16)) }
        case "assistant":
            VStack(alignment: .leading, spacing: 8) {
                label("MODEX", symbol: "sparkle")
                Text(.init(item.text ?? "")).font(.system(size: 14)).lineSpacing(4).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(17).background(Palette.surface, in: RoundedRectangle(cornerRadius: 17))
        case "approval":
            VStack(alignment: .leading, spacing: 13) {
                label("APPROVAL", symbol: "hand.raised")
                Text(item.question ?? "Action requested").font(.system(size: 15, weight: .semibold))
                if let detail = item.detail, !detail.isEmpty { Text(detail).font(.system(size: 12)).foregroundStyle(Palette.muted).textSelection(.enabled) }
                if let answer = item.answer {
                    Label(answer == "yes" ? approvedText : "Denied", systemImage: answer == "yes" ? "checkmark.circle" : "xmark.circle")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.muted)
                } else {
                    HStack(spacing: 10) {
                        Button("Deny", action: deny).buttonStyle(ActionButtonStyle(prominent: false)).accessibilityIdentifier("deny-\(item.id)")
                        Button("Approve once", action: approve).buttonStyle(ActionButtonStyle(prominent: true)).accessibilityIdentifier("approve-\(item.id)")
                    }.disabled(busy)
                    Button("Always allow in this thread", action: approveAlways)
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.accent).disabled(busy)
                        .accessibilityIdentifier("always-\(item.id)")
                }
            }
            .padding(17).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 17))
            .overlay(RoundedRectangle(cornerRadius: 17).stroke(Palette.accent.opacity(0.26), lineWidth: 1))
        case "tool":
            Label(item.title ?? "Tool", systemImage: item.status == "running" ? "gearshape.2" : "checkmark.circle")
                .font(.system(size: 12)).foregroundStyle(Palette.muted).padding(.horizontal, 13).padding(.vertical, 10)
                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 11))
        case "notice":
            Text(item.text ?? "").font(.system(size: 12)).foregroundStyle(item.level == "error" ? Color(red: 1, green: 0.6, blue: 0.6) : Palette.muted)
                .padding(13).frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 11))
        default:
            if let text = item.text, !text.isEmpty {
                Text(text).font(.system(size: 12)).foregroundStyle(Palette.muted).padding(.horizontal, 10)
            }
        }
    }

    private var approvedText: String {
        switch item.auto {
        case "yolo": return "Approved automatically · YOLO"
        case "always": return "Approved automatically · Always allow"
        case "rule": return "Approved by your rule"
        default: return "Approved"
        }
    }

    private func label(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol).font(.system(size: 10, weight: .bold)).tracking(1.2).foregroundStyle(Palette.accent)
    }
}

private struct ActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    let prominent: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(prominent ? Palette.background : .white)
            .background(prominent ? Palette.accent : Palette.raised, in: RoundedRectangle(cornerRadius: 8))
            .opacity(!isEnabled ? 0.45 : configuration.isPressed ? 0.7 : 1)
    }
}

private struct PairingSheet: View {
    @EnvironmentObject private var model: CompanionModel
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("Connect to your Mac")
                        .font(.system(size: 30, weight: .semibold, design: .rounded)).tracking(-1)
                    Text("In Modex on your Mac, open the iPhone companion from the rail and turn it on. Scan the private code shown there.")
                        .font(.system(size: 15)).foregroundStyle(Palette.muted).lineSpacing(3)
                    Button { scanning = true } label: {
                        Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                            .font(.system(size: 16, weight: .semibold))
                            .frame(maxWidth: .infinity).padding(17)
                            .foregroundStyle(Palette.background).background(Palette.accent, in: RoundedRectangle(cornerRadius: 15))
                    }
                        .accessibilityIdentifier("scan-pairing-code")
                        .disabled(model.isPairing)
                    HStack { Rectangle().fill(Palette.line).frame(height: 1); Text("OR PASTE THE LINK").font(.system(size: 10, weight: .bold)).tracking(1.5).foregroundStyle(Palette.muted); Rectangle().fill(Palette.line).frame(height: 1) }
                    TextField("modex://pair?data=…", text: $link)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL).font(.system(size: 13, design: .monospaced))
                        .padding(15).background(Palette.raised, in: RoundedRectangle(cornerRadius: 13))
                        .accessibilityIdentifier("pairing-link-input")
                    Button(model.isPairing ? "Connecting…" : "Connect") { Task { if await model.open(link: link) { dismiss() } } }
                        .buttonStyle(ActionButtonStyle(prominent: true))
                        .disabled(link.isEmpty || model.isPairing)
                        .accessibilityIdentifier("connect-button")
                    Text("Pair once. This iPhone remembers your Mac and reconnects automatically when it is available on your network.")
                        .font(.system(size: 13)).foregroundStyle(Palette.muted)
                }
                .frame(maxWidth: 600)
                .padding(20)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.background.ignoresSafeArea())
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $scanning) {
                QRScannerView { scanned in
                    scanning = false
                    Task { if await model.open(link: scanned) { dismiss() } }
                }
                .ignoresSafeArea()
            }
        }
        .preferredColorScheme(.dark)
    }
}

private struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    func makeUIViewController(context: Context) -> ScannerController { ScannerController(onScan: onScan) }
    func updateUIViewController(_ controller: ScannerController, context: Context) {}
}

private final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let onScan: (String) -> Void
    private let session = AVCaptureSession()
    private var didScan = false
    init(onScan: @escaping (String) -> Void) { self.onScan = onScan; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        let guide = UILabel()
        guide.text = "Point your camera at the Modex pairing code"
        guide.textColor = .white
        guide.font = .systemFont(ofSize: 15, weight: .medium)
        guide.textAlignment = .center
        guide.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(guide)
        NSLayoutConstraint.activate([guide.centerXAnchor.constraint(equalTo: view.centerXAnchor), guide.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -35), guide.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 20), guide.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -20)])
        DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if session.isRunning { DispatchQueue.global(qos: .userInitiated).async { [session] in session.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !didScan, let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        didScan = true
        onScan(value)
    }
}
