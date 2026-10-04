import Foundation
import XCTest

final class CompanionFlowTests: XCTestCase {
    func testPairApproveAndFollowUpThroughTheMac() throws {
        guard let file = Bundle(for: Self.self).url(forResource: "LocalPairing", withExtension: "json"),
              let data = try? Data(contentsOf: file),
              let fixture = try? JSONDecoder().decode(Fixture.self, from: data) else {
            throw XCTSkip("Run Scripts/test-e2e.sh with the paired Mac fixture.")
        }
        let app = XCUIApplication()
        app.launch()
        let pair = app.buttons["pair-button"]
        if !pair.waitForExistence(timeout: 5) {
            forgetMac(app)
        }
        XCTAssertTrue(pair.waitForExistence(timeout: 15))
        pair.tap()
        let link = app.descendants(matching: .any)["pairing-link-input"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.tap()
        link.typeText(fixture.link)
        app.buttons["connect-button"].tap()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.firstMatch.waitForExistence(timeout: 3) {
            springboard.buttons["Allow"].tap()
        }
        let thread = app.buttons["thread-abcdef12"]
        XCTAssertTrue(thread.waitForExistence(timeout: 20), "The paired Mac's thread should appear.")
        capture(app, name: "Paired workspace")
        thread.tap()
        let approval = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "approve-")).firstMatch
        XCTAssertTrue(approval.waitForExistence(timeout: 20), "The pending Mac approval should appear.")
        capture(app, name: "Approval on iPhone")
        approval.tap()
        let confirmation = app.sheets["Approve this action?"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10))
        confirmation.buttons["Approve once"].tap()
        XCTAssertTrue(app.staticTexts["Approved"].waitForExistence(timeout: 20))

        let input = app.descendants(matching: .any)["followup-input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.typeText("Please summarize the result")
        app.buttons["send-followup"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Follow-up received: Please summarize the result")).firstMatch.waitForExistence(timeout: 20))
        capture(app, name: "Completed follow-up")
        app.buttons["Back to threads"].tap()
        app.buttons["workspace-options"].tap()
        app.buttons["Forget paired Mac…"].tap()
        let forgetConfirmation = app.alerts["Forget this Mac?"]
        forgetConfirmation.buttons["Cancel"].tap()
        XCTAssertTrue(forgetConfirmation.waitForNonExistence(timeout: 5))
        XCTAssertTrue(thread.exists, "Cancelling must preserve the paired workspace.")
        forgetMac(app)
        XCTAssertTrue(pair.waitForExistence(timeout: 10), "Forgetting the Mac returns to pairing.")
    }

    private func forgetMac(_ app: XCUIApplication) {
        let options = app.buttons["workspace-options"]
        XCTAssertTrue(options.waitForExistence(timeout: 10))
        options.tap()
        app.buttons["Forget paired Mac…"].tap()
        app.alerts["Forget this Mac?"].buttons["Forget Mac"].tap()
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private struct Fixture: Decodable { let link: String }
}
