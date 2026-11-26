import Foundation

public struct NativeTrayDetectedClient: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let installed: Bool
    public let connected: Bool
    public let state: String

    public init(id: String, label: String, installed: Bool, connected: Bool, state: String) {
        self.id = id
        self.label = label
        self.installed = installed
        self.connected = connected
        self.state = state
    }
}

public enum NativeTrayLocalClientDetector {
    private static let maxInspectBytes = 256 * 1024

    public static func detect(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        snapshotClients: [NativeTrayDetectedClient]? = nil
    ) -> [NativeTrayDetectedClient] {
        if let snapshotClients {
            return snapshotClients
        }
        return [
            detectCodex(home: homeDirectory),
            detectAntigravity(home: homeDirectory),
            detectClaude(home: homeDirectory),
            detectCursor(home: homeDirectory),
        ]
    }

    private static func readBounded(_ url: URL) -> String? {
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return nil }
        guard let attrs = try? fm.attributesOfItem(atPath: url.path),
              let type = attrs[.type] as? FileAttributeType,
              type == .typeRegular,
              let size = attrs[.size] as? NSNumber,
              size.intValue <= maxInspectBytes,
              let handle = try? FileHandle(forReadingFrom: url) else {
            return nil
        }
        defer { try? handle.close() }
        let data = try? handle.read(upToCount: maxInspectBytes)
        return data.flatMap { String(data: $0, encoding: .utf8) }
    }

    private static func findLoopbackPorts(_ lower: String) -> [Int] {
        let prefixes = [
            "http://127.0.0.1:",
            "https://127.0.0.1:",
            "http://localhost:",
            "https://localhost:",
            "http://[::1]:",
            "https://[::1]:",
        ]
        var ports: [Int] = []
        for prefix in prefixes {
            var searchStart = lower.startIndex
            while let range = lower.range(of: prefix, range: searchStart..<lower.endIndex) {
                var cursor = range.upperBound
                var digits = ""
                while cursor < lower.endIndex, let scalar = lower[cursor].unicodeScalars.first, scalar.value >= 48 && scalar.value <= 57, digits.count < 6 {
                    digits.append(lower[cursor])
                    cursor = lower.index(after: cursor)
                }
                if !digits.isEmpty && digits.count <= 5, let port = Int(digits), (1...65535).contains(port) {
                    if cursor == lower.endIndex || "/?#\"' \t\r\n,}".contains(lower[cursor]) {
                        ports.append(port)
                    }
                }
                searchStart = range.upperBound
            }
        }
        return ports
    }

    private static func hasLoopbackPortURL(_ lower: String) -> Bool {
        !findLoopbackPorts(lower).isEmpty
    }

    private static func findLoopbackOriginPort(_ urlLower: String) -> Int? {
        let prefixes = [
            "http://127.0.0.1:",
            "https://127.0.0.1:",
            "http://localhost:",
            "https://localhost:",
            "http://[::1]:",
            "https://[::1]:",
        ]
        for prefix in prefixes where urlLower.hasPrefix(prefix) {
            var cursor = urlLower.index(urlLower.startIndex, offsetBy: prefix.count)
            var digits = ""
            while cursor < urlLower.endIndex,
                  let scalar = urlLower[cursor].unicodeScalars.first,
                  scalar.value >= 48 && scalar.value <= 57,
                  digits.count < 6 {
                digits.append(urlLower[cursor])
                cursor = urlLower.index(after: cursor)
            }
            if !digits.isEmpty && digits.count <= 5, let port = Int(digits), (1...65535).contains(port) {
                if cursor == urlLower.endIndex || "/?#".contains(urlLower[cursor]) {
                    return port
                }
            }
        }
        return nil
    }

    private static func stripJSONC(_ text: String) -> String? {
        var scalars = Array(text.unicodeScalars)
        if scalars.first?.value == 0xFEFF {
            scalars.removeFirst()
        }
        var noComments: [UnicodeScalar] = []
        noComments.reserveCapacity(scalars.count)
        var inString = false
        var escaped = false
        var inLine = false
        var inBlock = false
        var i = 0
        while i < scalars.count {
            let ch = scalars[i]
            let next: UnicodeScalar? = (i + 1 < scalars.count) ? scalars[i + 1] : nil
            if inLine {
                if ch == "\n" || ch == "\r" {
                    inLine = false
                    noComments.append(ch)
                }
                i += 1
                continue
            }
            if inBlock {
                if ch == "\n" {
                    noComments.append(ch)
                } else if ch == "*", next == "/" {
                    noComments.append(" ")
                    inBlock = false
                    i += 1
                }
                i += 1
                continue
            }
            if inString {
                noComments.append(ch)
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == "\"" {
                    inString = false
                }
                i += 1
                continue
            }
            if ch == "\"" {
                inString = true
                noComments.append(ch)
            } else if ch == "/", next == "/" {
                inLine = true
                i += 1
            } else if ch == "/", next == "*" {
                inBlock = true
                i += 1
            } else {
                noComments.append(ch)
            }
            i += 1
        }
        if inBlock { return nil }

        var out: [UnicodeScalar] = []
        out.reserveCapacity(noComments.count)
        inString = false
        escaped = false
        for idx in noComments.indices {
            let ch = noComments[idx]
            if inString {
                out.append(ch)
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == "\"" {
                    inString = false
                }
                continue
            }
            if ch == "\"" {
                inString = true
                out.append(ch)
                continue
            }
            if ch == "," {
                var j = idx + 1
                while j < noComments.count && CharacterSet.whitespacesAndNewlines.contains(noComments[j]) {
                    j += 1
                }
                if j < noComments.count && (noComments[j] == "}" || noComments[j] == "]") {
                    if let prev = out.last(where: { !CharacterSet.whitespacesAndNewlines.contains($0) }),
                       prev != "{" && prev != "[" {
                        continue
                    }
                }
            }
            out.append(ch)
        }
        return String(String.UnicodeScalarView(out))
    }

    private static func hasEasyProxyKeyPrefix(_ lower: String) -> Bool {
        lower.contains("epx_data_")
            || lower.contains("epx_admin_")
            || lower.contains("epxrw_")
    }

    private static func hasEasyProxyMarker(_ content: String) -> Bool {
        let lower = content.lowercased()
        if lower.contains("easyproxy")
            || lower.contains("127.0.0.1:10100")
            || lower.contains("localhost:10100")
            || lower.contains("[::1]:10100")
        {
            return true
        }
        return hasLoopbackPortURL(lower)
            && (hasEasyProxyKeyPrefix(lower)
                || lower.contains("claude_code_enable_gateway_model_discovery"))
    }

    private static func hasCodexEasyProxyMarker(_ content: String) -> Bool {
        let lower = content.lowercased()
        if lower.contains("easyproxy-managed") {
            return true
        }
        for rawLine in content.split(whereSeparator: \.isNewline) {
            let line = rawLine.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = line[..<eq].trimmingCharacters(in: .whitespacesAndNewlines)
            guard key == "model_provider" else { continue }
            let val = line[line.index(after: eq)...]
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            if val.lowercased() == "easyproxy" {
                return true
            }
        }
        return false
    }

    private static func detectCodex(home: URL) -> NativeTrayDetectedClient {
        let dir = home.appendingPathComponent(".codex", isDirectory: true)
        var installed = FileManager.default.fileExists(atPath: dir.path)
        var connected = false
        if let text = readBounded(dir.appendingPathComponent("config.toml")) {
            installed = true
            if hasCodexEasyProxyMarker(text) {
                connected = true
            }
        }
        return makeClient(id: "codex", label: "Codex", installed: installed, connected: connected)
    }

    private static func isEasyProxyAntigravityGateway(_ content: String) -> Bool {
        guard let clean = stripJSONC(content),
              let data = clean.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let gateway = root["gateway"] as? [String: Any] else {
            return false
        }
        if (gateway["enabled"] as? Bool) == false {
            return false
        }
        guard let url = gateway["url"] as? String else {
            return false
        }
        let urlLower = url.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let port = findLoopbackOriginPort(urlLower) else {
            return false
        }
        if port == 10100 || urlLower.contains("easyproxy") {
            return true
        }
        let keyLower = (gateway["apiKey"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        return keyLower.contains("easyproxy") || hasEasyProxyKeyPrefix(keyLower)
    }

    private static func detectAntigravity(home: URL) -> NativeTrayDetectedClient {
        let dir = home.appendingPathComponent(".antigravity", isDirectory: true)
        var installed = FileManager.default.fileExists(atPath: dir.path)
        var connected = false
        if let text = readBounded(dir.appendingPathComponent("settings.json")) {
            installed = true
            if isEasyProxyAntigravityGateway(text) {
                connected = true
            }
        }
        return makeClient(id: "antigravity", label: "Antigravity", installed: installed, connected: connected)
    }

    private static func detectClaude(home: URL) -> NativeTrayDetectedClient {
        let claudeDir = home.appendingPathComponent(".claude", isDirectory: true)
        var installed = FileManager.default.fileExists(atPath: claudeDir.path)
        var connected = false
        let candidates = [
            claudeDir.appendingPathComponent("settings.json"),
            home.appendingPathComponent(".claude.json"),
            home.appendingPathComponent("Library/Application Support/Claude/claude_desktop_config.json"),
        ]
        for url in candidates {
            if let text = readBounded(url) {
                installed = true
                if hasEasyProxyMarker(text), text.contains("ANTHROPIC_BASE_URL") {
                    connected = true
                }
            }
        }
        return makeClient(id: "claude", label: "Claude", installed: installed, connected: connected)
    }

    private static let cursorProxyUrlKeys: Set<String> = [
        "overrideopenaibaseurl",
        "openaibaseurl",
        "cursor.openaibaseurl",
        "openai.baseurl",
        "cursor.customopenaiurl",
        "baseurl",
        "base_url",
        "apibase",
        "apibaseurl",
        "openai_base_url",
        "anthropic_base_url",
        "proxyurl",
        "url",
    ]

    private static let cursorCredentialKeys: Set<String> = [
        "apikey",
        "api_key",
        "openaiapikey",
        "openai.apikey",
        "cursor.openaiapikey",
        "token",
        "authtoken",
        "anthropic_auth_token",
        "openai_api_key",
        "authorization",
        "x-api-key",
    ]

    private static func inspectCursorJSON(
        _ value: Any,
        keyHint: String?,
        sawDefaultProxyURL: inout Bool,
        sawLoopbackProxyURL: inout Bool,
        sawEasyProxyCredential: inout Bool
    ) {
        if let dict = value as? [String: Any] {
            for (k, v) in dict {
                inspectCursorJSON(
                    v,
                    keyHint: k,
                    sawDefaultProxyURL: &sawDefaultProxyURL,
                    sawLoopbackProxyURL: &sawLoopbackProxyURL,
                    sawEasyProxyCredential: &sawEasyProxyCredential
                )
            }
        } else if let list = value as? [Any] {
            for item in list {
                inspectCursorJSON(
                    item,
                    keyHint: keyHint,
                    sawDefaultProxyURL: &sawDefaultProxyURL,
                    sawLoopbackProxyURL: &sawLoopbackProxyURL,
                    sawEasyProxyCredential: &sawEasyProxyCredential
                )
            }
        } else if let str = value as? String, let key = keyHint {
            let keyLower = key.lowercased()
            let valLower = str.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if cursorProxyUrlKeys.contains(keyLower) {
                if let port = findLoopbackOriginPort(valLower) {
                    sawLoopbackProxyURL = true
                    if port == 10100 || valLower.contains("easyproxy") {
                        sawDefaultProxyURL = true
                    }
                }
            } else if cursorCredentialKeys.contains(keyLower) {
                if hasEasyProxyKeyPrefix(valLower)
                    || valLower == "easyproxy-local"
                    || valLower == "bearer easyproxy-local"
                    || valLower == "easyproxy-loopback"
                    || valLower.hasPrefix("bearer easyproxy-loopback")
                    || valLower == "easyproxy" {
                    sawEasyProxyCredential = true
                }
            }
        }
    }

    private static func isEasyProxyCursorConfig(_ content: String) -> Bool {
        guard let clean = stripJSONC(content),
              let data = clean.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) else {
            return false
        }
        if let root = parsed as? [String: Any] {
            if (root["overrideOpenAiBaseUrl"] as? Bool) == false
                || (root["cursor.overrideOpenAiBaseUrl"] as? Bool) == false {
                return false
            }
        }
        var sawDefaultProxyURL = false
        var sawLoopbackProxyURL = false
        var sawEasyProxyCredential = false
        inspectCursorJSON(
            parsed,
            keyHint: nil,
            sawDefaultProxyURL: &sawDefaultProxyURL,
            sawLoopbackProxyURL: &sawLoopbackProxyURL,
            sawEasyProxyCredential: &sawEasyProxyCredential
        )
        return sawDefaultProxyURL || (sawLoopbackProxyURL && sawEasyProxyCredential)
    }

    private static func detectCursor(home: URL) -> NativeTrayDetectedClient {
        let cursorDir = home.appendingPathComponent(".cursor", isDirectory: true)
        var installed = FileManager.default.fileExists(atPath: cursorDir.path)
        var connected = false
        let candidates = [
            cursorDir.appendingPathComponent("mcp.json"),
            cursorDir.appendingPathComponent("cli-config.json"),
            home.appendingPathComponent("Library/Application Support/Cursor/User/settings.json"),
        ]
        for url in candidates {
            if let text = readBounded(url) {
                installed = true
                if isEasyProxyCursorConfig(text) {
                    connected = true
                }
            }
        }
        return makeClient(id: "cursor", label: "Cursor", installed: installed, connected: connected)
    }

    private static func makeClient(id: String, label: String, installed: Bool, connected: Bool) -> NativeTrayDetectedClient {
        let state = connected ? "connected" : (installed ? "detected" : "notDetected")
        return NativeTrayDetectedClient(id: id, label: label, installed: installed, connected: connected, state: state)
    }
}
