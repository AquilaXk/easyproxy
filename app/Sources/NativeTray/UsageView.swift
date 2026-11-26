import SwiftUI

@MainActor
final class NativeTrayStore: ObservableObject {
    @Published var snapshot: NativeTraySnapshot?
    @Published var decodeFailed = false
    /// The account row whose switch is in flight, until a settled snapshot arrives.
    @Published var pendingSwitch: String?
    var action: (Int32) -> Void = { _ in }
    var switchAccount: (String, String) -> Void = { _, _ in }
    private var pendingToken = 0

    func requestSwitch(provider: NativeTrayProvider, account: NativeTrayProvider.Account) {
        guard pendingSwitch == nil, let request = NativeTraySwitch.request(provider: provider, account: account) else { return }
        pendingSwitch = account.id
        pendingToken += 1
        let token = pendingToken
        // A switch whose answer never arrives (host gone, panel reopened) must not spin forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.pendingToken == token else { return }
            self.pendingSwitch = nil
        }
        switchAccount(request.provider, request.accountId)
    }

    func settlePendingSwitch() {
        guard let pending = pendingSwitch, let snapshot,
              NativeTraySwitch.settles(snapshot: snapshot, pendingRow: pending) else { return }
        pendingSwitch = nil
        pendingToken += 1
    }
}

struct NativeTrayUsageView: View {
    @ObservedObject var store: NativeTrayStore

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("EasyProxy").font(.headline)
                Spacer()
                if store.snapshot?.refreshing == true { ProgressView().controlSize(.small) }
                Button { store.action(4) } label: { Image(systemName: "gearshape") }
                    .buttonStyle(.plain)
                    .help(NativeTrayL10n.text("tray.action.settings"))
                    .accessibilityLabel(NativeTrayL10n.text("tray.action.settings"))
            }.padding(14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let snapshot = store.snapshot {
                        if snapshot.settings.showAccounts && !snapshot.providers.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(NativeTrayL10n.text("tray.section.accounts"))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                ForEach(Array(snapshot.providers.enumerated()), id: \.element.id) { index, provider in
                                    if index > 0 {
                                        Divider().opacity(0.55)
                                    }
                                    NativeTrayProviderView(provider: provider, pendingSwitch: store.pendingSwitch) { account in
                                        store.requestSwitch(provider: provider, account: account)
                                    }
                                }
                            }
                            if snapshot.settings.showToday || snapshot.settings.show30Days || snapshot.settings.showChart || (snapshot.settings.showModels && !snapshot.models.isEmpty) {
                                Divider()
                            }
                        }
                        if snapshot.settings.showToday || snapshot.settings.show30Days {
                            HStack(alignment: .top, spacing: 16) {
                                if snapshot.settings.showToday {
                                    NativeTrayTotalsView(title: NativeTrayL10n.text("tray.section.today"), totals: snapshot.today, showCost: snapshot.settings.showCost)
                                }
                                if snapshot.settings.showToday && snapshot.settings.show30Days { Divider() }
                                if snapshot.settings.show30Days {
                                    NativeTrayTotalsView(title: NativeTrayL10n.text("tray.section.month"), totals: snapshot.month, showCost: snapshot.settings.showCost)
                                }
                            }
                        }
                        if snapshot.settings.showChart, let chart = snapshot.chart {
                            Divider()
                            NativeTrayChartView(chart: chart, style: snapshot.settings.chartStyle)
                        }
                        if snapshot.settings.showModels && !snapshot.models.isEmpty {
                            Divider()
                            VStack(alignment: .leading, spacing: 8) {
                                Text(NativeTrayL10n.text("tray.section.models")).font(.subheadline).foregroundStyle(.secondary)
                                ForEach(snapshot.models) { row in
                                    HStack {
                                        Text(row.label).lineLimit(1).help(row.label)
                                        Spacer(minLength: 8)
                                        Text("\(NativeTrayFormat.tokens(row.requests)) \(NativeTrayL10n.text("tray.requests"))")
                                            .foregroundStyle(.secondary).font(.caption)
                                        Text(NativeTrayFormat.tokens(row.tokens)).monospacedDigit()
                                    }
                                }
                            }
                        }
                        let detectedClients = NativeTrayLocalClientDetector
                            .detect(snapshotClients: snapshot.detectedClients)
                            .filter { $0.installed || $0.connected }
                        if !detectedClients.isEmpty {
                            Divider()
                            NativeTrayDetectedClientsView(clients: detectedClients)
                        }
                        ForEach(Array(snapshot.errors.enumerated()), id: \.offset) { _, error in
                            Label(error, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.secondary).font(.caption)
                        }
                    } else {
                        HStack { ProgressView().controlSize(.small); Text(NativeTrayL10n.text("tray.loading")) }
                            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 40)
                    }
                    if store.decodeFailed {
                        Text(NativeTrayL10n.text("tray.empty")).foregroundStyle(.secondary)
                    }
                }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack(spacing: 10) {
                Button(NativeTrayL10n.text("tray.action.refresh")) { store.action(1) }
                    .disabled(store.snapshot?.refreshing == true && !store.decodeFailed)
                if let updated = NativeTrayFormat.date(store.snapshot?.updatedAt) {
                    Text(updated, style: .time).font(.caption).foregroundStyle(.secondary)
                        .help(NativeTrayL10n.text("tray.updated.help"))
                }
                Spacer()
                Button(NativeTrayL10n.text("tray.openDashboard")) { store.action(3) }
            }.controlSize(.small).padding(12)
        }
        .font(.system(size: 12))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onExitCommand { store.action(2) }
    }
}

private struct NativeTrayTotalsView: View {
    let title: String
    let totals: NativeTrayTotals?
    let showCost: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.subheadline).foregroundStyle(.secondary)
            row(NativeTrayL10n.text("tray.tokens"), NativeTrayFormat.tokens(totals?.tokens), headline: true)
            row(NativeTrayL10n.text("tray.input"), NativeTrayFormat.tokens(totals?.input))
            if let cached = totals?.cachedPercent {
                Text("\(Int(cached.rounded()))% \(NativeTrayL10n.text("tray.cached"))").font(.caption2).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            row(NativeTrayL10n.text("tray.output"), NativeTrayFormat.tokens(totals?.output))
            if showCost {
                row(NativeTrayL10n.text("tray.cost.est"), (totals?.cost?.formatted(.currency(code: "USD")) ?? "—") + (totals?.costIncomplete == true ? "*" : ""))
                    .help(NativeTrayL10n.text(totals?.costIncomplete == true ? "tray.cost.incompleteHelp" : "tray.cost.help"))
            }
            row(NativeTrayL10n.text("tray.requests"), NativeTrayFormat.tokens(totals?.requests))
            if let coverage = totals?.coverage, coverage < 100 { row(NativeTrayL10n.text("tray.coverage"), "\(Int(coverage.rounded()))%") }
            if totals?.incomplete == true {
                Text(NativeTrayL10n.text("tray.usage.incomplete")).font(.caption2).foregroundStyle(.secondary)
            }
        }.frame(maxWidth: .infinity, alignment: .topLeading)
    }
    private func row(_ label: String, _ value: String, headline: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary).font(.caption)
            Spacer(minLength: 4)
            Text(value).font(headline ? .system(size: 19, weight: .semibold, design: .rounded) : .system(size: 12))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
        }
    }
}
