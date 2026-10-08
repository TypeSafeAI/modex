import XCTest

/// Runs without a Mac or fixture: the path App Review follows from the welcome screen.
final class DemoWorkspaceTests: XCTestCase {
    func testDemoWorkspaceNeedsNoMac() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let demo = app.buttons["demo-button"]
        if !demo.waitForExistence(timeout: 5) {
            let options = app.buttons["workspace-options"]
            XCTAssertTrue(options.waitForExistence(timeout: 10))
            options.tapWhenReady()
            if app.buttons["Leave demo workspace"].waitForExistence(timeout: 2) {
                app.buttons["Leave demo workspace"].tapWhenReady()
            } else {
                app.buttons["Forget paired Mac…"].tapWhenReady()
                app.alerts["Forget this Mac?"].buttons["Forget Mac"].tapWhenReady()
            }
        }
        XCTAssertTrue(demo.waitForExistence(timeout: 15))
        if !demo.isHittable { app.swipeUp() }
        demo.tapWhenReady()

        XCTAssertTrue(app.staticTexts["demo-status"].waitForExistence(timeout: 10), "The demo must say it is not a paired Mac.")
        XCTAssertEqual(app.staticTexts["demo-status"].label, "Demo workspace · not connected to a Mac")
        let thread = app.buttons["thread-demo-launch"]
        XCTAssertTrue(thread.waitForExistence(timeout: 10))
        capture(app, name: "Demo workspace")
        thread.tapWhenReady()

        let approval = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "approve-")).firstMatch
        XCTAssertTrue(approval.waitForExistence(timeout: 10), "The demo approval should appear.")
        approval.tapWhenReady()
        let confirmation = app.sheets["Approve this action?"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10))
        XCTAssertTrue(confirmation.staticTexts["This is the demo. Nothing runs on a Mac; your answer is only recorded here."].exists)
        confirmation.buttons["Approve once"].tapWhenReady()
        XCTAssertTrue(app.staticTexts["Approved"].waitForExistence(timeout: 10))
        capture(app, name: "Demo approval")

        let input = app.descendants(matching: .any)["followup-input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tapWhenReady()
        input.typeText("Ship it")
        app.buttons["send-followup"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Got it: \"Ship it\"")).firstMatch.waitForExistence(timeout: 20), "The demo must answer a follow-up.")
        capture(app, name: "Demo follow-up")
        app.buttons["Back to threads"].tapWhenReady()

        app.buttons["new-thread"].tapWhenReady()
        let newInput = app.descendants(matching: .any)["new-thread-input"].firstMatch
        XCTAssertTrue(newInput.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Creates a demo thread with scripted replies. Location and provider choices are simulated; nothing runs on a Mac."].exists)
        app.segmentedControls.buttons["Worktree"].tapWhenReady()
        app.segmentedControls.buttons["Claude"].tapWhenReady()
        newInput.tapWhenReady()
        newInput.typeText("Review from phone")
        app.buttons["new-thread-commands"].tapWhenReady()
        let search = app.textFields["Find a skill or command"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tapWhenReady()
        search.typeText("demo-review")
        let skill = app.staticTexts["/demo-review"]
        XCTAssertTrue(skill.waitForExistence(timeout: 10))
        skill.tapWhenReady()
        XCTAssertTrue(search.waitForNonExistence(timeout: 10))
        XCTAssertTrue(newInput.waitForExistence(timeout: 10))
        XCTAssertEqual(newInput.value as? String, "Review from phone /demo-review ")
        app.buttons["create-thread"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Got it: \"Review from phone /demo-review\"")).firstMatch.waitForExistence(timeout: 20))
        capture(app, name: "Demo thread with a skill")
        app.buttons["Back to threads"].tapWhenReady()

        app.buttons["workspace-options"].tapWhenReady()
        app.buttons["Reset demo workspace"].tapWhenReady()
        XCTAssertTrue(thread.waitForExistence(timeout: 10))
        thread.tapWhenReady()
        XCTAssertTrue(approval.waitForExistence(timeout: 10), "Reset must restore the pending approval.")
        app.buttons["deny-launch-approval"].tapWhenReady()
        XCTAssertTrue(app.staticTexts["Denied"].waitForExistence(timeout: 10))
        app.buttons["Back to threads"].tapWhenReady()

        app.buttons["workspace-options"].tapWhenReady()
        XCTAssertTrue(app.buttons["Pair with your Mac…"].waitForExistence(timeout: 5), "Pairing must stay reachable from the demo.")
        app.buttons["Leave demo workspace"].tapWhenReady()
        XCTAssertTrue(app.buttons["pair-button"].waitForExistence(timeout: 10), "Leaving the demo returns to the welcome screen.")
        XCTAssertTrue(demo.exists)
        app.open(URL(string: "modex://demo")!)
        XCTAssertTrue(app.staticTexts["demo-status"].waitForExistence(timeout: 10), "The review QR URL must open the same offline workspace.")
        app.terminate()
        app.launch()
        XCTAssertTrue(demo.waitForExistence(timeout: 10), "Demo access must not save a pairing on relaunch.")
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
