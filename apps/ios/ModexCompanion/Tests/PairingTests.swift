import Foundation
import XCTest
@testable import ModexCompanion

final class PairingTests: XCTestCase {
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
}
