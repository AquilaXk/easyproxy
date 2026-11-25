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
        if let snapshotClients, !snapshotClients.isEmpty {
            return snapshotClients
        }
        return [
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

    private static func looksEasyProxyRouted(_ content: String) -> Bool {
        let lower = content.lowercased()
        return lower.contains("127.0.0.1")
            || lower.contains("localhost:")
            || lower.contains("easyproxy")
            || lower.contains("easyproxy-managed")
    }

    private static func detectAntigravity(home: URL) -> NativeTrayDetectedClient {
        let dir = home.appendingPathComponent(".antigravity", isDirectory: true)
        var installed = FileManager.default.fileExists(atPath: dir.path)
        var connected = false
        if let text = readBounded(dir.appendingPathComponent("settings.json")) {
            installed = true
            if looksEasyProxyRouted(text), text.contains("gateway") {
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
                if looksEasyProxyRouted(text), (text.contains("ANTHROPIC_BASE_URL") || text.contains("anthropic")) {
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
                if looksEasyProxyRouted(text),
                   (text.contains("openai") || text.contains("overrideOpenAiBaseUrl") || text.contains("/v1")) {
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
