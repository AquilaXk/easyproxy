import SwiftUI
import Charts

struct NativeTrayProviderView: View {
    let provider: NativeTrayProvider
    var pendingSwitch: String? = nil
    var onUse: ((NativeTrayProvider.Account) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                NativeTrayProviderMark(provider: provider)
                Text(provider.label).font(.subheadline.weight(.semibold))
                Spacer(minLength: 4)
                if let mode = provider.codexAccountMode {
                    let isPool = mode != "direct"
                    Text(NativeTrayL10n.text(isPool ? "tray.mode.pool" : "tray.mode.direct"))
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            Capsule().fill(isPool ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(0.14))
                        )
                        .foregroundStyle(isPool ? Color.accentColor : Color.secondary)
                }
            }
            if provider.unavailable || provider.accounts.isEmpty {
                Text(NativeTrayL10n.text(provider.unavailable ? "tray.provider.unavailable" : "tray.quota.unavailable"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(provider.accounts) { account in
                VStack(alignment: .leading, spacing: 6) {
                    NativeTrayAccountHeader(
                        account: account,
                        switchable: provider.switchable == true && onUse != nil,
                        pending: pendingSwitch == account.id,
                        busy: pendingSwitch != nil,
                        onUse: { onUse?(account) })
                    if let email = account.email, email != account.label {
                        Text(email).font(.caption2).foregroundStyle(.secondary)
                    }
                    if account.unavailable || account.windows.isEmpty {
                        Text(NativeTrayL10n.text("tray.quota.unavailable")).font(.caption2).foregroundStyle(.secondary)
                    }
                    ForEach(account.windows) { window in
                        let resetLabel = NativeTrayFormat.reset(window.resetAt)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(window.label)
                                    .font(.caption)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Spacer(minLength: 8)
                                if resetLabel != "—" {
                                    Text(NativeTrayL10n.formatted("tray.reset.in", resetLabel))
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .monospacedDigit()
                                        .lineLimit(1)
                                }
                                Text(NativeTrayFormat.percentText(window.value))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.primary)
                                    .monospacedDigit()
                            }
                            .help(window.resetDate?.formatted(date: .complete, time: .standard) ?? NativeTrayL10n.text("tray.reset.unavailable"))
                            NativeTrayQuotaBar(window: window)
                        }
                    }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct NativeTrayDetectedClientsView: View {
    let clients: [NativeTrayDetectedClient]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(NativeTrayL10n.text("tray.section.clients"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 6)], alignment: .leading, spacing: 6) {
                ForEach(clients) { client in
                    let badgeText = client.connected
                        ? NativeTrayL10n.text("tray.client.connected")
                        : (client.installed ? NativeTrayL10n.text("tray.client.detected") : NativeTrayL10n.text("tray.client.notDetected"))
                    let dotColor: Color = client.connected ? .green : (client.installed ? .orange : .secondary)
                    HStack(spacing: 5) {
                        Circle()
                            .fill(dotColor)
                            .frame(width: 6, height: 6)
                        Text(client.label)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                        Text(badgeText)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                    .help("\(client.label): \(badgeText)")
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.secondary.opacity(0.08)))
                }
            }
        }
    }
}

struct NativeTrayChartView: View {
    let chart: NativeTrayChart
    let style: String
    private let palette: [Color] = [.blue, .orange, .green, .purple, .red, .cyan, .pink, .yellow, .mint, .indigo]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if chart.series.isEmpty {
                Text(NativeTrayL10n.text("tray.chart.empty")).foregroundStyle(.secondary)
            } else {
                Chart {
                    ForEach(chart.series) { series in
                        ForEach(Array(series.points.enumerated()), id: \.offset) { index, point in
                            let date = Date(timeIntervalSince1970: chart.start + Double(index) * chart.bucketSeconds)
                            if style == "stackedBar" {
                                BarMark(
                                    x: .value(NativeTrayL10n.text("tray.chart.time"), date),
                                    y: .value(NativeTrayL10n.text("tray.tokens"), max(0, point)),
                                    stacking: .standard
                                )
                                    .foregroundStyle(by: .value(NativeTrayL10n.text("tray.chart.series"), series.id))
                            } else {
                                LineMark(
                                    x: .value(NativeTrayL10n.text("tray.chart.time"), date),
                                    y: .value(NativeTrayL10n.text("tray.tokens"), max(0, point)),
                                    series: .value(NativeTrayL10n.text("tray.chart.series"), series.id)
                                )
                                    .foregroundStyle(by: .value(NativeTrayL10n.text("tray.chart.series"), series.id))
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { axis in
                        AxisGridLine()
                        AxisValueLabel(anchor: .trailing) {
                            if let value = axis.as(Double.self) { Text(NativeTrayFormat.tokens(value)) }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 3)) { axis in
                        AxisGridLine()
                        AxisTick()
                        AxisValueLabel(anchor: .center) {
                            if let date = axis.as(Date.self) {
                                Text(date, format: .dateTime.hour().minute())
                            }
                        }
                    }
                }
                .chartForegroundStyleScale(domain: chart.series.map(\.id), range: chart.series.indices.map { palette[$0 % palette.count] })
                .chartLegend(.hidden)
                .frame(height: 130)
                .accessibilityLabel(NativeTrayL10n.text("tray.section.chart"))
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 5) {
                    ForEach(Array(chart.series.enumerated()), id: \.element.id) { index, series in
                        HStack(spacing: 5) {
                            Circle().fill(palette[index % palette.count]).frame(width: 6, height: 6).accessibilityHidden(true)
                            Text(series.label).lineLimit(1).truncationMode(.middle).help(series.label)
                        }.font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            if chart.incomplete {
                Text(NativeTrayL10n.text("tray.usage.incomplete")).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}
