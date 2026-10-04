import Foundation
import XCTest
@testable import ModexCompanion

final class PairingTests: XCTestCase {
    func testLocalPairingLinkRoundTrips() throws {
        let original = Pairing(url: URL(string: "https://192.168.1.12:43120")!, token: String(repeating: "a", count: 64), fingerprint: String(repeating: "b", count: 64))
        let encoded = try JSONEncoder().encode(original).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(try Pairing.from(link: "modex://pair?data=\(encoded)"), original)
    }

    func testPublicHostAndShortSecretAreRejected() throws {
        for (url, token) in [("https://example.com", String(repeating: "a", count: 64)), ("https://192.168.1.12", "short")] {
            let candidate = Pairing(url: URL(string: url)!, token: token, fingerprint: String(repeating: "b", count: 64))
            let encoded = try JSONEncoder().encode(candidate).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
            XCTAssertThrowsError(try Pairing.from(link: "modex://pair?data=\(encoded)"))
        }
    }
}
