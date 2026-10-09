import Foundation
import XCTest

final class CompanionFlowTests: XCTestCase {
    func testPairApproveAndFollowUpThroughTheMac() throws {
        continueAfterFailure = false
        guard let file = Bundle(for: Self.self).url(forResource: "LocalPairing", withExtension: "json"),
              let data = try? Data(contentsOf: file),
              let fixture = try? JSONDecoder().decode(Fixture.self, from: data) else {
            throw XCTSkip("Run Scripts/test-e2e.sh with the paired Mac fixture.")
        }
        let prompts = answerSystemAlertsDuringActions()
        defer { removeUIInterruptionMonitor(prompts) }
        let app = XCUIApplication()
        app.launch()
        let pair = app.buttons["pair-button"]
        if !pair.waitForExistence(timeout: 5) {
            forgetMac(app)
        }
        XCTAssertTrue(pair.waitForExistence(timeout: 15))
        pair.tapWhenReady()
        let link = app.descendants(matching: .any)["pairing-link-input"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.typeTextWhenReady(fixture.link, in: app)
        app.buttons["connect-button"].tapWhenReady()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.firstMatch.waitForExistence(timeout: 3) {
            springboard.buttons["Allow"].tap()
        }
        let thread = app.buttons["thread-abcdef12"]
        XCTAssertTrue(thread.appears(within: 20), "The paired Mac's thread should appear.")
        capture(app, name: "Paired workspace")

        let emptyProject = app.buttons["New thread in empty-project"]
        if !emptyProject.isReadyToTap { app.swipeUp() }
        XCTAssertTrue(emptyProject.waitForExistence(timeout: 10), "Projects without threads must remain visible.")
        emptyProject.tapWhenReady()
        let selectedProject = app.buttons["new-thread-project"]
        XCTAssertTrue(selectedProject.waitForExistence(timeout: 10))
        XCTAssertTrue((selectedProject.label + " " + (selectedProject.value as? String ?? "")).contains("empty-project"), "A project's New thread action must preselect that project.")
        app.buttons["Cancel"].tapWhenReady()
        if !app.buttons["new-thread"].isReadyToTap { app.swipeDown() }
        app.buttons["new-thread"].tapWhenReady()
        let newThreadInput = app.descendants(matching: .any)["new-thread-input"].firstMatch
        XCTAssertTrue(newThreadInput.waitForExistence(timeout: 10))
        newThreadInput.typeTextWhenReady("Start from phone", in: app)
        app.buttons["new-thread-commands"].tapWhenReady()
        let commandSearch = app.textFields["Find a skill or command"]
        XCTAssertTrue(commandSearch.waitForExistence(timeout: 10))
        commandSearch.typeTextWhenReady("mobile-check", in: app)
        let mobileSkill = app.staticTexts["$mobile-check"]
        XCTAssertTrue(mobileSkill.waitForExistence(timeout: 10), "The Mac's project skill should appear for Codex.")
        mobileSkill.tapWhenReady()
        XCTAssertTrue(commandSearch.waitForNonExistence(timeout: 10), "The skill sheet must finish dismissing before submitting.")
        capture(app, name: "New thread on iPhone")
        app.buttons["create-thread"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Follow-up received: Start from phone $mobile-check")).firstMatch.appears(within: 20))
        app.buttons["Back to threads"].tapWhenReady()

        app.terminate()
        app.launch()
        XCTAssertTrue(thread.appears(within: 20), "Pairing must survive relaunch without scanning again.")
        thread.tapWhenReady()
        let approval = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "approve-")).firstMatch
        XCTAssertTrue(approval.appears(within: 20), "The pending Mac approval should appear.")
        capture(app, name: "Approval on iPhone")
        approval.tapWhenReady()
        let confirmation = app.sheets["Approve this action?"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10))
        confirmation.buttons["Approve once"].tapWhenReady()
        XCTAssertTrue(app.staticTexts["Approved"].appears(within: 20))
        XCTAssertTrue(confirmation.waitForNonExistence(timeout: 10), "The approval sheet must finish dismissing before focusing the composer.")

        let input = app.descendants(matching: .any)["followup-input"].firstMatch
        input.typeTextWhenReady("Please summarize the result", in: app)
        app.buttons["send-followup"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Follow-up received: Please summarize the result")).firstMatch.appears(within: 20))
        capture(app, name: "Completed follow-up")
        app.buttons["Back to threads"].tapWhenReady()
        if fixture.reconnect == true {
            XCTAssertTrue(app.staticTexts["Reconnected to your Mac"].appears(within: 60), "Bonjour must recover the saved pairing when the Mac restarts on a different port.")
            XCTAssertFalse(pair.exists)
            app.terminate()
            app.launch()
            XCTAssertTrue(app.staticTexts["Reconnected to your Mac"].appears(within: 20), "The verified new address must survive another relaunch.")
        }
        if fixture.reconnect != true {
            thread.tapWhenReady()
            let recoveryInput = app.descendants(matching: .any)["followup-input"].firstMatch
            XCTAssertTrue(recoveryInput.waitForExistence(timeout: 10))
            recoveryInput.typeTextWhenReady("Pause for recovery", in: app)
            app.buttons["send-followup"].tapWhenReady()
            XCTAssertTrue(app.staticTexts["Follow-up received: Pause for recovery"].waitForExistence(timeout: 10))
            app.buttons["Back to threads"].tapWhenReady()
            let repair = app.buttons["repair-pairing"]
            XCTAssertTrue(repair.appears(within: 30), "A disconnected workspace must offer pairing recovery without forgetting the Mac.")
            XCTAssertFalse(app.buttons["new-thread"].isEnabled)
            XCTAssertTrue(app.buttons["retry-connection"].isReadyToTap)
            capture(app, name: "Disconnected workspace recovery")
            repair.tapWhenReady()
            XCTAssertTrue(app.buttons["scan-pairing-code"].waitForExistence(timeout: 10))
            app.buttons["Done"].tapWhenReady()
            XCTAssertTrue(repair.waitForExistence(timeout: 5), "Cancelling a rescan must keep the saved workspace.")
            let retry = app.buttons["retry-connection"]
            retry.tapWhenReady()
            // The retry waits out the phone's 8 s request timeout against the paused Mac before it re-enables.
            XCTAssertTrue(waitUntil(timeout: 30) { retry.isEnabled }, "An offline retry must finish without losing the saved workspace.")
            XCTAssertTrue(repair.exists)
            XCTAssertFalse(app.buttons["new-thread"].isEnabled)
            try resumeMac(fixture)
            XCTAssertTrue(app.staticTexts["Mac connected"].appears(within: 60))
            XCTAssertTrue(app.buttons["new-thread"].isEnabled)
        }
        app.buttons["workspace-options"].tapWhenReady()
        app.buttons["Forget paired Mac…"].tapWhenReady()
        let forgetConfirmation = app.alerts["Forget this Mac?"]
        forgetConfirmation.buttons["Cancel"].tapWhenReady()
        XCTAssertTrue(forgetConfirmation.waitForNonExistence(timeout: 5))
        XCTAssertTrue(thread.exists, "Cancelling must preserve the paired workspace.")
        if fixture.reconnect == true {
            thread.tapWhenReady()
            let followup = app.descendants(matching: .any)["followup-input"].firstMatch
            XCTAssertTrue(followup.waitForExistence(timeout: 10))
            followup.typeTextWhenReady("Revoke this phone", in: app)
            app.buttons["send-followup"].tapWhenReady()
            let revoked = app.alerts["Connection issue"]
            XCTAssertTrue(revoked.appears(within: 20), "Mac revocation must end the saved pairing.")
            XCTAssertTrue(revoked.staticTexts["Access was removed on your Mac. Pair again with a new code from Modex."].exists)
            revoked.buttons["OK"].tapWhenReady()
            XCTAssertTrue(pair.waitForExistence(timeout: 10))
            app.terminate()
            app.launch()
            XCTAssertTrue(pair.waitForExistence(timeout: 10), "A revoked pairing must stay revoked after relaunch.")
        } else {
            forgetMac(app)
            XCTAssertTrue(pair.waitForExistence(timeout: 10), "Forgetting the Mac returns to pairing.")
        }
    }

    private func forgetMac(_ app: XCUIApplication) {
        let options = app.buttons["workspace-options"]
        XCTAssertTrue(options.waitForExistence(timeout: 10))
        options.tapWhenReady()
        app.buttons["Forget paired Mac…"].tapWhenReady()
        app.alerts["Forget this Mac?"].buttons["Forget Mac"].tapWhenReady()
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func resumeMac(_ fixture: Fixture) throws {
        let url = try XCTUnwrap(fixture.resumeURL.flatMap(URL.init(string:)), "Run the current test-e2e.sh fixture with explicit outage control.")
        let resumed = expectation(description: "The Mac fixture has resumed")
        var failure: Error?
        var status: Int?
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        URLSession.shared.dataTask(with: request) { _, response, error in
            failure = error
            status = (response as? HTTPURLResponse)?.statusCode
            resumed.fulfill()
        }.resume()
        wait(for: [resumed], timeout: 10)
        XCTAssertNil(failure)
        XCTAssertEqual(status, 204, "The fixture must resume before the user retries the saved connection.")
    }

    private struct Fixture: Decodable { let link: String; let reconnect: Bool?; let resumeURL: String? }
}
