import Foundation
import Network

@MainActor protocol CompanionDiscovery: AnyObject {
    func start(fingerprint: String, found: @escaping (URL) -> Void)
    func stop()
}

/// Bonjour supplies candidate addresses only. HTTPS must still prove the saved certificate.
@MainActor final class BonjourCompanionDiscovery: CompanionDiscovery {
    private var browser: NWBrowser?

    func start(fingerprint: String, found: @escaping (URL) -> Void) {
        guard browser == nil else { return }
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_modex._tcp", domain: "local."), using: .tcp)
        self.browser = browser
        browser.browseResultsChangedHandler = { [weak self, weak browser] results, _ in
            Task { @MainActor in
                guard let self, let browser, self.browser === browser else { return }
                for result in results {
                    guard case .bonjour(let record) = result.metadata,
                          let url = Self.endpoint(record.dictionary, fingerprint: fingerprint) else { continue }
                    found(url)
                }
            }
        }
        browser.start(queue: .main)
    }

    static func endpoint(_ record: [String: String], fingerprint: String) -> URL? {
        guard record["fingerprint"] == fingerprint, let value = record["url"],
              let url = URL(string: value), Pairing.validEndpoint(url) else { return nil }
        return url
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }
}
