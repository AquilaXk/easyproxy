import Foundation
import WidgetKit

/// The kind `EasyProxyWidget` declares in app/Sources/EasyProxyWidget/Views.swift.
private let easyProxyWidgetKind = "EasyProxyWidget"

/// Asks WidgetKit to request a new timeline from the desktop widget.
///
/// The Rust host writes the widget snapshot into the extension's container and calls this after
/// a write that changed what the widget shows. Without it the widget only rereads the file on its
/// own timeline schedule, which WidgetKit is free to postpone, so a fresh snapshot could sit unread
/// for a long time. WidgetKit still enforces its reload budget; this is a request, not a redraw.
/// The Rust caller runs on an async worker, so the call hops to the main queue.
@_cdecl("epx_widget_reload_timelines")
public func widgetReloadTimelines() {
    DispatchQueue.main.async {
        WidgetCenter.shared.reloadTimelines(ofKind: easyProxyWidgetKind)
    }
}
