import SwiftUI

@main struct ModexCompanionApp: App {
    @StateObject private var model = CompanionModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            CompanionRootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .onOpenURL { url in Task { await model.pair(link: url.absoluteString) } }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { model.startPolling() }
                    else { model.stopPolling() }
                }
                .task { model.startPolling() }
        }
    }
}
