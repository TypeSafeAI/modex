import XCTest

// These helpers poll in plain loops rather than `XCTWaiter.wait(for: [XCTNSPredicateExpectation(...)])`,
// and that is the point of them. XCTest answers `hittable` by fetching the element's frame from the
// app, and each fetch is an XCTWaiter wait of its own. When an enclosing predicate wait reaches its
// timeout it interrupts those nested waits: the fetch comes back with no frame, and `hittable` records
// "Failed to determine hittability … Activation point invalid" as a failure of the test instead of a
// timeout. On a loaded CI simulator one evaluation can outlast the whole budget (CI run 37927792976:
// accessibility snapshots took 2–3 s each, one evaluation took 10 s, and the demo test failed on a
// button that was on screen at (201, 354)). A plain loop lets every evaluation run to completion, and
// it reads the frame, which never records a failure, before it asks whether the element is hittable.

/// How much slower the simulator host is than the developer Mac the base budgets were tuned on.
///
/// Every wait in these tests is `UITestBudget.seconds(base)`. GitHub's shared `macos-latest` runners
/// take 5–30× longer than a developer Mac on each XCTest round trip, and that is the same on green
/// runs as on red ones: the Session logs of CI runs 38370101202, 38386816197 and 38215609174 (failed)
/// and 38386254082 (passed, same morning) all show idle waits of 15–28 s, app launches of 25–34 s,
/// SpringBoard interruption checks of 16–22 s per tap and accessibility snapshots of 5–9 s. A run
/// went red whenever one of those steps happened to cross a fixed 10, 20 or 30 s budget, so eight
/// failures in three days named eight different lines. CI sets `MODEX_UI_TIMEOUT_SCALE` (through
/// xcodebuild's `TEST_RUNNER_` prefix; see Scripts/test-e2e.sh). A green run is unchanged by a larger
/// scale: a budget only matters once it is exceeded.
enum UITestBudget {
    static let scale: Double = {
        let raw = ProcessInfo.processInfo.environment["MODEX_UI_TIMEOUT_SCALE"]
        let value = min(max(raw.flatMap(Double.init) ?? 1, 1), 10)
        // The runner's log (and so the uploaded Session log) shows which scale a run used.
        NSLog("UITestBudget: scale ×%@ (MODEX_UI_TIMEOUT_SCALE=%@)", value.formatted(), raw ?? "unset")
        return value
    }()

    static func seconds(_ base: TimeInterval) -> TimeInterval { base * scale }

    /// Appended to timeout failure messages so a report names the scale that was in effect.
    static var note: String { scale == 1 ? "" : " (budget scale ×\(scale.formatted()))" }
}

/// Polls `condition` until it holds or `timeout` passes. Every evaluation runs to completion.
@discardableResult
func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date(timeIntervalSinceNow: timeout)
    while true {
        if condition() { return true }
        if Date() >= deadline { return false }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2))
    }
}

/// Observes typed text and retains the terminal value used by the failure diagnostic.
func observeTypedText(_ text: String, timeout: TimeInterval,
                      readValue: () -> String?) -> (matches: Bool, value: String?) {
    var observed: String?
    let matches = waitUntil(timeout: timeout) {
        observed = readValue()
        return observed?.hasSuffix(text) == true
    }
    if matches { return (true, observed) }
    observed = readValue()
    return (observed?.hasSuffix(text) == true, observed)
}

/// Answers a prompt SpringBoard has put over the app, if there is one: Allow for a permission, else the
/// first button that only closes it. Returns whether a prompt was answered.
///
/// A loaded simulator can raise one long after the step that caused it (CI run 37755334306 saw one
/// 2 minutes into the paired flow), and while it is up the app's scene is inactive, so the app stops
/// polling its Mac and the state the test waits for never arrives. XCTest only consults interruption
/// monitors before it synthesizes an event, so waits have to look for themselves.
@discardableResult
func answerSystemAlert() -> Bool {
    let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
    guard alert.exists else { return false }
    for label in ["Allow", "OK", "Not Now", "Done", "Close"] where alert.buttons[label].exists {
        alert.buttons[label].tap()
        return true
    }
    return false
}

extension XCTestCase {
    /// Lets system prompts that arrive during a tap or keystroke be answered instead of failing it.
    /// Remove the returned token in a `defer`.
    func answerSystemAlertsDuringActions() -> NSObjectProtocol {
        addUIInterruptionMonitor(withDescription: "System prompt") { alert in
            for label in ["Allow", "OK", "Not Now", "Done", "Close"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
    }

    /// Attaches a screenshot as evidence, best effort. XCTest gives the screenshot request a fixed
    /// 30 s, and on a loaded simulator that expires: CI run 38370101202 failed the demo test this way
    /// after every one of its assertions had passed (Session log: "Creating future for 'requesting
    /// screenshot' with timeout 30.00" … "reporting timed out failure"). An attachment is not a product
    /// assertion, so a missed one is recorded as an expected failure and the test goes on.
    func attachScreenshot(of app: XCUIApplication, named name: String) {
        var screenshot: XCUIScreenshot?
        XCTExpectFailure("Screenshot capture is best-effort on a loaded simulator", options: .nonStrict()) {
            screenshot = app.screenshot()
        }
        guard let screenshot, screenshot.image.size.width > 0 else { return }
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

extension XCUIApplication {
    /// Restrict both the type and identifier. A broad Any/identifiers lookup walks
    /// keyboard keys after sheet dismissal; Xcode's placeholder fallback can crash
    /// XCTAutomationSupport with "snapshot has no data source" (CI 38150693945).
    func inputField(_ identifier: String) -> XCUIElement {
        textFields.matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }
}

extension XCUIElement {
    /// Taps once the element is ready; see `waitUntilReady`.
    func tapWhenReady(timeout: TimeInterval = UITestBudget.seconds(30), file: StaticString = #filePath, line: UInt = #line) {
        guard waitUntilReady(timeout: timeout, file: file, line: line) else { return }
        tap()
    }

    /// Waits until the element exists, is enabled, has a finite non-empty frame that stayed put between
    /// two samples (its sheet, menu or navigation push has finished animating) and can take a tap.
    /// Takes at least three samples even on a simulator where one sample outlasts `timeout`. Records one
    /// failure and returns false when the deadline passes first.
    @discardableResult
    func waitUntilReady(timeout: TimeInterval = UITestBudget.seconds(30), file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        var previous: CGRect?
        var samples = 0
        repeat {
            samples += 1
            let frame = usableFrame
            if let frame, frame == previous, isHittable { return true }
            previous = frame
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2))
        } while Date() < deadline || samples < 3
        XCTFail("\(self) was not ready to tap within \(Int(timeout)) s\(UITestBudget.note); last frame \(previous.map { "\($0)" } ?? "none").", file: file, line: line)
        return false
    }

    /// Waits for the element to exist, answering any system prompt that appears meanwhile. For the
    /// long waits on the app's state (a reply from the Mac, a reconnect); `waitForExistence` cannot
    /// see a prompt, and the app cannot make progress under one.
    func appears(within timeout: TimeInterval) -> Bool {
        waitUntil(timeout: timeout) { exists || (answerSystemAlert() && exists) }
    }

    /// Whether the element can take a tap right now, without waiting. Reads the frame first, so an
    /// element that is still laying out or off screen answers false instead of failing the test.
    var isReadyToTap: Bool { usableFrame != nil && isHittable }

    /// Types into the field once it has keyboard focus, then waits until the field holds the text.
    ///
    /// A tap that lands while a sheet or the keyboard is still animating can miss, so the tap repeats
    /// until the field reports keyboard focus. Keystrokes also reach the simulator after `typeText`
    /// returns, so the caller's next tap must wait for the last one to arrive: CI run 37936899163 sent
    /// "Sh" and left "ip it" in the draft.
    func typeTextWhenReady(_ text: String, in app: XCUIApplication, timeout: TimeInterval = UITestBudget.seconds(30),
                           file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date(timeIntervalSinceNow: timeout)
        guard focusWhenReady(in: app, timeout: timeout, file: file, line: line) else { return }
        typeText(text)
        let observation = observeTypedText(text, timeout: max(1, deadline.timeIntervalSinceNow)) { value as? String }
        guard observation.matches else {
            XCTFail("The field did not finish receiving the typed text; it holds \(observation.value.map { "\"\($0)\"" } ?? "nothing").", file: file, line: line)
            return
        }
    }

    /// Waits for this field's keyboard focus before a caller sends keystrokes. Secure fields use
    /// the same focus boundary while keeping their masked-value and exact-delivery assertions.
    func focusWhenReady(in app: XCUIApplication, timeout: TimeInterval = UITestBudget.seconds(30),
                        file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        var taps = 0
        repeat {
            taps += 1
            guard waitUntilReady(timeout: max(1, deadline.timeIntervalSinceNow), file: file, line: line) else { return false }
            tap()
            if waitUntil(timeout: min(UITestBudget.seconds(8), max(1, deadline.timeIntervalSinceNow)), { hasKeyboardFocus(in: app) }) { return true }
            guard taps < 3, Date() < deadline else {
                XCTFail("\(self) did not take keyboard focus after \(taps) taps.", file: file, line: line)
                return false
            }
        } while true
    }

    /// The element's frame when it exists, is enabled and has a finite, non-empty frame; nil otherwise.
    /// One snapshot answers all three, and a snapshot that cannot be taken yet is simply "not yet".
    private var usableFrame: CGRect? {
        guard let snapshot = try? snapshot(), snapshot.isEnabled else { return nil }
        let frame = snapshot.frame
        guard !frame.isNull, !frame.isEmpty, !frame.isInfinite,
              frame.minX.isFinite, frame.minY.isFinite, frame.width.isFinite, frame.height.isFinite else { return nil }
        return frame
    }

    /// The field's own keyboard focus when XCTest exposes it (it does on iOS 17–26), else whether any
    /// keyboard is up, which on these single-field screens means the same thing.
    private func hasKeyboardFocus(in app: XCUIApplication) -> Bool {
        if responds(to: NSSelectorFromString("hasKeyboardFocus")), let focused = value(forKey: "hasKeyboardFocus") as? Bool {
            return focused
        }
        return app.keyboards.firstMatch.exists
    }
}
