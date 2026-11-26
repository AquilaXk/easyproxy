import Foundation

public struct NativeTrayDetectedClient: Decodable, Identifiable, Equatable {
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

    private static func hasLoopbackPortURL(_ lower: String) -> Bool {
        let prefixes = [
            "http://127.0.0.1:",
            "https://127.0.0.1:",
            "http://localhost:",
            "https://localhost:",
            "http://[::1]:",
            "https://[::1]:",
        ]
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
                    if cursor == lower.endIndex {
                        return true
                    }
                    let ch = lower[cursor]
                    if "/?#\"' \t\r\n,}".contains(ch) {
                        return true
                    }
                }
                searchStart = range.upperBound
            }
        }
        return false
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

    private static func detectAntigravity(home: URL) -> NativeTrayDetectedClient {
        let dir = home.appendingPathComponent(".antigravity", isDirectory: true)
        var installed = FileManager.default.fileExists(atPath: dir.path)
        var connected = false
        if let text = readBounded(dir.appendingPathComponent("settings.json")) {
            installed = true
            if hasEasyProxyMarker(text), text.contains("gateway") {
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
                let lower = text.lowercased()
                if hasEasyProxyMarker(text),
                   (text.contains("overrideOpenAiBaseUrl")
                    || lower.contains("easyproxy-loopback")
                    || lower.contains("easyproxy")
                    || hasEasyProxyKeyPrefix(lower)) {
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
