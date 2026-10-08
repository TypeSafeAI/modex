import XCTest

extension XCUIElement {
    /// A tappable field may still be waiting for its sheet or keyboard to finish presenting.
    /// `typeText` then verifies that this field, rather than another input, has keyboard focus.
    func typeTextWhenReady(_ text: String, in app: XCUIApplication, timeout: TimeInterval = 10,
                           file: StaticString = #filePath, line: UInt = #line) {
        tapWhenReady(timeout: timeout, file: file, line: line)
        guard app.keyboards.firstMatch.waitForExistence(timeout: timeout) else {
            XCTFail("The keyboard did not appear after tapping \(self).", file: file, line: line)
            return
        }
        typeText(text)
    }

    /// Taps once the element exists, is enabled and can receive the tap.
    ///
    /// Menus, sheets, alerts and navigation pushes animate in. Until the animation settles an
    /// element can exist without a hit point, and a plain `tap()` then fails ("Activation point
    /// invalid") or lands on the outgoing screen. On a loaded CI simulator that window is
    /// long enough to make the paired and demo flows fail intermittently.
    func tapWhenReady(timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
        let ready = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND enabled == true AND hittable == true"),
            object: self
        )
        let result = XCTWaiter.wait(for: [ready], timeout: timeout)
        XCTAssertEqual(result, .completed, "\(self) was not ready to tap within \(Int(timeout)) s.", file: file, line: line)
        tap()
    }
}
