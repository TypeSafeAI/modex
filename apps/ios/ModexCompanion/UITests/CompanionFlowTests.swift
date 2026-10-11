import Foundation
import XCTest

// Confirm this alert's action, with at most one guarded retry inside the original readiness budget.
// Individual XCTest queries can overrun that deadline; no new tap starts after observing its expiry.
private func completeForgetConfirmation(timeout: TimeInterval = 30,
                                        now: () -> Date = { Date() },
                                        poll: () -> Void = { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2)) },
                                        isPresented: () -> Bool,
                                        prepare: (TimeInterval) -> Bool,
                                        isReady: () -> Bool,
                                        tap: () -> Void) -> Bool {
    let deadline = now().addingTimeInterval(timeout)
    guard isPresented() else { return false }
    for attempt in 0..<2 {
        let remaining = deadline.timeIntervalSince(now())
        guard remaining > 0 else { return false }
        let prepared = prepare(remaining)
        let ready = prepared && isReady()
        if !isPresented() { return attempt > 0 }
        guard ready, now() < deadline else { return false }
        tap()
        if !isPresented() { return true }
    }
    while now() < deadline {
        poll()
        if !isPresented() { return true }
    }
    return false
}

final class CompanionFlowTests: XCTestCase {
    func testForgetConfirmationRecoversAnIgnoredFirstTap() {
        let probe = ForgetConfirmationProbe()
        probe.dismissAfterTap = 2
        probe.preparationCost = 4
        XCTAssertTrue(probe.complete())
        XCTAssertEqual(probe.taps, 2)
        XCTAssertEqual(probe.preparationBudgets, [30, 26], "A retry shares the original deadline.")
    }

    func testForgetConfirmationStopsAfterImmediateDismissal() {
        let probe = ForgetConfirmationProbe()
        XCTAssertTrue(probe.complete())
        XCTAssertEqual(probe.taps, 1)
        XCTAssertEqual(probe.preparationBudgets, [30])
    }

    func testForgetConfirmationRejectsPersistentDialogAfterTwoTaps() {
        let probe = ForgetConfirmationProbe()
        probe.dismissAfterTap = nil
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 2)
    }

    func testForgetConfirmationRejectsInitiallyAbsentAlert() {
        let probe = ForgetConfirmationProbe()
        probe.presented = false
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 0)
        XCTAssertTrue(probe.preparationBudgets.isEmpty)
    }

    func testForgetConfirmationRejectsUnavailableButton() {
        let probe = ForgetConfirmationProbe()
        probe.preparationSucceeds = false
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 0)
    }

    func testForgetConfirmationRechecksButtonBeforeActing() {
        let probe = ForgetConfirmationProbe()
        probe.ready = false
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 0)
    }

    func testForgetConfirmationRejectsReadinessBeyondDeadline() {
        let probe = ForgetConfirmationProbe()
        probe.preparationCost = 31
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 0)
    }

    func testForgetConfirmationDoesNotRetryAfterSlowObservation() {
        let probe = ForgetConfirmationProbe()
        probe.dismissAfterTap = nil
        probe.postTapObservationCost = 31
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 1)
    }

    func testForgetConfirmationAcceptsDismissalDuringRetryPreparation() {
        let probe = ForgetConfirmationProbe()
        probe.dismissAfterTap = nil
        probe.dismissDuringRetryPreparation = true
        XCTAssertTrue(probe.complete())
        XCTAssertEqual(probe.taps, 1)
    }

    func testForgetConfirmationObservesDelayedDismissalAfterSecondTap() {
        let probe = ForgetConfirmationProbe()
        probe.dismissAfterTap = nil
        probe.dismissOnSecondTapObservation = 2
        XCTAssertTrue(probe.complete())
        XCTAssertEqual(probe.taps, 2)
    }

    private final class ForgetConfirmationProbe {
        var presented = true
        var ready = true
        var preparationSucceeds = true
        var dismissAfterTap: Int? = 1
        var preparationCost: TimeInterval = 0
        var postTapObservationCost: TimeInterval = 0
        var dismissDuringRetryPreparation = false
        var dismissOnSecondTapObservation: Int?
        private(set) var taps = 0
        private(set) var preparationBudgets: [TimeInterval] = []
        private var clock: TimeInterval = 0
        private var secondTapObservations = 0

        func complete() -> Bool {
            completeForgetConfirmation(
                now: { Date(timeIntervalSinceReferenceDate: self.clock) },
                poll: { self.clock += 0.2 },
                isPresented: {
                    if self.taps > 0 { self.clock += self.postTapObservationCost }
                    if self.taps == 2 {
                        self.secondTapObservations += 1
                        if self.secondTapObservations == self.dismissOnSecondTapObservation { self.presented = false }
                    }
                    return self.presented
                },
                prepare: { remaining in
                    self.preparationBudgets.append(remaining)
                    self.clock += self.preparationCost
                    if self.taps > 0 && self.dismissDuringRetryPreparation {
                        self.presented = false
                        return false
                    }
                    return self.preparationSucceeds
                },
                isReady: { self.ready },
                tap: {
                    self.taps += 1
                    if self.taps == self.dismissAfterTap { self.presented = false }
                })
        }
    }

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
        let link = app.inputField("pairing-link-input")
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
        let newThreadInput = app.inputField("new-thread-input")
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

        let input = app.inputField("followup-input")
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
            let recoveryInput = app.inputField("followup-input")
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
            let followup = app.inputField("followup-input")
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
        let confirmation = app.alerts["Forget this Mac?"]
        let forget = confirmation.buttons["Forget Mac"]
        var initiated = false
        XCTAssertTrue(completeForgetConfirmation(
            isPresented: { confirmation.exists },
            prepare: { remaining in
                if !initiated { return forget.waitUntilReady(timeout: remaining) }
                // Dismissal after our first tap is success, not a missing-button readiness failure.
                return waitUntil(timeout: remaining) { !confirmation.exists || forget.isReadyToTap }
            },
            isReady: { forget.isReadyToTap },
            tap: { initiated = true; forget.tap() }), "The Forget Mac confirmation must finish before waiting for pairing.")
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
