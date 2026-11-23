import Foundation
import MenuBarCore

public enum ReadFailure: String, Error, Equatable, Sendable {
    case missing
    case corrupt
}

public struct SnapshotReader: Sendable {
    private static let appGroupPattern = "^[A-Z0-9]{10}\\.com\\.easyproxy\\.desktop$"

    public init() {}

    public static func snapshotURL(
        appGroupIdentifier: String? = Bundle.main.object(forInfoDictionaryKey: "EasyProxyAppGroup") as? String,
        groupContainerURL: (String) -> URL? = { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) },
        applicationSupportDirectory: () -> URL = { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0] }
    ) -> URL {
        if let raw = appGroupIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
           !raw.isEmpty,
           raw.range(of: appGroupPattern, options: .regularExpression) != nil,
           let groupURL = groupContainerURL(raw) {
            return groupURL.appendingPathComponent("Library/Application Support/EasyProxy/snapshot.json")
        }
        return applicationSupportDirectory().appendingPathComponent("EasyProxy/snapshot.json")
    }

    public func read() -> Result<WidgetSnapshot, ReadFailure> {
        let url = Self.snapshotURL()
        guard let data = try? Data(contentsOf: url) else { return .failure(.missing) }
        guard let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data) else {
            return .failure(.corrupt)
        }
        return .success(snapshot)
    }

    public func isStale(_ snapshot: WidgetSnapshot, now: Date = Date()) -> Bool {
        snapshot.isStale(now: now)
    }
}
