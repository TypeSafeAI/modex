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

        let emptyProject = app.buttons["New thread in empty-project"]
        if !emptyProject.isHittable { app.swipeUp() }
        XCTAssertTrue(emptyProject.waitForExistence(timeout: 10), "Projects without threads must remain visible.")
        emptyProject.tap()
        let selectedProject = app.buttons["new-thread-project"]
        XCTAssertTrue(selectedProject.waitForExistence(timeout: 10))
        XCTAssertTrue((selectedProject.label + " " + (selectedProject.value as? String ?? "")).contains("empty-project"), "A project's New thread action must preselect that project.")
        app.buttons["Cancel"].tap()
        if !app.buttons["new-thread"].isHittable { app.swipeDown() }
        app.buttons["new-thread"].tap()
        let newThreadInput = app.descendants(matching: .any)["new-thread-input"].firstMatch
        XCTAssertTrue(newThreadInput.waitForExistence(timeout: 10))
        newThreadInput.tap()
        newThreadInput.typeText("Start from phone")
        app.buttons["new-thread-commands"].tap()
        let commandSearch = app.textFields["Find a skill or command"]
        XCTAssertTrue(commandSearch.waitForExistence(timeout: 10))
        commandSearch.tap()
        commandSearch.typeText("mobile-check")
        let mobileSkill = app.staticTexts["$mobile-check"]
        XCTAssertTrue(mobileSkill.waitForExistence(timeout: 10), "The Mac's project skill should appear for Codex.")
        mobileSkill.tap()
        XCTAssertTrue(commandSearch.waitForNonExistence(timeout: 10), "The skill sheet must finish dismissing before submitting.")
        let createThread = app.buttons["create-thread"]
        let readyToCreate = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND enabled == true AND hittable == true"),
            object: createThread
        )
        XCTAssertEqual(XCTWaiter.wait(for: [readyToCreate], timeout: 10), .completed, "Create thread must be ready for interaction.")
        capture(app, name: "New thread on iPhone")
        createThread.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Follow-up received: Start from phone $mobile-check")).firstMatch.waitForExistence(timeout: 20))
        app.buttons["Back to threads"].tap()

        app.terminate()
        app.launch()
        XCTAssertTrue(thread.waitForExistence(timeout: 20), "Pairing must survive relaunch without scanning again.")
        thread.tap()
        let approval = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "approve-")).firstMatch
        XCTAssertTrue(approval.waitForExistence(timeout: 20), "The pending Mac approval should appear.")
        capture(app, name: "Approval on iPhone")
        approval.tap()
        let confirmation = app.sheets["Approve this action?"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10))
        confirmation.buttons["Approve once"].tap()
        XCTAssertTrue(app.staticTexts["Approved"].waitForExistence(timeout: 20))
        XCTAssertTrue(confirmation.waitForNonExistence(timeout: 10), "The approval sheet must finish dismissing before focusing the composer.")

        let input = app.descendants(matching: .any)["followup-input"].firstMatch
        let readyToCompose = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND enabled == true AND hittable == true"),
            object: input
        )
        XCTAssertEqual(XCTWaiter.wait(for: [readyToCompose], timeout: 10), .completed, "The follow-up composer must be ready for interaction.")
        input.tap()
        input.typeText("Please summarize the result")
        app.buttons["send-followup"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Follow-up received: Please summarize the result")).firstMatch.waitForExistence(timeout: 20))
        capture(app, name: "Completed follow-up")
        app.buttons["Back to threads"].tap()
        if fixture.reconnect == true {
            XCTAssertTrue(app.staticTexts["Reconnected to your Mac"].waitForExistence(timeout: 60), "Bonjour must recover the saved pairing when the Mac restarts on a different port.")
            XCTAssertFalse(pair.exists)
            app.terminate()
            app.launch()
            XCTAssertTrue(app.staticTexts["Reconnected to your Mac"].waitForExistence(timeout: 20), "The verified new address must survive another relaunch.")
        }
        if fixture.reconnect != true {
            thread.tap()
            let recoveryInput = app.descendants(matching: .any)["followup-input"].firstMatch
            XCTAssertTrue(recoveryInput.waitForExistence(timeout: 10))
            recoveryInput.tap()
            recoveryInput.typeText("Pause for recovery")
            app.buttons["send-followup"].tap()
            XCTAssertTrue(app.staticTexts["Follow-up received: Pause for recovery"].waitForExistence(timeout: 10))
            app.buttons["Back to threads"].tap()
            let repair = app.buttons["repair-pairing"]
            XCTAssertTrue(repair.waitForExistence(timeout: 15), "A disconnected workspace must offer pairing recovery without forgetting the Mac.")
            XCTAssertFalse(app.buttons["new-thread"].isEnabled)
            XCTAssertTrue(app.buttons["retry-connection"].isHittable)
            capture(app, name: "Disconnected workspace recovery")
            repair.tap()
            XCTAssertTrue(app.buttons["scan-pairing-code"].waitForExistence(timeout: 10))
            app.buttons["Done"].tap()
            XCTAssertTrue(repair.waitForExistence(timeout: 5), "Cancelling a rescan must keep the saved workspace.")
            app.buttons["retry-connection"].tap()
            XCTAssertTrue(app.staticTexts["Mac connected"].waitForExistence(timeout: 60))
            XCTAssertTrue(app.buttons["new-thread"].isEnabled)
        }
        app.buttons["workspace-options"].tap()
        app.buttons["Forget paired Mac…"].tap()
        let forgetConfirmation = app.alerts["Forget this Mac?"]
        forgetConfirmation.buttons["Cancel"].tap()
        XCTAssertTrue(forgetConfirmation.waitForNonExistence(timeout: 5))
        XCTAssertTrue(thread.exists, "Cancelling must preserve the paired workspace.")
        if fixture.reconnect == true {
            thread.tap()
            let followup = app.descendants(matching: .any)["followup-input"].firstMatch
            XCTAssertTrue(followup.waitForExistence(timeout: 10))
            followup.tap()
            followup.typeText("Revoke this phone")
            app.buttons["send-followup"].tap()
            let revoked = app.alerts["Connection issue"]
            XCTAssertTrue(revoked.waitForExistence(timeout: 20), "Mac revocation must end the saved pairing.")
            XCTAssertTrue(revoked.staticTexts["Access was removed on your Mac. Pair again with a new code from Modex."].exists)
            revoked.buttons["OK"].tap()
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

    private struct Fixture: Decodable { let link: String; let reconnect: Bool? }
}
