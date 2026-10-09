import CryptoKit
import Foundation
import Security

struct Pairing: Codable, Equatable {
    let url: URL
    let token: String
    let fingerprint: String

    static func from(link: String) throws -> Pairing {
        guard let components = URLComponents(string: link.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme == "modex", components.host == "pair",
              let encoded = components.queryItems?.first(where: { $0.name == "data" })?.value else {
            throw CompanionError.message("Scan the pairing code shown on your Mac.")
        }
        let padded = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            .padding(toLength: ((encoded.count + 3) / 4) * 4, withPad: "=", startingAt: 0)
        guard let data = Data(base64Encoded: padded), let pairing = try? JSONDecoder().decode(Pairing.self, from: data),
              validEndpoint(pairing.url),
              pairing.token.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              pairing.fingerprint.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw CompanionError.message("This pairing code is invalid or does not point to a local Mac.")
        }
        return pairing
    }

    static func validEndpoint(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host, privateIPv4(host),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return false }
        return url.port.map { (1...65535).contains($0) } ?? true
    }
}

private func privateIPv4(_ address: String) -> Bool {
    let octets = address.split(separator: ".", omittingEmptySubsequences: false)
    guard octets.count == 4, octets.allSatisfy({ !$0.isEmpty && $0.utf8.allSatisfy { (48...57).contains($0) } }) else { return false }
    let parts = octets.compactMap { UInt8($0) }
    guard parts.count == 4 else { return false }
    return parts[0] == 10 || (parts[0] == 192 && parts[1] == 168)
        || (parts[0] == 172 && (16...31).contains(parts[1])) || address == "127.0.0.1"
}

enum CompanionError: LocalizedError {
    case message(String)
    case accessRevoked
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        case .accessRevoked: return "Access was removed on your Mac. Pair again with a new code from Modex."
        }
    }
}

struct CompanionProject: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
}

struct CompanionThread: Decodable, Identifiable, Equatable {
    let id: String
    let projectId: String
    let title: String
    let backend: String
    let status: String
    let updatedAt: String
    /// "ask", "always" or "yolo": the thread's standing answer to approvals on the Mac.
    var approvals: String? = nil
    var worktree: Bool? = nil
    /// The PR last seen for a worktree task; the Mac sends its number and state only.
    var pr: PullRequestBadge? = nil
    /// Set once the Mac finished the task after its PR merged.
    var retiredPr: Int? = nil

    struct PullRequestBadge: Decodable, Equatable {
        let number: Int
        let state: String
    }

    var approvalPolicy: String { approvals ?? "ask" }
}

struct CompanionItem: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String
    let text: String?
    let title: String?
    let question: String?
    let detail: String?
    let answer: String?
    let status: String?
    let level: String?
    let at: String
    /// For an approval the Mac answered itself: "rule", "always" or "yolo".
    var auto: String? = nil
}

struct CompanionSnapshot: Decodable, Equatable {
    let projects: [CompanionProject]
    let threads: [CompanionThread]
    let items: [CompanionItem]
    let defaultBackend: String
    let autoByDefault: Bool

    init(projects: [CompanionProject], threads: [CompanionThread], items: [CompanionItem], defaultBackend: String = "codex", autoByDefault: Bool = false) {
        self.projects = projects
        self.threads = threads
        self.items = items
        self.defaultBackend = defaultBackend
        self.autoByDefault = autoByDefault
    }

    private enum CodingKeys: String, CodingKey { case projects, threads, items, defaultBackend, autoByDefault }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        projects = try values.decode([CompanionProject].self, forKey: .projects)
        threads = try values.decode([CompanionThread].self, forKey: .threads)
        items = try values.decode([CompanionItem].self, forKey: .items)
        defaultBackend = try values.decodeIfPresent(String.self, forKey: .defaultBackend) ?? "codex"
        autoByDefault = try values.decodeIfPresent(Bool.self, forKey: .autoByDefault) ?? false
    }
}

struct CompanionCommand: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let detail: String
    let insertion: String
    let kind: String
}

protocol CompanionClient {
    func snapshot(threadId: String?) async throws -> CompanionSnapshot
    func createThread(projectId: String, text: String, worktree: Bool, provider: String) async throws -> CompanionThread
    func commands(projectId: String, backend: String) async throws -> [CompanionCommand]
    func send(threadId: String, text: String) async throws
    func answer(threadId: String, itemId: String, approve: Bool) async throws
    /// Sets the thread's standing answer to approvals: "ask", "always" or "yolo".
    func setApprovals(threadId: String, policy: String) async throws
    func invalidate()
}

extension CompanionClient {
    func invalidate() {}
    func setApprovals(threadId: String, policy: String) async throws {
        throw CompanionError.message("This Mac does not support approval settings. Update Modex on your Mac.")
    }
}

final class CompanionAPI: NSObject, URLSessionDelegate, URLSessionTaskDelegate, CompanionClient {
    let pairing: Pairing
    private var session: URLSession!

    init(pairing: Pairing) {
        self.pairing = pairing
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 75
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func invalidate() { session.invalidateAndCancel() }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Discovery must never redirect a saved bearer credential to another endpoint.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let certificate = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let fingerprint = SHA256.hash(data: SecCertificateCopyData(certificate) as Data)
            .map { String(format: "%02x", $0) }.joined()
        if fingerprint == pairing.fingerprint {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func snapshot(threadId: String? = nil) async throws -> CompanionSnapshot {
        var components = URLComponents(url: pairing.url.appending(path: "v1/snapshot"), resolvingAgainstBaseURL: false)!
        if let threadId { components.queryItems = [URLQueryItem(name: "threadId", value: threadId)] }
        return try await request(components.url!, method: "GET", body: nil)
    }

    func createThread(projectId: String, text: String, worktree: Bool, provider: String) async throws -> CompanionThread {
        let url = pairing.url.appending(path: "v1/threads")
        var body: [String: Any] = ["projectId": projectId, "text": text, "worktree": worktree, "auto": provider == "auto"]
        if provider != "auto" { body["backend"] = provider }
        let result: CreatedThread = try await request(url, method: "POST", body: body, timeout: 60)
        return result.thread
    }

    func commands(projectId: String, backend: String) async throws -> [CompanionCommand] {
        var components = URLComponents(url: pairing.url.appending(path: "v1/commands"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "projectId", value: projectId), URLQueryItem(name: "backend", value: backend)]
        let result: CommandList = try await request(components.url!, method: "GET", body: nil)
        return result.commands
    }

    func send(threadId: String, text: String) async throws {
        let url = pairing.url.appending(path: "v1/threads/\(threadId)/send")
        let _: OK = try await request(url, method: "POST", body: ["text": text])
    }

    func answer(threadId: String, itemId: String, approve: Bool) async throws {
        let url = pairing.url.appending(path: "v1/threads/\(threadId)/answer")
        let _: OK = try await request(url, method: "POST", body: ["itemId": itemId, "answer": approve ? "yes" : "no"])
    }

    func setApprovals(threadId: String, policy: String) async throws {
        let url = pairing.url.appending(path: "v1/threads/\(threadId)/policy")
        let _: OK = try await request(url, method: "POST", body: ["policy": policy])
    }

    private struct OK: Decodable { let ok: Bool }
    private struct CreatedThread: Decodable { let thread: CompanionThread }
    private struct CommandList: Decodable { let commands: [CompanionCommand] }
    private struct Failure: Decodable { let error: String }

    private func request<T: Decodable>(_ url: URL, method: String, body: [String: Any]?, timeout: TimeInterval = 8) async throws -> T {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.httpMethod = method
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw CompanionError.message("No response from your Mac.") }
        if response.statusCode == 401 || response.statusCode == 403 { throw CompanionError.accessRevoked }
        guard (200..<300).contains(response.statusCode) else {
            let detail = try? JSONDecoder().decode(Failure.self, from: data)
            throw CompanionError.message(detail?.error ?? "Your Mac returned an error (\(response.statusCode)).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

protocol PairingStorage {
    func load() -> Pairing?
    func save(_ pairing: Pairing) throws
    func clear()
}

struct PairingStore: PairingStorage {
    private let service = "works.jev.modex.pairing"

    func load() -> Pairing? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                     kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        #if targetEnvironment(simulator)
        if status == errSecMissingEntitlement, let data = UserDefaults.standard.data(forKey: service) {
            return try? JSONDecoder().decode(Pairing.self, from: data)
        }
        #endif
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    func save(_ pairing: Pairing) throws {
        let data = try JSONEncoder().encode(pairing)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        let attributes: [String: Any] = [kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, kSecValueData as String: data]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        #if targetEnvironment(simulator)
        if status == errSecMissingEntitlement {
            UserDefaults.standard.set(data, forKey: service)
            return
        }
        #endif
        guard status == errSecSuccess else {
            throw CompanionError.message("Could not save this Mac in the iPhone keychain (\(status)).")
        }
    }

    func clear() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(query as CFDictionary)
        #if targetEnvironment(simulator)
        UserDefaults.standard.removeObject(forKey: service)
        #endif
    }
}
