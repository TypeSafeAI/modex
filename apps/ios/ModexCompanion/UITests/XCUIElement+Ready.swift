import XCTest

extension XCUIElement {
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
