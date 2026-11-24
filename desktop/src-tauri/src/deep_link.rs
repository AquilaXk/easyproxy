use std::sync::{Mutex, PoisonError};
use tauri::{AppHandle, Manager};

pub const MAX_DEEP_LINK_URL_BYTES: usize = 8192;

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TargetKind {
    Provider,
    Import,
}

impl TargetKind {
    const fn canonical_encoded_prefix(self) -> &'static str {
        match self {
            Self::Provider => "providers?import=epx%3A%2F%2Fprovider",
            Self::Import => "providers?import=epx%3A%2F%2Fimport",
        }
    }

    const fn canonical_log_prefix(self) -> &'static str {
        match self {
            Self::Provider => "epx://provider",
            Self::Import => "epx://import",
        }
    }
}

#[derive(Default)]
pub struct PendingDeepLink(pub Mutex<Option<String>>);

impl PendingDeepLink {
    pub fn set_pending(&self, fragment: String) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(fragment);
    }

    pub fn take_pending(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

#[inline]
const fn is_unreserved(b: u8) -> bool {
    matches!(
        b,
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'~' | b'-'
    )
}

#[inline]
const fn is_control(b: u8) -> bool {
    b <= 0x1f || b == 0x7f
}

#[inline]
fn looks_like_epx_scheme(raw: &str) -> bool {
    raw.as_bytes()
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"epx://"))
}

fn parse_target(bytes: &[u8]) -> Option<(TargetKind, &[u8])> {
    if bytes.len() < 6 || !bytes[..6].eq_ignore_ascii_case(b"epx://") {
        return None;
    }
    let after_scheme = &bytes[6..];
    let (kind, rest) =
        if after_scheme.len() >= 8 && after_scheme[..8].eq_ignore_ascii_case(b"provider") {
            (TargetKind::Provider, &after_scheme[8..])
        } else if after_scheme.len() >= 6 && after_scheme[..6].eq_ignore_ascii_case(b"import") {
            (TargetKind::Import, &after_scheme[6..])
        } else {
            return None;
        };
    match rest.first().copied() {
        None | Some(b'/' | b'?' | b'#') => Some((kind, rest)),
        Some(_) => None,
    }
}

/// Validate an incoming `epx://` URL and convert it to a `#providers?import=<percent-encoded>`
/// dashboard fragment (without the leading `#`). Fails closed on empty, oversized, control-byte,
/// wrong-scheme, or disallowed-target inputs.
pub fn parse_deep_link(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_DEEP_LINK_URL_BYTES {
        return None;
    }
    let (kind, rest) = parse_target(bytes)?;

    let mut encoded_rest_len = 0usize;
    for &b in rest {
        if is_control(b) {
            return None;
        }
        encoded_rest_len += if is_unreserved(b) { 1 } else { 3 };
    }

    let prefix = kind.canonical_encoded_prefix();
    let mut out = String::with_capacity(prefix.len() + encoded_rest_len);
    out.push_str(prefix);
    for &b in rest {
        if is_unreserved(b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX_UPPER[(b >> 4) as usize] as char);
            out.push(HEX_UPPER[(b & 0x0f) as usize] as char);
        }
    }
    Some(out)
}

/// Return the normalized fragment of the first valid `epx://` deep link in `args`, logging
/// redacted diagnostics for rejected `epx://` arguments without leaking query secrets.
pub fn first_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for arg in args {
        let raw = arg.as_ref();
        if let Some(fragment) = parse_deep_link(raw) {
            return Some(fragment);
        }
        if looks_like_epx_scheme(raw) {
            crate::logging::log_once("deep link ignored", &redact_deep_link_for_log(raw));
        }
    }
    None
}

/// Redact subpaths, query values, fragments, and invalid targets before logging a deep-link URL.
pub fn redact_deep_link_for_log(raw: &str) -> String {
    let bytes = raw.as_bytes();
    if bytes.is_empty() {
        return "<empty-deep-link>".to_owned();
    }
    let is_epx = looks_like_epx_scheme(raw);
    if bytes.len() > MAX_DEEP_LINK_URL_BYTES || bytes.iter().copied().any(is_control) {
        return if is_epx {
            "epx://<invalid>".to_owned()
        } else {
            "<invalid-deep-link>".to_owned()
        };
    }
    let Some((kind, rest)) = parse_target(bytes) else {
        return if is_epx {
            "epx://<invalid>".to_owned()
        } else {
            "<invalid-deep-link>".to_owned()
        };
    };

    let (before_fragment, has_fragment) = match rest.iter().position(|&b| b == b'#') {
        Some(idx) => (&rest[..idx], true),
        None => (rest, false),
    };
    let (path_part, has_query) = match before_fragment.iter().position(|&b| b == b'?') {
        Some(idx) => (&before_fragment[..idx], true),
        None => (before_fragment, false),
    };
    let has_subpath = !path_part.is_empty() && path_part != b"/";

    let mut out = String::from(kind.canonical_log_prefix());
    if has_subpath {
        out.push_str("/<redacted>");
    } else if path_part == b"/" {
        out.push('/');
    }
    if has_query {
        out.push_str("?<redacted>");
    }
    if has_fragment {
        out.push_str("#<redacted>");
    }
    out
}

pub fn dashboard_url_with_fragment(ready_dashboard: &str, fragment: &str) -> String {
    let base = ready_dashboard.split('#').next().unwrap_or(ready_dashboard);
    let fragment = fragment.strip_prefix('#').unwrap_or(fragment);
    let mut out = String::with_capacity(base.len() + 1 + fragment.len());
    out.push_str(base);
    out.push('#');
    out.push_str(fragment);
    out
}

fn preserves_local_page(window: &tauri::WebviewWindow, mode: crate::startup::Mode) -> bool {
    crate::window::shows_cli_page(window)
        || crate::startup::keeps_update_page(mode, crate::window::shows_update_page(window))
}

pub fn open_in_dashboard(app: &AppHandle, fragment: &str) {
    crate::popup::hide(app);
    let startup = app.try_state::<crate::startup::Startup>();
    let Some(window) = app.get_webview_window("main") else {
        if let Some(pending) = app.try_state::<PendingDeepLink>() {
            pending.set_pending(fragment.to_owned());
        }
        if let Some(ref startup) = startup {
            startup.request_dashboard();
        }
        return;
    };

    if let Some(ref startup) = startup {
        if let Some(base) = startup.ready_dashboard() {
            if !preserves_local_page(&window, startup.mode()) {
                let target = dashboard_url_with_fragment(&base, fragment);
                if crate::startup::navigate_dashboard(&window, &target) {
                    startup.mark_dashboard_navigated();
                }
            }
            crate::window::show(&window);
            return;
        }
        if let Some(pending) = app.try_state::<PendingDeepLink>() {
            pending.set_pending(fragment.to_owned());
        }
        startup.request_dashboard();
        // Re-check Ready after storing PendingDeepLink in case startup::finish() raced ahead.
        if let Some(base) = startup.ready_dashboard() {
            if preserves_local_page(&window, startup.mode()) {
                if let Some(pending) = app.try_state::<PendingDeepLink>() {
                    let _ = pending.take_pending();
                }
            } else if let Some(pending_fragment) = app
                .try_state::<PendingDeepLink>()
                .and_then(|pending| pending.take_pending())
            {
                let target = dashboard_url_with_fragment(&base, &pending_fragment);
                if crate::startup::navigate_dashboard(&window, &target) {
                    startup.mark_dashboard_navigated();
                }
            }
        }
    } else if let Some(pending) = app.try_state::<PendingDeepLink>() {
        pending.set_pending(fragment.to_owned());
    }
    crate::window::show(&window);
}

#[cfg(test)]
mod tests {
    use super::{
        dashboard_url_with_fragment, first_from_args, parse_deep_link, redact_deep_link_for_log,
        PendingDeepLink, MAX_DEEP_LINK_URL_BYTES,
    };

    #[test]
    fn validates_allowed_epx_targets_and_encodes_fragment() {
        assert_eq!(
            parse_deep_link("epx://provider?name=openrouter&apiKey=sk-123").as_deref(),
            Some("providers?import=epx%3A%2F%2Fprovider%3Fname%3Dopenrouter%26apiKey%3Dsk-123")
        );
        assert_eq!(
            parse_deep_link("epx://import?url=https://api.example.com/v1").as_deref(),
            Some("providers?import=epx%3A%2F%2Fimport%3Furl%3Dhttps%3A%2F%2Fapi.example.com%2Fv1")
        );
        assert_eq!(
            parse_deep_link("epx://provider").as_deref(),
            Some("providers?import=epx%3A%2F%2Fprovider")
        );
        assert_eq!(
            parse_deep_link("epx://import").as_deref(),
            Some("providers?import=epx%3A%2F%2Fimport")
        );
        assert_eq!(
            parse_deep_link("EPX://PROVIDER/custom?k=v#frag").as_deref(),
            Some("providers?import=epx%3A%2F%2Fprovider%2Fcustom%3Fk%3Dv%23frag")
        );
        assert_eq!(
            parse_deep_link("Epx://Import#step1").as_deref(),
            Some("providers?import=epx%3A%2F%2Fimport%23step1")
        );
    }

    #[test]
    fn enforces_max_byte_limit() {
        let prefix = "epx://provider?data=";
        let at_limit = format!(
            "{prefix}{}",
            "a".repeat(MAX_DEEP_LINK_URL_BYTES - prefix.len())
        );
        assert_eq!(at_limit.len(), MAX_DEEP_LINK_URL_BYTES);
        assert!(parse_deep_link(&at_limit).is_some());

        let over_limit = format!(
            "{prefix}{}",
            "a".repeat(MAX_DEEP_LINK_URL_BYTES - prefix.len() + 1)
        );
        assert_eq!(over_limit.len(), MAX_DEEP_LINK_URL_BYTES + 1);
        assert_eq!(parse_deep_link(&over_limit), None);

        // Multi-byte UTF-8 exceeding 8192 bytes must also be rejected.
        let utf8_over = format!("{prefix}{}", "가".repeat(3000));
        assert!(utf8_over.len() > MAX_DEEP_LINK_URL_BYTES);
        assert_eq!(parse_deep_link(&utf8_over), None);
    }

    #[test]
    fn rejects_empty_control_chars_schemes_and_disallowed_targets() {
        for bad in [
            "",
            "   ",
            " epx://provider?a=1",
            "epx://provider ",
            "epx://",
            "epx:///",
            "epx://settings",
            "epx://providers",
            "epx://imported",
            "epx://provider.evil.com?a=1",
            "epx://provider:8080/foo",
            "epx://provider@evil.com/foo",
            "epx://user@provider/foo",
            "epx://evil.com/provider",
            "epx://provider\\evil",
            "http://provider?a=1",
            "https://provider?a=1",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "epxs://provider?a=1",
            "epx:/provider?a=1",
            "epx://provider?a=1\0",
            "epx://provider?a=1\t",
            "epx://provider?a=1\n",
            "epx://provider?a=1\r",
            "epx://provider?a=1\x1f",
            "epx://provider?a=1\x7f",
            "epx://import\n?a=1",
            "epx://provider/sub\x7f?a=1",
        ] {
            assert_eq!(parse_deep_link(bad), None, "expected rejection for {bad:?}");
        }
    }

    #[test]
    fn percent_encodes_rfc3986_unreserved_and_utf8_bytes() {
        let unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-";
        let url = format!("epx://provider?v={unreserved}");
        assert_eq!(
            parse_deep_link(&url).as_deref(),
            Some(format!("providers?import=epx%3A%2F%2Fprovider%3Fv%3D{unreserved}").as_str())
        );

        assert_eq!(
            parse_deep_link("epx://provider?name=a b%20c+d&u=테스트").as_deref(),
            Some(
                "providers?import=epx%3A%2F%2Fprovider%3Fname%3Da%20b%2520c%2Bd%26u%3D%ED%85%8C%EC%8A%A4%ED%8A%B8"
            )
        );
    }

    #[test]
    fn redacts_secrets_and_control_characters_from_logs() {
        let secret_url = "epx://provider?name=acme&apiKey=sk-secret-999999";
        let redacted = redact_deep_link_for_log(secret_url);
        assert_eq!(redacted, "epx://provider?<redacted>");
        assert!(!redacted.contains("sk-secret"));
        assert!(!redacted.contains("apiKey"));
        assert!(!redacted.contains("acme"));

        let import_frag = "EPX://IMPORT/subsecret?token=abc#fragsecret";
        let redacted_import = redact_deep_link_for_log(import_frag);
        assert_eq!(
            redacted_import,
            "epx://import/<redacted>?<redacted>#<redacted>"
        );
        assert!(!redacted_import.contains("subsecret"));
        assert!(!redacted_import.contains("token"));
        assert!(!redacted_import.contains("abc"));
        assert!(!redacted_import.contains("fragsecret"));

        assert_eq!(redact_deep_link_for_log("epx://provider"), "epx://provider");
        assert_eq!(redact_deep_link_for_log(""), "<empty-deep-link>");

        let injection = "epx://provider?apiKey=secret\nFAKE LOG";
        let redacted_inj = redact_deep_link_for_log(injection);
        assert_eq!(redacted_inj, "epx://<invalid>");
        assert!(!redacted_inj.contains('\n'));
        assert!(!redacted_inj.contains("secret"));

        let evil_host = "epx://evil.com/secret?apiKey=secret";
        let redacted_evil = redact_deep_link_for_log(evil_host);
        assert_eq!(redacted_evil, "epx://<invalid>");
        assert!(!redacted_evil.contains("evil.com"));
        assert!(!redacted_evil.contains("secret"));

        let non_epx = "https://user:pass@evil.com/path?apiKey=secret";
        let redacted_non = redact_deep_link_for_log(non_epx);
        assert_eq!(redacted_non, "<invalid-deep-link>");
        assert!(!redacted_non.contains("evil.com"));
        assert!(!redacted_non.contains("pass"));
        assert!(!redacted_non.contains("secret"));

        let huge = format!(
            "epx://provider?apiKey={}",
            "x".repeat(MAX_DEEP_LINK_URL_BYTES + 10)
        );
        assert_eq!(redact_deep_link_for_log(&huge), "epx://<invalid>");
    }

    #[test]
    fn rewrites_dashboard_url_fragment_cleanly() {
        let base = "http://127.0.0.1:10100/?desktop_session=sess-1#/usage";
        assert_eq!(
            dashboard_url_with_fragment(base, "providers?import=epx%3A%2F%2Fprovider"),
            "http://127.0.0.1:10100/?desktop_session=sess-1#providers?import=epx%3A%2F%2Fprovider"
        );
        assert_eq!(
            dashboard_url_with_fragment(
                "http://127.0.0.1:10100/?desktop_session=sess-1",
                "#providers?import=epx%3A%2F%2Fimport"
            ),
            "http://127.0.0.1:10100/?desktop_session=sess-1#providers?import=epx%3A%2F%2Fimport"
        );
    }

    #[test]
    fn pending_deep_link_stores_overwrites_and_consumes_once() {
        let pending = PendingDeepLink::default();
        assert_eq!(pending.take_pending(), None);
        pending.set_pending("providers?import=first".to_owned());
        pending.set_pending("providers?import=second".to_owned());
        assert_eq!(
            pending.take_pending().as_deref(),
            Some("providers?import=second")
        );
        assert_eq!(pending.take_pending(), None);
    }

    #[test]
    fn first_from_args_skips_flags_and_invalid_urls() {
        let args = [
            "--autostart",
            "epx://evil.com?apiKey=secret",
            "epx://provider?name=ok",
            "epx://import?name=second",
        ];
        assert_eq!(
            first_from_args(args).as_deref(),
            Some("providers?import=epx%3A%2F%2Fprovider%3Fname%3Dok")
        );
        assert_eq!(first_from_args(["--autostart", "-psn_0_123"]), None);
    }
}
