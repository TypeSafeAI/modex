import Darwin
import Foundation

/// Why a POST to the Mac fixture's loopback control endpoint did not return a status.
enum LoopbackPostError: Error, Equatable, CustomStringConvertible {
    case invalidURL(String)
    case system(call: String, code: Int32)
    /// The deadline passed during `phase`: "connect", "send" or "reply".
    case timedOut(phase: String)
    case malformedReply(String)

    var description: String {
        switch self {
        case .invalidURL(let url): return "\(url) is not an http://<IPv4>:<port>/ URL"
        case .system(let call, let code): return "\(call) failed: \(String(cString: strerror(code)))"
        case .timedOut(let phase): return "timed out waiting to \(phase)"
        case .malformedReply(let line): return "unexpected reply \"\(line)\""
        }
    }
}

/// POSTs an empty body to an `http://<IPv4>:<port>/path` URL over a plain BSD socket and returns the
/// reply's HTTP status. Everything (connect, send, status line) shares one deadline.
///
/// The UI-test runner makes no other request, so URLSession's first use in that process came at the
/// paused-Mac step, minutes into a freshly booted CI simulator. Its lazy setup (preferences through
/// cfprefsd, the cookie and cache store in nsurlsessiond's container, trustd) blocked the runner's main
/// thread for 22 s and then the task for 20 s in CI run 38747016392, so the resume never left the
/// runner and the Mac stayed paused; in 38707861067 it left 19 s late. Green runs spent 0.1 s on it.
/// A socket to the fixture on 127.0.0.1 needs none of those simulator daemons.
func postToLoopback(_ url: URL, timeout: TimeInterval) throws -> Int {
    guard url.scheme == "http", let host = url.host, let port = url.port, (1...65_535).contains(port),
          let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath, path.hasPrefix("/") else {
        throw LoopbackPostError.invalidURL(url.absoluteString)
    }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(port)).bigEndian
    guard inet_pton(AF_INET, host, &address.sin_addr) == 1 else { throw LoopbackPostError.invalidURL(url.absoluteString) }

    let deadline = Date(timeIntervalSinceNow: timeout)
    let fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
    guard fd >= 0 else { throw LoopbackPostError.system(call: "socket", code: errno) }
    defer { close(fd) }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    guard fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) == 0 else { throw LoopbackPostError.system(call: "fcntl", code: errno) }

    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    if connected != 0 {
        guard errno == EINPROGRESS else { throw LoopbackPostError.system(call: "connect", code: errno) }
        try waitForSocket(fd, events: POLLOUT, until: deadline, phase: "connect")
        var failure: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &failure, &length)
        guard failure == 0 else { throw LoopbackPostError.system(call: "connect", code: failure) }
    }

    let request = Array("POST \(path) HTTP/1.1\r\nHost: \(host):\(port)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)
    var sent = 0
    while sent < request.count {
        let written = request.withUnsafeBytes { write(fd, $0.baseAddress! + sent, request.count - sent) }
        if written > 0 { sent += written; continue }
        guard written < 0, errno == EAGAIN || errno == EINTR else { throw LoopbackPostError.system(call: "write", code: errno) }
        try waitForSocket(fd, events: POLLOUT, until: deadline, phase: "send")
    }

    var reply = [UInt8]()
    var chunk = [UInt8](repeating: 0, count: 512)
    while reply.firstRange(of: [13, 10]) == nil {
        let count = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress!, $0.count) }
        if count > 0 { reply += chunk[..<count]; continue }
        if count == 0 { break }
        guard errno == EAGAIN || errno == EINTR else { throw LoopbackPostError.system(call: "read", code: errno) }
        try waitForSocket(fd, events: POLLIN, until: deadline, phase: "reply")
    }
    let statusLine = String(decoding: reply.prefix { $0 != 13 }, as: UTF8.self)
    let parts = statusLine.split(separator: " ")
    guard parts.count >= 2, parts[0].hasPrefix("HTTP/1."), let status = Int(parts[1]) else {
        throw LoopbackPostError.malformedReply(statusLine)
    }
    return status
}

private func waitForSocket(_ fd: Int32, events: Int32, until deadline: Date, phase: String) throws {
    while true {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw LoopbackPostError.timedOut(phase: phase) }
        var descriptor = pollfd(fd: fd, events: Int16(events), revents: 0)
        let ready = poll(&descriptor, 1, Int32((remaining * 1000).rounded(.up)))
        if ready > 0 { return }
        if ready < 0, errno != EINTR { throw LoopbackPostError.system(call: "poll", code: errno) }
    }
}
