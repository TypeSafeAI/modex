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

// CI 38701902304 recorded the connected dashboard after an ignored options tap.
// Retry the opener once, never toggling an already visible menu or extending the deadline.
private func openWorkspaceMenu(timeout: TimeInterval,
                               observation: TimeInterval,
                               now: () -> Date = { Date() },
                               isOpen: () -> Bool,
                               prepare: (TimeInterval) -> Bool,
                               tap: () -> Void,
                               observe: (TimeInterval) -> Bool) -> Bool {
    let deadline = now().addingTimeInterval(timeout)
    for attempt in 0..<2 {
        if isOpen() { return true }
        let remaining = deadline.timeIntervalSince(now())
        guard remaining > 0 else { return false }
        let ready = prepare(remaining)
        if isOpen() { return true }
        guard ready, now() < deadline else { return false }
        tap()
        let remainingAfterTap = deadline.timeIntervalSince(now())
        let wait = attempt == 0 ? min(observation, remainingAfterTap) : remainingAfterTap
        if wait > 0, observe(wait) { return true }
    }
    return isOpen()
}

final class CompanionFlowTests: XCTestCase {
    func testWorkspaceMenuRecoversIgnoredTap() {
        var taps = 0
        XCTAssertTrue(openWorkspaceMenu(timeout: 30, observation: 5,
            isOpen: { taps == 2 }, prepare: { _ in true }, tap: { taps += 1 }, observe: { _ in taps == 2 }))
        XCTAssertEqual(taps, 2)
    }

    func testWorkspaceMenuStopsAfterOpening() {
        var taps = 0
        XCTAssertTrue(openWorkspaceMenu(timeout: 30, observation: 5,
            isOpen: { taps == 1 }, prepare: { _ in true }, tap: { taps += 1 }, observe: { _ in taps == 1 }))
        XCTAssertEqual(taps, 1)
    }

    func testWorkspaceMenuRequiresMenuAfterTwoTaps() {
        var taps = 0
        XCTAssertFalse(openWorkspaceMenu(timeout: 30, observation: 5,
            isOpen: { false }, prepare: { _ in true }, tap: { taps += 1 }, observe: { _ in false }))
        XCTAssertEqual(taps, 2)
    }

    func testWorkspaceMenuDoesNotToggleDelayedMenu() {
        var open = false
        var taps = 0
        XCTAssertTrue(openWorkspaceMenu(timeout: 30, observation: 5,
            isOpen: { open }, prepare: { _ in open = true; return true },
            tap: { taps += 1 }, observe: { _ in false }))
        XCTAssertEqual(taps, 0)
    }

    func testWorkspaceMenuDoesNotToggleDuringRetryPreparation() {
        var open = false
        var taps = 0
        XCTAssertTrue(openWorkspaceMenu(timeout: 30, observation: 5,
            isOpen: { open }, prepare: { _ in if taps == 1 { open = true }; return true },
            tap: { taps += 1 }, observe: { _ in false }))
        XCTAssertEqual(taps, 1)
    }

    func testWorkspaceMenuDoesNotTapAfterDeadline() {
        var time = Date(timeIntervalSince1970: 0)
        var taps = 0
        XCTAssertFalse(openWorkspaceMenu(timeout: 30, observation: 5, now: { time },
            isOpen: { false }, prepare: { _ in time = time.addingTimeInterval(31); return true },
            tap: { taps += 1 }, observe: { _ in false }))
        XCTAssertEqual(taps, 0)
    }

    func testWorkspaceMenuDoesNotRetryAfterSlowObservation() {
        var time = Date(timeIntervalSince1970: 0)
        var taps = 0
        XCTAssertFalse(openWorkspaceMenu(timeout: 30, observation: 5, now: { time },
            isOpen: { false }, prepare: { _ in true }, tap: { taps += 1 },
            observe: { _ in time = time.addingTimeInterval(31); return false }))
        XCTAssertEqual(taps, 1)
    }

    func testWorkspaceMenuUsesRemainingBudgetAfterRetry() {
        var time = Date(timeIntervalSince1970: 0)
        var taps = 0
        var budgets: [TimeInterval] = []
        XCTAssertTrue(openWorkspaceMenu(timeout: 30, observation: 5, now: { time },
            isOpen: { false }, prepare: { _ in true }, tap: { taps += 1 },
            observe: { budget in
                budgets.append(budget)
                if taps == 1 { time = time.addingTimeInterval(budget); return false }
                // The second tap's menu arrives seven seconds later, still inside the deadline.
                return budget >= 7
            }))
        XCTAssertEqual(taps, 2)
        XCTAssertEqual(budgets, [5, 25])
    }

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

    func testLoopbackPostReturnsTheFixtureStatus() throws {
        let fixture = try LoopbackListener(reply: "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:\(fixture.port)/resume/3f64b7e9"))
        XCTAssertEqual(try postToLoopback(url, timeout: 10), 204)
        XCTAssertEqual(fixture.request(within: 5)?.components(separatedBy: "\r\n").first, "POST /resume/3f64b7e9 HTTP/1.1")
    }

    func testLoopbackPostGivesUpOnASilentFixtureAtItsDeadline() throws {
        let fixture = try LoopbackListener(reply: nil)
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:\(fixture.port)/resume/3f64b7e9"))
        let started = Date()
        XCTAssertThrowsError(try postToLoopback(url, timeout: 0.5)) { XCTAssertEqual($0 as? LoopbackPostError, .timedOut(phase: "reply")) }
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 0.45)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10, "The deadline covers the whole exchange.")
        XCTAssertNotNil(fixture.request(within: 5), "The request reached the fixture before the reply wait.")
    }

    func testLoopbackPostFailsFastWhenNothingListens() throws {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:\(try unusedLoopbackPort())/resume/3f64b7e9"))
        let started = Date()
        XCTAssertThrowsError(try postToLoopback(url, timeout: 30)) { XCTAssertEqual($0 as? LoopbackPostError, .system(call: "connect", code: ECONNREFUSED)) }
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
    }

    func testLoopbackPostOnlyTakesAnIPv4Address() {
        // A host name would need a resolver in the simulator, which is what this helper avoids.
        XCTAssertThrowsError(try postToLoopback(URL(string: "http://localhost:80/resume")!, timeout: 1)) {
            XCTAssertEqual($0 as? LoopbackPostError, .invalidURL("http://localhost:80/resume"))
        }
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
        if !pair.waitForExistence(timeout: UITestBudget.seconds(5)) {
            forgetMac(app)
        }
        XCTAssertTrue(pair.waitForExistence(timeout: UITestBudget.seconds(15)))
        pair.tapWhenReady()
        let link = app.inputField("pairing-link-input")
        XCTAssertTrue(link.waitForExistence(timeout: UITestBudget.seconds(10)))
        link.typeTextWhenReady(fixture.link, in: app)
        app.buttons["connect-button"].tapWhenReady()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.firstMatch.waitForExistence(timeout: UITestBudget.seconds(3)) {
            springboard.buttons["Allow"].tap()
        }
        let thread = app.buttons["thread-abcdef12"]
        XCTAssertTrue(thread.appears(within: UITestBudget.seconds(20)), "The paired Mac's thread should appear.")
        attachScreenshot(of: app, named: "Paired workspace")

        let emptyProject = app.buttons["New thread in empty-project"]
        if !emptyProject.isReadyToTap { app.swipeUp() }
        XCTAssertTrue(emptyProject.waitForExistence(timeout: UITestBudget.seconds(10)), "Projects without threads must remain visible.")
        emptyProject.tapWhenReady()
        let selectedProject = app.buttons["new-thread-project"]
        XCTAssertTrue(selectedProject.waitForExistence(timeout: UITestBudget.seconds(10)))
        XCTAssertTrue((selectedProject.label + " " + (selectedProject.value as? String ?? "")).contains("empty-project"), "A project's New thread action must preselect that project.")
        app.buttons["Cancel"].tapWhenReady()
        if !app.buttons["new-thread"].isReadyToTap { app.swipeDown() }
        app.buttons["new-thread"].tapWhenReady()
        let newThreadInput = app.inputField("new-thread-input")
        XCTAssertTrue(newThreadInput.waitForExistence(timeout: UITestBudget.seconds(10)))
        newThreadInput.typeTextWhenReady("Start from phone", in: app)
        app.buttons["new-thread-commands"].tapWhenReady()
        let commandSearch = app.textFields["Find a skill or command"]
        XCTAssertTrue(commandSearch.waitForExistence(timeout: UITestBudget.seconds(10)))
        commandSearch.typeTextWhenReady("mobile-check", in: app)
        let mobileSkill = app.staticTexts["$mobile-check"]
        XCTAssertTrue(mobileSkill.waitForExistence(timeout: UITestBudget.seconds(10)), "The Mac's project skill should appear for Codex.")
        mobileSkill.tapWhenReady()
        XCTAssertTrue(commandSearch.waitForNonExistence(timeout: UITestBudget.seconds(10)), "The skill sheet must finish dismissing before submitting.")
        attachScreenshot(of: app, named: "New thread on iPhone")
        app.buttons["create-thread"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Follow-up received: Start from phone $mobile-check")).firstMatch.appears(within: UITestBudget.seconds(20)))
        app.buttons["Back to threads"].tapWhenReady()

        app.terminate()
        app.launch()
        XCTAssertTrue(thread.appears(within: UITestBudget.seconds(20)), "Pairing must survive relaunch without scanning again.")
        thread.tapWhenReady()
        let approval = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "approve-")).firstMatch
        XCTAssertTrue(approval.appears(within: UITestBudget.seconds(20)), "The pending Mac approval should appear.")
        attachScreenshot(of: app, named: "Approval on iPhone")
        approval.tapWhenReady()
        let confirmation = app.sheets["Approve this action?"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: UITestBudget.seconds(10)))
        confirmation.buttons["Approve once"].tapWhenReady()
        XCTAssertTrue(app.staticTexts["Approved"].appears(within: UITestBudget.seconds(20)))
        XCTAssertTrue(confirmation.waitForNonExistence(timeout: UITestBudget.seconds(10)), "The approval sheet must finish dismissing before focusing the composer.")

        let input = app.inputField("followup-input")
        input.typeTextWhenReady("Please summarize the result", in: app)
        app.buttons["send-followup"].tapWhenReady()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Follow-up received: Please summarize the result")).firstMatch.appears(within: UITestBudget.seconds(20)))
        attachScreenshot(of: app, named: "Completed follow-up")
        app.buttons["Back to threads"].tapWhenReady()
        if fixture.reconnect == true {
            XCTAssertTrue(app.staticTexts["Reconnected to your Mac"].appears(within: UITestBudget.seconds(60)), "Bonjour must recover the saved pairing when the Mac restarts on a different port.")
            XCTAssertFalse(pair.exists)
            app.terminate()
            app.launch()
            XCTAssertTrue(app.staticTexts["Reconnected to your Mac"].appears(within: UITestBudget.seconds(20)), "The verified new address must survive another relaunch.")
        }
        if fixture.reconnect != true {
            thread.tapWhenReady()
            let recoveryInput = app.inputField("followup-input")
            XCTAssertTrue(recoveryInput.waitForExistence(timeout: UITestBudget.seconds(10)))
            recoveryInput.typeTextWhenReady("Pause for recovery", in: app)
            app.buttons["send-followup"].tapWhenReady()
            XCTAssertTrue(app.staticTexts["Follow-up received: Pause for recovery"].waitForExistence(timeout: UITestBudget.seconds(10)))
            app.buttons["Back to threads"].tapWhenReady()
            let repair = app.buttons["repair-pairing"]
            XCTAssertTrue(repair.appears(within: UITestBudget.seconds(30)), "A disconnected workspace must offer pairing recovery without forgetting the Mac.")
            XCTAssertFalse(app.buttons["new-thread"].isEnabled)
            XCTAssertTrue(app.buttons["retry-connection"].isReadyToTap)
            attachScreenshot(of: app, named: "Disconnected workspace recovery")
            repair.tapWhenReady()
            XCTAssertTrue(app.buttons["scan-pairing-code"].waitForExistence(timeout: UITestBudget.seconds(10)))
            app.buttons["Done"].tapWhenReady()
            XCTAssertTrue(repair.waitForExistence(timeout: UITestBudget.seconds(5)), "Cancelling a rescan must keep the saved workspace.")
            let retry = app.buttons["retry-connection"]
            retry.tapWhenReady()
            // The retry waits out the phone's 8 s request timeout against the paused Mac before it re-enables.
            XCTAssertTrue(waitUntil(timeout: UITestBudget.seconds(30)) { retry.isEnabled }, "An offline retry must finish without losing the saved workspace.")
            XCTAssertTrue(repair.exists)
            XCTAssertFalse(app.buttons["new-thread"].isEnabled)
            try resumeMac(fixture)
            XCTAssertTrue(app.staticTexts["Mac connected"].appears(within: UITestBudget.seconds(60)))
            XCTAssertTrue(app.buttons["new-thread"].isEnabled)
        }
        guard openForgetMenu(app) else { return }
        app.buttons["Forget paired Mac…"].tapWhenReady()
        let forgetConfirmation = app.alerts["Forget this Mac?"]
        forgetConfirmation.buttons["Cancel"].tapWhenReady()
        XCTAssertTrue(forgetConfirmation.waitForNonExistence(timeout: UITestBudget.seconds(5)))
        XCTAssertTrue(thread.exists, "Cancelling must preserve the paired workspace.")
        if fixture.reconnect == true {
            thread.tapWhenReady()
            let followup = app.inputField("followup-input")
            XCTAssertTrue(followup.waitForExistence(timeout: UITestBudget.seconds(10)))
            followup.typeTextWhenReady("Revoke this phone", in: app)
            app.buttons["send-followup"].tapWhenReady()
            let revoked = app.alerts["Connection issue"]
            XCTAssertTrue(revoked.appears(within: UITestBudget.seconds(20)), "Mac revocation must end the saved pairing.")
            XCTAssertTrue(revoked.staticTexts["Access was removed on your Mac. Pair again with a new code from Modex."].exists)
            revoked.buttons["OK"].tapWhenReady()
            XCTAssertTrue(pair.waitForExistence(timeout: UITestBudget.seconds(10)))
            app.terminate()
            app.launch()
            XCTAssertTrue(pair.waitForExistence(timeout: UITestBudget.seconds(10)), "A revoked pairing must stay revoked after relaunch.")
        } else {
            forgetMac(app)
            XCTAssertTrue(pair.waitForExistence(timeout: UITestBudget.seconds(10)), "Forgetting the Mac returns to pairing.")
        }
    }

    private func openForgetMenu(_ app: XCUIApplication) -> Bool {
        let options = app.buttons["workspace-options"]
        let item = app.buttons["Forget paired Mac…"]
        let opened = openWorkspaceMenu(timeout: UITestBudget.seconds(30), observation: UITestBudget.seconds(5),
            isOpen: { item.exists },
            prepare: { remaining in waitUntil(timeout: remaining) { item.exists || options.isReadyToTap } },
            tap: { options.tap() }, observe: { item.waitForExistence(timeout: $0) })
        XCTAssertTrue(opened, "Workspace options must present Forget paired Mac before continuing.")
        return opened
    }

    private func forgetMac(_ app: XCUIApplication) {
        guard openForgetMenu(app) else { return }
        app.buttons["Forget paired Mac…"].tapWhenReady()
        let confirmation = app.alerts["Forget this Mac?"]
        let forget = confirmation.buttons["Forget Mac"]
        var initiated = false
        XCTAssertTrue(completeForgetConfirmation(
            timeout: UITestBudget.seconds(30),
            isPresented: { confirmation.exists },
            prepare: { remaining in
                if !initiated { return forget.waitUntilReady(timeout: remaining) }
                // Dismissal after our first tap is success, not a missing-button readiness failure.
                return waitUntil(timeout: remaining) { !confirmation.exists || forget.isReadyToTap }
            },
            isReady: { forget.isReadyToTap },
            tap: { initiated = true; forget.tap() }), "The Forget Mac confirmation must finish before waiting for pairing.")
    }

    /// Not URLSession: its first use in the runner could take 20–40 s on a booting CI simulator (see
    /// `postToLoopback`). The fixture logs when it receives this and when it answers.
    private func resumeMac(_ fixture: Fixture) throws {
        let url = try XCTUnwrap(fixture.resumeURL.flatMap(URL.init(string:)), "Run the current test-e2e.sh fixture with explicit outage control.")
        let started = Date()
        do {
            let status = try postToLoopback(url, timeout: UITestBudget.seconds(10))
            XCTAssertEqual(status, 204, "The fixture must resume before the user retries the saved connection.")
        } catch {
            XCTFail("The Mac fixture's resume \(error) after \(String(format: "%.1f", Date().timeIntervalSince(started))) s\(UITestBudget.note).")
        }
    }

    private struct Fixture: Decodable { let link: String; let reconnect: Bool?; let resumeURL: String? }
}

/// 127.0.0.1 with port 0, for `bind` to pick an ephemeral port.
private func loopbackAddress() -> sockaddr_in {
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    return address
}

/// Binds a socket to an ephemeral loopback port and closes it without listening, so connects get refused.
private func unusedLoopbackPort() throws -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
    defer { close(fd) }
    var address = loopbackAddress()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bound = withUnsafeMutablePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) == 0 && getsockname(fd, $0, &length) == 0 }
    }
    guard fd >= 0, bound else { throw LoopbackPostError.system(call: "bind", code: errno) }
    return Int(UInt16(bigEndian: address.sin_port))
}

/// Accepts one connection on 127.0.0.1, records the request head, then answers with `reply`, or with
/// nothing (a stalled fixture) until the client gives up.
private final class LoopbackListener {
    private final class Received { var head = "" }
    let port: Int
    private let fd: Int32
    private let arrived = DispatchSemaphore(value: 0)
    private let received = Received()

    init(reply: String?) throws {
        let listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        var address = loopbackAddress()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let listening = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, length) == 0 && getsockname(listener, $0, &length) == 0 }
        } && listen(listener, 1) == 0
        guard listener >= 0, listening else {
            let code = errno
            close(listener)
            throw LoopbackPostError.system(call: "listen", code: code)
        }
        fd = listener
        port = Int(UInt16(bigEndian: address.sin_port))
        let arrived = self.arrived, received = self.received
        DispatchQueue.global().async {
            let connection = accept(listener, nil, nil)
            guard connection >= 0 else { return }
            defer { close(connection) }
            var head = [UInt8]()
            var chunk = [UInt8](repeating: 0, count: 512)
            while head.firstRange(of: Array("\r\n\r\n".utf8)) == nil {
                let count = chunk.withUnsafeMutableBytes { read(connection, $0.baseAddress!, $0.count) }
                guard count > 0 else { break }
                head += chunk[..<count]
            }
            received.head = String(decoding: head, as: UTF8.self)
            arrived.signal()
            if let reply {
                _ = Array(reply.utf8).withUnsafeBytes { write(connection, $0.baseAddress!, $0.count) }
            } else {
                while chunk.withUnsafeMutableBytes({ read(connection, $0.baseAddress!, $0.count) }) > 0 {}
            }
        }
    }

    func request(within seconds: TimeInterval) -> String? {
        arrived.wait(timeout: .now() + seconds) == .success ? received.head : nil
    }

    deinit { close(fd) }
}
