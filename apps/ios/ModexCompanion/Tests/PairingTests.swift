import Foundation
import XCTest
@testable import ModexCompanion

final class PairingTests: XCTestCase {
    func testOlderSnapshotDefaultsToCodexWithoutAutoRouting() throws {
        let snapshot = try JSONDecoder().decode(CompanionSnapshot.self, from: Data(#"{"projects":[],"threads":[],"items":[]}"#.utf8))
        XCTAssertEqual(snapshot.defaultBackend, "codex")
        XCTAssertFalse(snapshot.autoByDefault)
    }

    @MainActor func testDiscoveryAcceptsOnlyLocalEndpointsForTheSavedIdentity() {
        let fingerprint = String(repeating: "b", count: 64)
        let good = ["fingerprint": fingerprint, "url": "https://192.168.1.45:43210"]
        XCTAssertEqual(BonjourCompanionDiscovery.endpoint(good, fingerprint: fingerprint)?.host, "192.168.1.45")
        XCTAssertNil(BonjourCompanionDiscovery.endpoint(good, fingerprint: String(repeating: "c", count: 64)))
        for url in ["http://192.168.1.45:43210", "https://example.com", "https://192.168.1.45.example.com", "https://user:password@192.168.1.45", "https://192.168.1.45/redirect", "https://192.168.1.45?target=other"] {
            XCTAssertNil(BonjourCompanionDiscovery.endpoint(["fingerprint": fingerprint, "url": url], fingerprint: fingerprint))
        }
    }

    func testLocalPairingLinkRoundTrips() throws {
        let original = Pairing(url: URL(string: "https://192.168.1.12:43120")!, token: String(repeating: "a", count: 64), fingerprint: String(repeating: "b", count: 64))
        let encoded = try JSONEncoder().encode(original).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(try Pairing.from(link: "modex://pair?data=\(encoded)"), original)
    }

    func testPublicHostAndShortSecretAreRejected() throws {
        for (url, token) in [
            ("https://example.com", String(repeating: "a", count: 64)),
            ("https://10.1.2.3.example.com", String(repeating: "a", count: 64)),
            ("https://192.168.1.2.example.com", String(repeating: "a", count: 64)),
            ("https://192.168.1.12", "short"),
        ] {
            let candidate = Pairing(url: URL(string: url)!, token: token, fingerprint: String(repeating: "b", count: 64))
            let encoded = try JSONEncoder().encode(candidate).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
            XCTAssertThrowsError(try Pairing.from(link: "modex://pair?data=\(encoded)"))
        }
    }
#if DEBUG
    func testTrustDiagnosticsStaySilentWithoutExplicitLaunchFlag() {
        var messages: [String] = []
        let observer = CompanionTrustObservation(arguments: ["ModexCompanion", "--other-option"], write: { messages.append($0) })
        observer.record(.callbackEnter)
        observer.record(.acceptPin)
        XCTAssertTrue(messages.isEmpty)
    }

    func testTrustDiagnosticsContainOnlyOneCorrelationAndFixedPhases() {
        var messages: [String] = []
        let observer = CompanionTrustObservation(arguments: ["ModexCompanion", "--modex-trust-diagnostics"], write: { messages.append($0) })
        let phases: [CompanionTrustObservation.Phase] = [.callbackEnter, .chainStart, .chainReturn, .acceptPin, .completionReturn]
        phases.forEach { observer.record($0) }
        XCTAssertEqual(messages.count, phases.count)
        let identifiers = messages.compactMap { message -> String? in
            let fields = message.split(separator: " ")
            guard fields.count == 3, fields[0] == "MODEX_PAIRING_TLS", fields[1].hasPrefix("observer="), fields[2].hasPrefix("phase=") else { return nil }
            return String(fields[1].dropFirst("observer=".count))
        }
        XCTAssertEqual(identifiers.count, phases.count)
        XCTAssertEqual(Set(identifiers).count, 1)
        XCTAssertNotNil(identifiers.first.flatMap(UUID.init(uuidString:)))
        for (message, phase) in zip(messages, phases) { XCTAssertTrue(message.hasSuffix(" phase=\(phase.rawValue)")) }
        var second: [String] = []
        CompanionTrustObservation(arguments: ["--modex-trust-diagnostics"], write: { second.append($0) }).record(.rejectPin)
        XCTAssertNotEqual(second.first?.split(separator: " ")[1], messages.first?.split(separator: " ")[1])
    }
#endif

}
