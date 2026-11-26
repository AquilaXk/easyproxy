import Foundation
import NativeTray

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    assertions += 1
    if !condition() { fatalError(message) }
}

let settings: [String: Any] = [
    "showToday": true, "show30Days": true, "showChart": true,
    "showModels": true, "showAccounts": true, "showCost": true, "chartStyle": "line",
]
func decode(_ changes: [String: Any] = [:]) throws -> NativeTraySnapshot {
    var value: [String: Any] = [
        "schemaVersion": 1, "refreshing": false, "errors": [], "settings": settings,
        "models": [], "providers": [],
    ]
    value.merge(changes) { _, new in new }
    return try NativeTraySnapshot.decode(JSONSerialization.data(withJSONObject: value))
}

let empty = try decode()
check(empty.today == nil && empty.month == nil, "Missing totals must remain unknown")
check(NativeTrayFormat.tokens(nil) == "—", "Missing must not render zero")
check(NativeTrayFormat.tokens(0) == "0", "Measured zero must render zero")
check(NativeTrayFormat.tokens(10_000_000) == "10M", "Whole-number trailing zeros must survive")
check(NativeTrayFormat.number(-1) == nil, "Negative measurements rejected")
check(NativeTrayFormat.number(.infinity) == nil, "Infinite measurements rejected")
check(NativeTrayFormat.number(.nan) == nil, "NaN measurements rejected")

let unmeasured = try decode(["today": [
    "requests": 3, "measuredRequests": 0, "pricedRequests": 0,
    "totalTokens": 0, "inputTokens": 0, "outputTokens": 0, "estimatedCostUsd": 0,
]])
check(unmeasured.today?.tokens == nil, "Unmeasured nonempty requests are not zero tokens")
check(unmeasured.today?.input == nil && unmeasured.today?.output == nil, "Unmeasured input/output stay unknown")
check(unmeasured.today?.cost == nil, "Unpriced nonempty requests are not free")
check(unmeasured.today?.coverage == 0, "Coverage remains an honest zero")
check(unmeasured.today?.costIncomplete == true, "Unpriced requests carry partial-cost disclosure")
let measured = try decode(["today": [
    "requests": 4, "measuredRequests": 3, "pricedRequests": 4,
    "totalTokens": 120, "inputTokens": 100, "outputTokens": 20,
    "cachedInputTokens": 75, "estimatedCostUsd": 0,
]])
check(measured.today?.tokens == 120 && measured.today?.cost == 0, "Measured/free data retained")
check(measured.today?.coverage == 75 && measured.today?.cachedPercent == 75, "Coverage and cache ratio calculated")

let account: [String: Any] = ["id": "account-a", "label": "한글 계정", "active": true,
    "unavailable": false, "windows": [["id": "weekly", "label": "Weekly", "percent": 125, "resetAt": 1_900_000_000_000]]]
let quotasOnly = try decode(["errors": ["Usage unavailable"], "providers": [
    ["id": "provider-a", "label": "Provider A", "unavailable": false, "accounts": [account]],
]])
let window = quotasOnly.providers[0].accounts[0].windows[0]
check(quotasOnly.today == nil && quotasOnly.providers.count == 1, "Usage failure cannot hide successful quotas")
check(quotasOnly.providers[0].accounts[0].label == "한글 계정", "Unicode label survives the wire")
check(window.value == 125 && window.fill == 1, "Clamp fill, preserve displayed over-limit percent")
check(window.resetDate == Date(timeIntervalSince1970: 1_900_000_000), "Millisecond reset normalized")
check(NativeTrayFormat.date(1_900_000_000) == window.resetDate, "Second and millisecond reset agree")
check(NativeTrayFormat.date(0) == nil && NativeTrayFormat.date(1e300) == nil, "Invalid reset times are unavailable")
let now = Date(timeIntervalSince1970: 1_900_000_000)
check(NativeTrayFormat.reset(1_900_000_061, now: now) == "2m", "Reset duration rounds up")
check(NativeTrayFormat.reset(1_899_999_999, now: now) == "—", "Expired reset is not a future promise")

do { _ = try decode(["schemaVersion": 2]); fatalError("Unknown schema was accepted") }
catch NativeTrayDecodeError.unsupportedSchema { assertions += 1 }
do { _ = try decode(["providers": "bad"]); fatalError("Malformed roster was accepted") }
catch is DecodingError { assertions += 1 }

let many = try decode(["providers": (0..<80).map { index in
    ["id": "provider-\(index)", "label": "Provider \(index)", "unavailable": false, "accounts": [account]] as [String: Any]
}])
check(many.providers.count == 80, "Long roster must not be truncated to fit the popup")
check(Set(many.providers.map(\.id)).count == 80, "Provider identities disambiguate equal account ids")

// Provider marks: one representative file per paint mode, decoded by the view's own decoder.
let icons = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("gui/public/provider-icons")
for file in ["openai.svg", "grok.svg", "zai.svg", "nebius.svg"] {
    let svg = try String(contentsOf: icons.appendingPathComponent(file), encoding: .utf8)
    let image = NativeTrayIcon.image(svg: svg)
    check(image != nil && image!.size.width > 0 && image!.size.height > 0, "\(file) must decode to a visible mark")
}
check(NativeTrayIcon.image(svg: "not an image") == nil, "Unreadable mark data is no mark")
let marked = try decode(["providers": [["id": "openai", "label": "OpenAI", "unavailable": false, "accounts": [],
    "iconSvg": "<svg/>", "iconPaint": "mask"]]])
check(marked.providers[0].iconPaint == "mask" && marked.providers[0].iconSvg == "<svg/>", "Mark fields decode")
check(quotasOnly.providers[0].iconSvg == nil, "Providers without a mark still decode")

// Quota bars use the dashboard's severity thresholds and keep a spoken value.
check(NativeTrayFormat.severity(69.9) == .normal && NativeTrayFormat.severity(70) == .warn, "Warn at 70%")
check(NativeTrayFormat.severity(90) == .critical && NativeTrayFormat.severity(125) == .critical, "Critical at 90%")
check(NativeTrayFormat.severity(nil) == .normal, "Unknown is not a severity")
check(NativeTrayFormat.percentDescription(125) == "125 percent", "Over-limit value is spoken as reported")
check(NativeTrayFormat.percentDescription(nil) == "Unavailable", "Missing value is spoken as unavailable")
// Labels floor like the dashboard so the number never crosses a threshold the color has not.
check(NativeTrayFormat.percentText(69.9) == "69%" && NativeTrayFormat.severity(69.9) == .normal, "69.9% reads 69% on green")
check(NativeTrayFormat.percentText(89.9) == "89%" && NativeTrayFormat.severity(89.9) == .warn, "89.9% reads 89% on orange")
check(NativeTrayFormat.percentDescription(89.9) == "89 percent", "Spoken value floors too")
check(NativeTrayFormat.percentText(nil) == "—", "Missing value renders a dash")
check(NativeTrayFormat.percentText(1e20) == "—", "Oversized percent cannot trap visible formatting")
check(NativeTrayFormat.percentDescription(1e20) == "Unavailable", "Oversized percent cannot trap spoken formatting")
let largestSafePercent = Double(Int.max).nextDown
check(NativeTrayFormat.percentText(largestSafePercent) == "\(Int(largestSafePercent))%", "Largest representable percent remains visible")
check(NativeTrayFormat.percentDescription(largestSafePercent) == "\(Int(largestSafePercent)) percent", "Largest representable percent remains spoken")
check(NativeTrayFormat.percentText(Double(Int.max)) == "—", "Rounded Int upper bound is unavailable visibly")
check(NativeTrayFormat.percentDescription(Double(Int.max)) == "Unavailable", "Rounded Int upper bound is unavailable when spoken")

// Account switching: only names cross to the host, and only for rows the runtime would accept.
func switchRow(_ id: String, _ fields: [String: Any]) -> [String: Any] {
    var row: [String: Any] = ["id": "\(id):0", "label": id, "active": false, "unavailable": false, "windows": []]
    row.merge(fields) { _, new in new }
    return row
}
let switching = try decode(["providers": [
    ["id": "openai", "label": "OpenAI", "unavailable": false, "switchable": true, "accounts": [
        switchRow("__main__", ["accountId": "__main__", "switchState": "blocked", "blockedReason": "mainHardLock"]),
        switchRow("pool-a", ["accountId": "pool-a", "switchState": "active", "active": true]),
        switchRow("pool-b", ["accountId": "pool-b", "switchState": "available", "exhausted": true]),
        switchRow("pool-c", ["accountId": "pool-c", "switchState": "blocked", "blockedReason": "paused"]),
    ]],
    ["id": "legacy", "label": "Older host", "unavailable": false, "accounts": [switchRow("k", [:])]],
]])
let openai = switching.providers[0]
check(NativeTraySwitch.request(provider: openai, account: openai.accounts[0]) == nil, "A hard-locked main account is not offered")
check(NativeTraySwitch.request(provider: openai, account: openai.accounts[1]) == nil, "The active account is not offered")
let exhaustedPick = NativeTraySwitch.request(provider: openai, account: openai.accounts[2])
check(exhaustedPick?.provider == "openai" && exhaustedPick?.accountId == "pool-b", "An exhausted pool account stays switchable, by raw id")
check(openai.accounts[2].exhausted == true, "Exhaustion decodes for the warning")
check(NativeTraySwitch.request(provider: openai, account: openai.accounts[3]) == nil, "A paused account is not offered")
let legacy = switching.providers[1]
check(legacy.switchable == nil && NativeTraySwitch.request(provider: legacy, account: legacy.accounts[0]) == nil,
      "Snapshots from older hosts decode and offer no switch")
// A pending switch ends on the host's failure marker or a finished refresh showing the row active.
check(NativeTraySwitch.settles(snapshot: switching, pendingRow: "pool-a:0"), "A finished refresh with the row active settles")
check(!NativeTraySwitch.settles(snapshot: switching, pendingRow: "pool-b:0"), "Another row being active does not settle")
let refreshingSwitch = try decode(["refreshing": true, "providers": [["id": "openai", "label": "OpenAI", "unavailable": false,
    "switchable": true, "accounts": [switchRow("pool-b", ["accountId": "pool-b", "active": true, "switchState": "active"])]]]])
check(!NativeTraySwitch.settles(snapshot: refreshingSwitch, pendingRow: "pool-b:0"), "An in-flight refresh does not settle")
let unrelatedError = try decode(["errors": ["Usage unavailable"], "providers": []])
check(!NativeTraySwitch.settles(snapshot: unrelatedError, pendingRow: "pool-b:0"), "An unrelated error does not settle")
let failedSwitch = try decode(["errors": ["The runtime refused that account right now."], "switchFailed": true, "refreshing": false, "providers": []])
check(NativeTraySwitch.settles(snapshot: failedSwitch, pendingRow: "pool-b:0"), "The host's failure marker settles at once")

// Stage 4B: codexAccountMode Pool/Direct + detectedClients + 10+ locale .lproj bundles + passive IDE detection.
let modeSnapshot = try decode([
    "providers": [
        ["id": "openai", "label": "OpenAI", "unavailable": false, "switchable": true, "codexAccountMode": "direct", "accounts": []],
    ],
    "detectedClients": [
        ["id": "antigravity", "label": "Antigravity", "installed": true, "connected": true, "state": "connected"],
        ["id": "claude", "label": "Claude", "installed": true, "connected": false, "state": "detected"],
        ["id": "cursor", "label": "Cursor", "installed": false, "connected": false, "state": "notDetected"],
    ],
])
check(modeSnapshot.providers.first?.codexAccountMode == "direct", "Provider decodes codexAccountMode")
check(modeSnapshot.detectedClients?.count == 3 && modeSnapshot.detectedClients?[0].connected == true, "Snapshot decodes detectedClients")

for code in ["en", "ko", "ja", "zh-Hans", "zh-Hant", "de", "fr", "pt", "ru", "tr", "vi"] {
    let loc = Locale(identifier: code)
    let accountsTitle = NativeTrayL10n.text("tray.section.accounts", locale: loc)
    let connectedLabel = NativeTrayL10n.text("tray.client.connected", locale: loc)
    let refreshLabel = NativeTrayL10n.text("tray.action.refresh", locale: loc)
    let providerUnavailable = NativeTrayL10n.text("tray.provider.unavailable", locale: loc)
    let usageIncomplete = NativeTrayL10n.text("tray.usage.incomplete", locale: loc)
    let blockedHardLock = NativeTrayL10n.text("tray.switch.blockedHardLock", locale: loc)
    let resetLine = NativeTrayL10n.formatted("tray.reset.in", "12m", locale: loc)
    check(!accountsTitle.isEmpty && accountsTitle != "tray.section.accounts", "Locale \(code) translates accounts title")
    check(!connectedLabel.isEmpty && connectedLabel != "tray.client.connected", "Locale \(code) translates client status")
    check(!refreshLabel.isEmpty && refreshLabel != "tray.action.refresh", "Locale \(code) translates refresh action")
    check(!providerUnavailable.isEmpty && providerUnavailable != "tray.provider.unavailable", "Locale \(code) translates provider unavailable notice")
    check(!usageIncomplete.isEmpty && usageIncomplete != "tray.usage.incomplete", "Locale \(code) translates usage incomplete notice")
    check(!blockedHardLock.isEmpty && blockedHardLock != "tray.switch.blockedHardLock", "Locale \(code) translates blocked notice")
    check(resetLine.contains("12m"), "Locale \(code) formats reset countdown")
}
check(NativeTrayL10n.text("tray.section.accounts", locale: Locale(identifier: "ko")) != NativeTrayL10n.text("tray.section.accounts", locale: Locale(identifier: "en")),
      "Korean localization differs from English")

let tempHome = FileManager.default.temporaryDirectory.appendingPathComponent("epx-tray-detect-\(UUID().uuidString)", isDirectory: true)
try FileManager.default.createDirectory(at: tempHome.appendingPathComponent(".codex"), withIntermediateDirectories: true)
try #"model_provider = "easyproxy""#.write(to: tempHome.appendingPathComponent(".codex/config.toml"), atomically: true, encoding: .utf8)
try FileManager.default.createDirectory(at: tempHome.appendingPathComponent(".antigravity"), withIntermediateDirectories: true)
try #"{"gateway":{"url":"http://127.0.0.1:10100"}}"#.write(to: tempHome.appendingPathComponent(".antigravity/settings.json"), atomically: true, encoding: .utf8)
try FileManager.default.createDirectory(at: tempHome.appendingPathComponent(".claude"), withIntermediateDirectories: true)
try #"{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}"#.write(to: tempHome.appendingPathComponent(".claude/settings.json"), atomically: true, encoding: .utf8)
defer { try? FileManager.default.removeItem(at: tempHome) }

let detectedLocal = NativeTrayLocalClientDetector.detect(homeDirectory: tempHome)
check(detectedLocal.count == 4, "Local passive detector returns Codex, Antigravity, Claude, and Cursor")
check(detectedLocal[0].id == "codex" && detectedLocal[0].connected && detectedLocal[0].state == "connected", "Codex passive detection sees model_provider easyproxy")
check(detectedLocal[1].id == "antigravity" && detectedLocal[1].connected && detectedLocal[1].state == "connected", "Antigravity passive detection sees connected gateway")
check(detectedLocal[2].id == "claude" && detectedLocal[2].installed && !detectedLocal[2].connected && detectedLocal[2].state == "detected", "Claude passive detection sees local install without gateway")
check(detectedLocal[3].id == "cursor" && !detectedLocal[3].installed && detectedLocal[3].state == "notDetected", "Cursor passive detection reports notDetected when absent")

// Explicit empty host snapshot must NOT fall back to passive disk probing.
let explicitEmpty = NativeTrayLocalClientDetector.detect(homeDirectory: tempHome, snapshotClients: [])
check(explicitEmpty.isEmpty, "Explicit empty host snapshot overrides passive disk scan")

// Negative localhost test: unrelated loopback ports must NOT falsely mark clients connected.
let negHome = FileManager.default.temporaryDirectory.appendingPathComponent("epx-tray-neg-\(UUID().uuidString)", isDirectory: true)
try FileManager.default.createDirectory(at: negHome.appendingPathComponent(".codex"), withIntermediateDirectories: true)
try "model_provider = \"openai\"\n[model_providers.local]\nbase_url = \"http://localhost:8080/v1\"\n".write(to: negHome.appendingPathComponent(".codex/config.toml"), atomically: true, encoding: .utf8)
try FileManager.default.createDirectory(at: negHome.appendingPathComponent(".antigravity"), withIntermediateDirectories: true)
try #"{"gateway":{"url":"http://localhost:8080"}}"#.write(to: negHome.appendingPathComponent(".antigravity/settings.json"), atomically: true, encoding: .utf8)
try FileManager.default.createDirectory(at: negHome.appendingPathComponent(".claude"), withIntermediateDirectories: true)
try #"{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4000"}}"#.write(to: negHome.appendingPathComponent(".claude/settings.json"), atomically: true, encoding: .utf8)
try FileManager.default.createDirectory(at: negHome.appendingPathComponent(".cursor"), withIntermediateDirectories: true)
try #"{"mcpServers":{"local":{"url":"http://localhost:3000/v1"}}}"#.write(to: negHome.appendingPathComponent(".cursor/mcp.json"), atomically: true, encoding: .utf8)
defer { try? FileManager.default.removeItem(at: negHome) }

let negLocal = NativeTrayLocalClientDetector.detect(homeDirectory: negHome)
check(negLocal.count == 4 && negLocal.allSatisfy { $0.installed && !$0.connected && $0.state == "detected" },
      "Unrelated localhost/127.0.0.1 configs remain detected, never connected")

print("PASS: \(assertions) native tray contract/formatting assertions")
