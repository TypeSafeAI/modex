import XCTest

// Demo navigation and menu actions require their actual destination before continuing.
// At most one retry is allowed while the original action remains present and ready.
private func completeDemoAction(timeout: TimeInterval = 30,
                              now: () -> Date = { Date() },
                              poll: () -> Void = { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2)) },
                              isPresented: () -> Bool,
                              isComplete: () -> Bool,
                              prepare: (TimeInterval) -> Bool,
                              isReady: () -> Bool,
                              tap: () -> Void) -> Bool {
    let deadline = now().addingTimeInterval(timeout)
    guard isPresented() else { return false }
    for attempt in 0..<2 {
        let remaining = deadline.timeIntervalSince(now())
        guard remaining > 0 else { return false }
        let prepared = prepare(remaining)
        if isComplete() { return attempt > 0 }
        if !isPresented() {
            guard attempt > 0 else { return false }
            break
        }
        guard prepared, isReady(), now() < deadline else { return false }
        tap()
        if isComplete() { return true }
        if !isPresented() { break }
    }
    while now() < deadline {
        poll()
        if isComplete() { return true }
    }
    return false
}

/// Runs without a Mac or fixture: the path App Review follows from the welcome screen.
final class DemoWorkspaceTests: XCTestCase {

    func testDemoNavigationRecoversIgnoredFirstTaps() {
        continueAfterFailure = false
        let prompts = answerSystemAlertsDuringActions()
        defer { removeUIInterruptionMonitor(prompts) }
        let app = XCUIApplication()
        app.launch()
        defer { app.terminate() }
        returnToWelcome(app)
        app.open(URL(string: "modex://demo")!)
        XCTAssertTrue(app.staticTexts["demo-status"].waitForExistence(timeout: UITestBudget.seconds(10)))
        var openingAttempts = 0
        XCTAssertTrue(openDemoThread(app) { thread in
            openingAttempts += 1
            if openingAttempts > 1 { thread.tap() }
        }, "An ignored first thread action must recover to the actual thread.")
        XCTAssertEqual(openingAttempts, 2)
        XCTAssertTrue(app.buttons["Back to threads"].waitForExistence(timeout: UITestBudget.seconds(10)))
        var attempts = 0
        XCTAssertTrue(backToDemoThreads(app) { back in
            attempts += 1
            // Deterministically reproduce a synthesized action with no navigation.
            if attempts > 1 { back.tap() }
        }, "An ignored first Back action must recover to the actual dashboard.")
        XCTAssertEqual(attempts, 2)
        XCTAssertTrue(app.buttons["workspace-options"].isReadyToTap)
        XCTAssertFalse(app.buttons["Back to threads"].exists)
    }

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
            completeDemoAction(
                now: { Date(timeIntervalSinceReferenceDate: self.clock) },
                poll: { self.clock += 0.2; if self.welcomeOnPoll { self.welcome = true } },
                isPresented: { self.presented },
                isComplete: {
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

    // `attachScreenshot` depends on this: a recorded-but-expected failure must not end the test even
    // when the test has asked to stop at the first failure.
    func testBestEffortEvidenceDoesNotStopTheTest() {
        continueAfterFailure = false
        var reached = false
        XCTExpectFailure("Simulated screenshot timeout", options: .nonStrict()) { XCTFail("Failed to get screenshot: simulated") }
        reached = true
        XCTAssertTrue(reached)
    }

    func testBudgetScaleIsAtLeastOne() {
        XCTAssertGreaterThanOrEqual(UITestBudget.scale, 1)
        XCTAssertEqual(UITestBudget.seconds(10), 10 * UITestBudget.scale)
    }

    func testDemoWorkspaceNeedsNoMac() {
        continueAfterFailure = false
        let prompts = answerSystemAlertsDuringActions()
        defer { removeUIInterruptionMonitor(prompts) }
        let app = XCUIApplication()
        app.launch()
        returnToWelcome(app)
        let demo = app.buttons["demo-button"]
        if !demo.isReadyToTap { app.swipeUp() }
        demo.tapWhenReady()

        XCTAssertTrue(app.staticTexts["demo-status"].waitForExistence(timeout: UITestBudget.seconds(10)), "The demo must say it is not a paired Mac.")
        XCTAssertEqual(app.staticTexts["demo-status"].label, "Demo workspace · not connected to a Mac")
        let thread = app.buttons["thread-demo-launch"]
        XCTAssertTrue(thread.waitForExistence(timeout: UITestBudget.seconds(10)))
        attachScreenshot(of: app, named: "Demo workspace")
        XCTAssertTrue(openDemoThread(app), "Opening the demo thread must reach its destination.")

        let approval = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "approve-")).firstMatch
        XCTAssertTrue(approval.waitForExistence(timeout: UITestBudget.seconds(10)), "The demo approval should appear.")
        approval.tapWhenReady()
        let confirmation = app.sheets["Approve this action?"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: UITestBudget.seconds(10)))
        XCTAssertTrue(confirmation.staticTexts["This is the demo. Nothing runs on a Mac; your answer is only recorded here."].exists)
        confirmation.buttons["Approve once"].tapWhenReady()
        XCTAssertTrue(app.staticTexts["Approved"].waitForExistence(timeout: UITestBudget.seconds(10)))
        attachScreenshot(of: app, named: "Demo approval")

        let input = app.inputField("followup-input")
        XCTAssertTrue(input.waitForExistence(timeout: UITestBudget.seconds(10)))
        input.typeTextWhenReady("Ship it", in: app)
        app.buttons["send-followup"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Got it: \"Ship it\"")).firstMatch.appears(within: UITestBudget.seconds(20)), "The demo must answer a follow-up.")
        attachScreenshot(of: app, named: "Demo follow-up")
        XCTAssertTrue(backToDemoThreads(app), "Back must reach the demo dashboard before another action.")

        app.buttons["new-thread"].tapWhenReady()
        let newInput = app.inputField("new-thread-input")
        XCTAssertTrue(newInput.waitForExistence(timeout: UITestBudget.seconds(10)))
        XCTAssertTrue(app.staticTexts["Creates a demo thread with scripted replies. Location and provider choices are simulated; nothing runs on a Mac."].exists)
        app.segmentedControls.buttons["Worktree"].tapWhenReady()
        app.segmentedControls.buttons["Claude"].tapWhenReady()
        newInput.typeTextWhenReady("Review from phone", in: app)
        app.buttons["new-thread-commands"].tapWhenReady()
        let search = app.textFields["Find a skill or command"]
        XCTAssertTrue(search.waitForExistence(timeout: UITestBudget.seconds(10)))
        search.typeTextWhenReady("demo-review", in: app)
        let skill = app.staticTexts["/demo-review"]
        XCTAssertTrue(skill.waitForExistence(timeout: UITestBudget.seconds(10)))
        skill.tapWhenReady()
        XCTAssertTrue(search.waitForNonExistence(timeout: UITestBudget.seconds(10)))
        XCTAssertTrue(newInput.waitForExistence(timeout: UITestBudget.seconds(10)))
        XCTAssertEqual(newInput.value as? String, "Review from phone /demo-review ")
        app.buttons["create-thread"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Got it: \"Review from phone /demo-review\"")).firstMatch.appears(within: UITestBudget.seconds(20)))
        attachScreenshot(of: app, named: "Demo thread with a skill")
        XCTAssertTrue(backToDemoThreads(app), "Back must reach the demo dashboard before another action.")

        app.buttons["workspace-options"].tapWhenReady()
        app.buttons["Reset demo workspace"].tapWhenReady()
        XCTAssertTrue(thread.waitForExistence(timeout: UITestBudget.seconds(10)))
        XCTAssertTrue(openDemoThread(app), "Opening the reset demo thread must reach its destination.")
        XCTAssertTrue(approval.waitForExistence(timeout: UITestBudget.seconds(10)), "Reset must restore the pending approval.")
        app.buttons["deny-launch-approval"].tapWhenReady()
        XCTAssertTrue(app.staticTexts["Denied"].waitForExistence(timeout: UITestBudget.seconds(10)))
        XCTAssertTrue(backToDemoThreads(app), "Back must reach the demo dashboard before another action.")

        app.buttons["workspace-options"].tapWhenReady()
        XCTAssertTrue(app.buttons["Pair with your Mac…"].waitForExistence(timeout: UITestBudget.seconds(5)), "Pairing must stay reachable from the demo.")
        let leave = app.buttons["Leave demo workspace"]
        let welcome = app.buttons["pair-button"]
        let menuPresented = { app.buttons["Pair with your Mac…"].exists && leave.exists }
        var initiated = false
        XCTAssertTrue(completeDemoAction(
            isPresented: menuPresented,
            isComplete: { welcome.exists },
            prepare: { remaining in
                if !initiated { return leave.waitUntilReady(timeout: remaining) }
                return waitUntil(timeout: remaining) { welcome.exists || !menuPresented() || leave.isReadyToTap }
            },
            isReady: { leave.isReadyToTap },
            tap: { initiated = true; leave.tap() }), "Leaving the demo must activate the menu action and reach the welcome screen.")
        XCTAssertTrue(app.buttons["pair-button"].waitForExistence(timeout: UITestBudget.seconds(10)), "Leaving the demo returns to the welcome screen.")
        XCTAssertTrue(demo.exists)
        app.open(URL(string: "modex://demo")!)
        XCTAssertTrue(app.staticTexts["demo-status"].waitForExistence(timeout: UITestBudget.seconds(10)), "The review QR URL must open the same offline workspace.")
        app.terminate()
        app.launch()
        XCTAssertTrue(demo.waitForExistence(timeout: UITestBudget.seconds(10)), "Demo access must not save a pairing on relaunch.")
    }

    func testDemoArchiveHidesThreadUntilShown() {
        continueAfterFailure = false
        let prompts = answerSystemAlertsDuringActions()
        defer { removeUIInterruptionMonitor(prompts) }
        let app = XCUIApplication()
        app.launch()
        defer { app.terminate() }
        returnToWelcome(app)
        app.open(URL(string: "modex://demo")!)
        XCTAssertTrue(app.staticTexts["demo-status"].waitForExistence(timeout: 10))
        let scroll = app.buttons["thread-demo-scroll"]
        XCTAssertTrue(scroll.waitForExistence(timeout: 10))
        let toggle = app.buttons["toggle-archived"]
        XCTAssertFalse(toggle.exists, "Nothing is archived in a fresh demo.")
        if !scroll.isReadyToTap { app.swipeUp() }
        scroll.press(forDuration: 1.0)
        let archive = app.buttons["Archive"]
        XCTAssertTrue(archive.waitForExistence(timeout: 10), "Holding a thread offers Archive.")
        archive.tap()
        XCTAssertTrue(scroll.waitForNonExistence(timeout: 10), "Archived threads are hidden by default.")
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(toggle.label, "Show archived (1)")
        capture(app, name: "Demo archived thread hidden")
        toggle.tapWhenReady()
        XCTAssertTrue(scroll.waitForExistence(timeout: 10), "Show archived reveals the thread.")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Archived · Codex")).firstMatch.waitForExistence(timeout: 10))
        capture(app, name: "Demo archived thread shown")
        scroll.tapWhenReady()
        let options = app.buttons["thread-options"]
        XCTAssertTrue(options.waitForExistence(timeout: 10))
        options.tapWhenReady()
        app.buttons["Unarchive thread"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Demo · Codex")).firstMatch.waitForExistence(timeout: 10), "Unarchiving clears the Archived label.")
        XCTAssertTrue(backToDemoThreads(app), "Back must reach the demo dashboard before another action.")
        XCTAssertTrue(toggle.waitForNonExistence(timeout: 10), "With nothing archived there is nothing to show.")
        XCTAssertTrue(scroll.exists)
    }

    // A preceding failed paired test can leave credentials behind. Reach welcome explicitly
    // before either demo entry path; the product correctly refuses demo URLs while paired.
    private func returnToWelcome(_ app: XCUIApplication) {
        let demo = app.buttons["demo-button"]
        if !demo.waitForExistence(timeout: UITestBudget.seconds(5)) {
            let options = app.buttons["workspace-options"]
            XCTAssertTrue(options.waitForExistence(timeout: UITestBudget.seconds(10)))
            options.tapWhenReady()
            if app.buttons["Leave demo workspace"].waitForExistence(timeout: UITestBudget.seconds(2)) {
                app.buttons["Leave demo workspace"].tapWhenReady()
            } else {
                app.buttons["Forget paired Mac…"].tapWhenReady()
                app.alerts["Forget this Mac?"].buttons["Forget Mac"].tapWhenReady()
            }
        }
        XCTAssertTrue(demo.waitForExistence(timeout: UITestBudget.seconds(15)))
    }

    private func openDemoThread(_ app: XCUIApplication, timeout: TimeInterval = UITestBudget.seconds(30),
                                tap: ((XCUIElement) -> Void)? = nil) -> Bool {
        let thread = app.buttons["thread-demo-launch"]
        let opened = { !thread.exists && app.buttons["Back to threads"].isReadyToTap }
        var initiated = false
        return completeDemoAction(
            timeout: timeout,
            isPresented: { thread.exists },
            isComplete: opened,
            prepare: { remaining in
                if !initiated { return thread.waitUntilReady(timeout: remaining) }
                return waitUntil(timeout: remaining) { opened() || !thread.exists || thread.isReadyToTap }
            },
            isReady: { thread.isReadyToTap },
            tap: {
                initiated = true
                if let tap { tap(thread) } else { thread.tap() }
            })
    }

    private func backToDemoThreads(_ app: XCUIApplication, timeout: TimeInterval = UITestBudget.seconds(30),
                                   tap: ((XCUIElement) -> Void)? = nil) -> Bool {
        let back = app.buttons["Back to threads"]
        let dashboard = { app.staticTexts["demo-status"].exists && app.buttons["workspace-options"].isReadyToTap && !back.exists }
        var initiated = false
        return completeDemoAction(
            timeout: timeout,
            isPresented: { back.exists },
            isComplete: dashboard,
            prepare: { remaining in
                if !initiated { return back.waitUntilReady(timeout: remaining) }
                return waitUntil(timeout: remaining) { dashboard() || !back.exists || back.isReadyToTap }
            },
            isReady: { back.isReadyToTap },
            tap: {
                initiated = true
                if let tap { tap(back) } else { back.tap() }
            })
    }
}
