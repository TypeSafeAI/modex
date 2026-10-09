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
}

extension XCUIElement {
    /// Taps once the element is ready; see `waitUntilReady`.
    func tapWhenReady(timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line) {
        guard waitUntilReady(timeout: timeout, file: file, line: line) else { return }
        tap()
    }

    /// Waits until the element exists, is enabled, has a finite non-empty frame that stayed put between
    /// two samples (its sheet, menu or navigation push has finished animating) and can take a tap.
    /// Takes at least three samples even on a simulator where one sample outlasts `timeout`. Records one
    /// failure and returns false when the deadline passes first.
    @discardableResult
    func waitUntilReady(timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line) -> Bool {
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
        XCTFail("\(self) was not ready to tap within \(Int(timeout)) s; last frame \(previous.map { "\($0)" } ?? "none").", file: file, line: line)
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
    func typeTextWhenReady(_ text: String, in app: XCUIApplication, timeout: TimeInterval = 30,
                           file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date(timeIntervalSinceNow: timeout)
        var taps = 0
        repeat {
            taps += 1
            guard waitUntilReady(timeout: max(1, deadline.timeIntervalSinceNow), file: file, line: line) else { return }
            tap()
            if waitUntil(timeout: min(8, max(1, deadline.timeIntervalSinceNow)), { hasKeyboardFocus(in: app) }) { break }
            guard taps < 3, Date() < deadline else {
                XCTFail("\(self) did not take keyboard focus after \(taps) taps.", file: file, line: line)
                return
            }
        } while true
        typeText(text)
        guard waitUntil(timeout: max(1, deadline.timeIntervalSinceNow), { (value as? String)?.hasSuffix(text) == true }) else {
            XCTFail("The field did not finish receiving the typed text; it holds \((value as? String).map { "\"\($0)\"" } ?? "nothing").", file: file, line: line)
            return
        }
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
