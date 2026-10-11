import XCTest

// A menu tap can leave the native menu open on a loaded simulator. Require the real
// welcome screen; a dismissed menu alone does not prove that leaving the demo worked.
private func completeDemoExit(timeout: TimeInterval = 30,
                              now: () -> Date = { Date() },
                              poll: () -> Void = { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2)) },
                              isPresented: () -> Bool,
                              isWelcome: () -> Bool,
                              prepare: (TimeInterval) -> Bool,
                              isReady: () -> Bool,
                              tap: () -> Void) -> Bool {
    let deadline = now().addingTimeInterval(timeout)
    guard isPresented() else { return false }
    for attempt in 0..<2 {
        let remaining = deadline.timeIntervalSince(now())
        guard remaining > 0 else { return false }
        let prepared = prepare(remaining)
        if isWelcome() { return attempt > 0 }
        if !isPresented() {
            guard attempt > 0 else { return false }
            break
        }
        guard prepared, isReady(), now() < deadline else { return false }
        tap()
        if isWelcome() { return true }
        if !isPresented() { break }
    }
    while now() < deadline {
        poll()
        if isWelcome() { return true }
    }
    return false
}

/// Runs without a Mac or fixture: the path App Review follows from the welcome screen.
final class DemoWorkspaceTests: XCTestCase {

    func testDemoExitRetriesAnIgnoredTapWhileTheMenuRemains() {
        let probe = DemoExitProbe()
        probe.completeAfterTap = 2
        XCTAssertTrue(probe.complete())
        XCTAssertEqual(probe.taps, 2)
    }

    func testDemoExitStopsAfterWelcomeAppears() {
        let probe = DemoExitProbe()
        XCTAssertTrue(probe.complete())
        XCTAssertEqual(probe.taps, 1)
    }

    func testDemoExitNeverAcceptsMenuDismissalWithoutWelcome() {
        let probe = DemoExitProbe()
        probe.completeAfterTap = nil
        probe.dismissAfterTap = true
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 1)
    }

    func testDemoExitRejectsPersistentMenuAfterBoundedRetry() {
        let probe = DemoExitProbe()
        probe.completeAfterTap = nil
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 2)
    }

    func testDemoExitWaitsForWelcomeAfterMenuDismissalWithoutRetapping() {
        let probe = DemoExitProbe()
        probe.completeAfterTap = nil
        probe.dismissAfterTap = true
        probe.welcomeOnPoll = true
        XCTAssertTrue(probe.complete())
        XCTAssertEqual(probe.taps, 1)
    }

    func testDemoExitAcceptsWelcomeDuringRetryPreparationWithoutAnotherTap() {
        let probe = DemoExitProbe()
        probe.completeAfterTap = nil
        probe.welcomeDuringRetryPreparation = true
        XCTAssertTrue(probe.complete())
        XCTAssertEqual(probe.taps, 1)
    }

    func testDemoExitRefusesUnavailableAction() {
        let probe = DemoExitProbe()
        probe.ready = false
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 0)
    }

    func testDemoExitDoesNotTapIfMenuDisappearsDuringPreparation() {
        let probe = DemoExitProbe()
        probe.dismissDuringPreparation = true
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 0)
    }

    func testDemoExitRefusesMissingMenu() {
        let probe = DemoExitProbe()
        probe.presented = false
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 0)
    }

    func testDemoExitDoesNotTapAfterPreparationExhaustsDeadline() {
        let probe = DemoExitProbe()
        probe.preparationCost = 31
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 0)
    }

    func testDemoExitDoesNotRetryAfterSlowObservation() {
        let probe = DemoExitProbe()
        probe.completeAfterTap = nil
        probe.observationCost = 31
        XCTAssertFalse(probe.complete())
        XCTAssertEqual(probe.taps, 1)
    }

    private final class DemoExitProbe {
        var presented = true
        var welcome = false
        var ready = true
        var welcomeOnPoll = false
        var welcomeDuringRetryPreparation = false
        var completeAfterTap: Int? = 1
        var dismissAfterTap = false
        var dismissDuringPreparation = false
        var preparationCost: TimeInterval = 0
        var observationCost: TimeInterval = 0
        private(set) var taps = 0
        private var clock: TimeInterval = 0
        func complete() -> Bool {
            completeDemoExit(
                now: { Date(timeIntervalSinceReferenceDate: self.clock) },
                poll: { self.clock += 0.2; if self.welcomeOnPoll { self.welcome = true } },
                isPresented: { self.presented },
                isWelcome: {
                    if self.taps > 0 { self.clock += self.observationCost }
                    return self.welcome
                },
                prepare: { _ in
                    self.clock += self.preparationCost
                    if self.dismissDuringPreparation { self.presented = false }
                    if self.taps > 0 && self.welcomeDuringRetryPreparation {
                        self.welcome = true; self.presented = false; self.ready = false
                    }
                    return true
                },
                isReady: { self.ready },
                tap: {
                    self.taps += 1
                    if self.taps == self.completeAfterTap { self.welcome = true; self.presented = false }
                    else if self.dismissAfterTap { self.presented = false }
                })
        }
    }

    // An exhausted observation budget reproduces a slow accessibility read without sleeps or UI.
    func testTypedObservationAcceptsTerminalMatch() {
        var reads = 0
        let result = observeTypedText("Review from phone", timeout: 0) {
            reads += 1
            return reads == 1 ? "Review" : "Review from phone"
        }
        XCTAssertTrue(result.matches)
        XCTAssertEqual(result.value, "Review from phone")
        XCTAssertEqual(reads, 2)
    }

    func testTypedObservationRejectsTerminalMismatch() {
        var reads = 0
        let result = observeTypedText("Review from phone", timeout: 0) {
            reads += 1
            return reads == 1 ? "Review" : "Still incomplete"
        }
        XCTAssertFalse(result.matches)
        XCTAssertEqual(result.value, "Still incomplete")
        XCTAssertEqual(reads, 2)
    }

    func testTypedObservationRejectsMissingValue() {
        var reads = 0
        let result = observeTypedText("Review from phone", timeout: 0) {
            reads += 1
            return nil
        }
        XCTAssertFalse(result.matches)
        XCTAssertNil(result.value)
        XCTAssertEqual(reads, 2)
    }

    func testTypedObservationAcceptsImmediateMatchOnce() {
        var reads = 0
        let result = observeTypedText("Review from phone", timeout: 0) {
            reads += 1
            return "Review from phone"
        }
        XCTAssertTrue(result.matches)
        XCTAssertEqual(result.value, "Review from phone")
        XCTAssertEqual(reads, 1)
    }

    func testDemoWorkspaceNeedsNoMac() {
        continueAfterFailure = false
        let prompts = answerSystemAlertsDuringActions()
        defer { removeUIInterruptionMonitor(prompts) }
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
        if !demo.isReadyToTap { app.swipeUp() }
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
        input.typeTextWhenReady("Ship it", in: app)
        app.buttons["send-followup"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Got it: \"Ship it\"")).firstMatch.appears(within: 20), "The demo must answer a follow-up.")
        capture(app, name: "Demo follow-up")
        app.buttons["Back to threads"].tapWhenReady()

        app.buttons["new-thread"].tapWhenReady()
        let newInput = app.descendants(matching: .any)["new-thread-input"].firstMatch
        XCTAssertTrue(newInput.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Creates a demo thread with scripted replies. Location and provider choices are simulated; nothing runs on a Mac."].exists)
        app.segmentedControls.buttons["Worktree"].tapWhenReady()
        app.segmentedControls.buttons["Claude"].tapWhenReady()
        newInput.typeTextWhenReady("Review from phone", in: app)
        app.buttons["new-thread-commands"].tapWhenReady()
        let search = app.textFields["Find a skill or command"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.typeTextWhenReady("demo-review", in: app)
        let skill = app.staticTexts["/demo-review"]
        XCTAssertTrue(skill.waitForExistence(timeout: 10))
        skill.tapWhenReady()
        XCTAssertTrue(search.waitForNonExistence(timeout: 10))
        XCTAssertTrue(newInput.waitForExistence(timeout: 10))
        XCTAssertEqual(newInput.value as? String, "Review from phone /demo-review ")
        app.buttons["create-thread"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Got it: \"Review from phone /demo-review\"")).firstMatch.appears(within: 20))
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
        let leave = app.buttons["Leave demo workspace"]
        let welcome = app.buttons["pair-button"]
        let menuPresented = { app.buttons["Pair with your Mac…"].exists && leave.exists }
        var initiated = false
        XCTAssertTrue(completeDemoExit(
            isPresented: menuPresented,
            isWelcome: { welcome.exists },
            prepare: { remaining in
                if !initiated { return leave.waitUntilReady(timeout: remaining) }
                return waitUntil(timeout: remaining) { welcome.exists || !menuPresented() || leave.isReadyToTap }
            },
            isReady: { leave.isReadyToTap },
            tap: { initiated = true; leave.tap() }), "Leaving the demo must activate the menu action and reach the welcome screen.")
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
