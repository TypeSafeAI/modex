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
    @State private var showForgetConfirmation = false
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.pairing == nil { onboarding }
                else { dashboard }
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
            Text("Your Mac and iPhone need to share a network.")
                .font(.system(size: 12))
                .foregroundStyle(Palette.muted)
                .frame(maxWidth: .infinity)
                .padding(.top, 17)
            Spacer().frame(height: 28)
        }
        .padding(.horizontal, 26)
        .padding(.top, 24)
    }

    private var dashboard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack {
                    brand
                    Spacer()
                    Menu {
                        Button("Forget paired Mac…", role: .destructive) { showForgetConfirmation = true }
                    } label: {
                        Image(systemName: "ellipsis").font(.system(size: 18, weight: .semibold))
                            .frame(width: 44, height: 44).background(Palette.surface, in: RoundedRectangle(cornerRadius: 13))
                    }
                    .accessibilityLabel("Workspace options")
                    .accessibilityIdentifier("workspace-options")
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Workspace")
                        .font(.system(size: 34, weight: .semibold, design: .rounded))
                        .tracking(-1.3)
                    HStack(spacing: 7) {
                        Circle().fill(model.connected ? Color.green : Color.orange).frame(width: 7, height: 7)
                        Text(model.connected ? "Mac connected" : "Reconnecting to your Mac…")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Palette.muted)
                    }
                    if let detail = model.connectionError {
                        Text(detail).font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(2)
                            .accessibilityIdentifier("connection-status")
                    }
                }
                HStack(alignment: .firstTextBaseline) {
                    Text("THREADS").font(.system(size: 11, weight: .bold)).tracking(1.7).foregroundStyle(Palette.muted)
                    Spacer()
                    Text("\(model.snapshot.threads.count)").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.accent)
                }
                if model.snapshot.threads.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "text.bubble").font(.system(size: 27, weight: .light)).foregroundStyle(Palette.accent)
                        Text("No threads yet").font(.system(size: 18, weight: .medium))
                        Text("Start a thread on your Mac and it will appear here.").font(.system(size: 13)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 58)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 20))
                }
                ForEach(model.snapshot.projects) { project in
                    let threads = model.snapshot.threads.filter { $0.projectId == project.id }
                    if !threads.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(spacing: 8) {
                                Image(systemName: "folder").foregroundStyle(Palette.accent)
                                Text(project.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
                            }
                            ForEach(threads) { thread in
                                NavigationLink(value: thread.id) { ThreadRow(thread: thread) }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("thread-\(thread.id)")
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 22)
            .padding(.top, 22)
            .padding(.bottom, 40)
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

private struct ThreadRow: View {
    let thread: CompanionThread

    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 11).fill(Palette.accent.opacity(0.11)).frame(width: 40, height: 40)
                .overlay(Image(systemName: thread.status == "waiting" ? "hand.raised" : "bubble.left.and.text.bubble.right").foregroundStyle(Palette.accent))
            VStack(alignment: .leading, spacing: 5) {
                Text(thread.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).lineLimit(2)
                Text("\(thread.backend.capitalized) · \(thread.status == "waiting" ? "Approval needed" : thread.status.capitalized)")
                    .font(.system(size: 12)).foregroundStyle(thread.status == "waiting" ? Palette.accent : Palette.muted)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.muted)
        }
        .padding(15)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 17))
        .overlay(RoundedRectangle(cornerRadius: 17).stroke(Palette.line, lineWidth: 1))
    }
}

private struct ThreadDetailView: View {
    @EnvironmentObject private var model: CompanionModel
    @Environment(\.dismiss) private var dismiss
    let thread: CompanionThread
    @State private var approvalToConfirm: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 13) {
                Button { dismiss() } label: { Image(systemName: "arrow.left").font(.system(size: 17, weight: .medium)).frame(width: 36, height: 36).background(Palette.surface, in: RoundedRectangle(cornerRadius: 11)) }
                    .accessibilityLabel("Back to threads")
                VStack(alignment: .leading, spacing: 2) {
                    Text(thread.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Text("\(thread.backend.capitalized) · \(currentStatus.capitalized)").font(.system(size: 11)).foregroundStyle(Palette.muted)
                }
                Spacer()
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
                                     deny: { Task { await model.answer(itemId: item.id, approve: false) } })
                                .id(item.id)
                        }
                        if currentStatus == "running" {
                            HStack(spacing: 8) { ProgressView().tint(Palette.accent); Text("Working on your Mac").foregroundStyle(Palette.muted).font(.system(size: 12)) }
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
        } message: { Text("The action will run on your Mac in this thread.") }
    }

    private var currentStatus: String { model.snapshot.threads.first(where: { $0.id == thread.id })?.status ?? thread.status }

    private var composer: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Palette.line).frame(height: 1)
            HStack(alignment: .bottom, spacing: 11) {
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
                .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.sending || currentStatus != "idle")
                .opacity(currentStatus == "idle" ? 1 : 0.45)
                .accessibilityLabel("Send follow-up")
                .accessibilityIdentifier("send-followup")
            }
            .padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 10)
        }
        .background(Palette.background)
    }
}

private struct ItemView: View {
    let item: CompanionItem
    let busy: Bool
    let approve: () -> Void
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
                    Label(answer == "yes" ? "Approved" : "Denied", systemImage: answer == "yes" ? "checkmark.circle" : "xmark.circle")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.muted)
                } else {
                    HStack(spacing: 10) {
                        Button("Deny", action: deny).buttonStyle(ActionButtonStyle(prominent: false)).accessibilityIdentifier("deny-\(item.id)")
                        Button("Approve once", action: approve).buttonStyle(ActionButtonStyle(prominent: true)).accessibilityIdentifier("approve-\(item.id)")
                    }.disabled(busy)
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

    private func label(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol).font(.system(size: 10, weight: .bold)).tracking(1.2).foregroundStyle(Palette.accent)
    }
}

private struct ActionButtonStyle: ButtonStyle {
    let prominent: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .foregroundStyle(prominent ? Palette.background : .white)
            .background(prominent ? Palette.accent : Palette.raised, in: RoundedRectangle(cornerRadius: 11))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

private struct PairingSheet: View {
    @EnvironmentObject private var model: CompanionModel
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var scanning = false

    var body: some View {
        NavigationStack {
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
                Button(model.isPairing ? "Connecting…" : "Connect") { Task { await model.pair(link: link); if model.pairing != nil { dismiss() } } }
                    .buttonStyle(ActionButtonStyle(prominent: true))
                    .disabled(link.isEmpty || model.isPairing)
                    .accessibilityIdentifier("connect-button")
                Text("Pair once. This iPhone remembers your Mac and reconnects automatically when it is available on your network.")
                    .font(.system(size: 13)).foregroundStyle(Palette.muted)
                Spacer()
            }
            .padding(25).padding(.top, 24)
            .background(Palette.background.ignoresSafeArea())
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $scanning) {
                QRScannerView { scanned in
                    scanning = false
                    Task { await model.pair(link: scanned); if model.pairing != nil { dismiss() } }
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
