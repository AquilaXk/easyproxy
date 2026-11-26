//! Passive, strictly read-only detection of local Codex, Antigravity, Claude, and Cursor setups.
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;

const MAX_CONFIG_INSPECT_BYTES: u64 = 256 * 1024;

fn read_bounded_text(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.len() > MAX_CONFIG_INSPECT_BYTES {
        return None;
    }
    let file = OpenOptions::new().read(true).open(path).ok()?;
    let mut buf = Vec::with_capacity(meta.len().min(MAX_CONFIG_INSPECT_BYTES) as usize);
    file.take(MAX_CONFIG_INSPECT_BYTES).read_to_end(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

fn find_loopback_ports(lower: &str) -> Vec<u16> {
    const PREFIXES: [&str; 6] = [
        "http://127.0.0.1:",
        "https://127.0.0.1:",
        "http://localhost:",
        "https://localhost:",
        "http://[::1]:",
        "https://[::1]:",
    ];
    let mut ports = Vec::new();
    for prefix in PREFIXES {
        let mut search_from = 0usize;
        while let Some(offset) = lower[search_from..].find(prefix) {
            let after_colon = search_from + offset + prefix.len();
            let rest = lower[after_colon..].as_bytes();
            let digit_count = rest.iter().take_while(|b| b.is_ascii_digit()).count();
            if digit_count > 0 && digit_count <= 5 {
                if let Ok(port) = lower[after_colon..after_colon + digit_count].parse::<u16>() {
                    if port > 0 {
                        let next_byte = rest.get(digit_count).copied();
                        if next_byte.is_none_or(|b| {
                            matches!(
                                b,
                                b'/' | b'?' | b'#' | b'"' | b'\'' | b' ' | b'\t' | b'\r' | b'\n' | b',' | b'}'
                            )
                        }) {
                            ports.push(port);
                        }
                    }
                }
            }
            search_from = after_colon;
        }
    }
    ports
}

fn find_loopback_origin_port(url_lower: &str) -> Option<u16> {
    const PREFIXES: [&str; 6] = [
        "http://127.0.0.1:",
        "https://127.0.0.1:",
        "http://localhost:",
        "https://localhost:",
        "http://[::1]:",
        "https://[::1]:",
    ];
    for prefix in PREFIXES {
        if let Some(rest_str) = url_lower.strip_prefix(prefix) {
            let rest = rest_str.as_bytes();
            let digit_count = rest.iter().take_while(|b| b.is_ascii_digit()).count();
            if digit_count > 0 && digit_count <= 5 {
                if let Ok(port) = rest_str[..digit_count].parse::<u16>() {
                    if port > 0 {
                        let next_byte = rest.get(digit_count).copied();
                        if next_byte.is_none_or(|b| matches!(b, b'/' | b'?' | b'#')) {
                            return Some(port);
                        }
                    }
                }
            }
        }
    }
    None
}

fn strip_jsonc(text: &str) -> Option<String> {
    let src = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut no_comments = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    let mut in_line = false;
    let mut in_block = false;
    while let Some(ch) = chars.next() {
        if in_line {
            if ch == '\n' || ch == '\r' {
                in_line = false;
                no_comments.push(ch);
            }
            continue;
        }
        if in_block {
            if ch == '\n' {
                no_comments.push(ch);
            } else if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                no_comments.push(' ');
                in_block = false;
            }
            continue;
        }
        if in_string {
            no_comments.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            no_comments.push(ch);
        } else if ch == '/' && chars.peek() == Some(&'/') {
            chars.next();
            in_line = true;
        } else if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            in_block = true;
        } else {
            no_comments.push(ch);
        }
    }
    if in_block {
        return None;
    }

    let cleaned_chars: Vec<char> = no_comments.chars().collect();
    let mut out = String::with_capacity(no_comments.len());
    in_string = false;
    escaped = false;
    for (i, &ch) in cleaned_chars.iter().enumerate() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push(ch);
            continue;
        }
        if ch == ',' {
            let next_non_ws = cleaned_chars[i + 1..].iter().copied().find(|c| !c.is_whitespace());
            if matches!(next_non_ws, Some('}' | ']')) {
                let prev_non_ws = out.chars().rev().find(|c| !c.is_whitespace());
                if prev_non_ws.is_some_and(|p| p != '{' && p != '[') {
                    continue;
                }
            }
        }
        out.push(ch);
    }
    Some(out)
}

fn has_loopback_port_url(lower: &str) -> bool {
    !find_loopback_ports(lower).is_empty()
}

fn has_easyproxy_key_prefix(lower: &str) -> bool {
    lower.contains("epx_data_") || lower.contains("epx_admin_") || lower.contains("epxrw_")
}

fn has_easyproxy_marker(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("easyproxy")
        || lower.contains("127.0.0.1:10100")
        || lower.contains("localhost:10100")
        || lower.contains("[::1]:10100")
    {
        return true;
    }
    has_loopback_port_url(&lower)
        && (has_easyproxy_key_prefix(&lower)
            || lower.contains("claude_code_enable_gateway_model_discovery"))
}

fn has_codex_easyproxy_marker(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("easyproxy-managed") {
        return true;
    }
    for raw_line in text.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if let Some((key, value)) = line.split_once('=') {
            if key.trim() == "model_provider" {
                let unquoted = value.trim().trim_matches('"').trim_matches('\'');
                if unquoted.eq_ignore_ascii_case("easyproxy") {
                    return true;
                }
            }
        }
    }
    false
}

fn server_gateway_antigravity(gateway_clients: Option<&Value>) -> Option<(bool, bool)> {
    let clients = gateway_clients?.get("clients")?.as_array()?;
    let row = clients
        .iter()
        .find(|entry| entry["id"].as_str() == Some("antigravity"))?;
    let state = row["state"].as_str().unwrap_or("");
    let connected = state == "connected";
    let any_file = row["files"]
        .as_array()
        .is_some_and(|files| files.iter().any(|f| f["exists"].as_bool() == Some(true)));
    Some((connected || state == "drifted" || any_file, connected))
}

fn server_native_client(native_integrations: Option<&Value>, client_id: &str) -> Option<(bool, bool)> {
    let clients = native_integrations?.get("clients")?.as_array()?;
    let row = clients
        .iter()
        .find(|entry| entry["clientId"].as_str() == Some(client_id))?;
    let installed = row["installed"].as_bool() == Some(true);
    let desired_enabled = row["desiredEnabled"].as_bool();
    let state = row["state"].as_str().unwrap_or("");
    let connected = installed && desired_enabled != Some(false) && state == "current";
    Some((installed, connected))
}

fn detect_codex(home: Option<&Path>, native_integrations: Option<&Value>) -> Value {
    if let Some((installed, connected)) = server_native_client(native_integrations, "codex") {
        return client_row("codex", "Codex", installed, connected);
    }
    let mut installed = false;
    let mut connected = false;
    if let Some(home) = home {
        let dir = home.join(".codex");
        let config = dir.join("config.toml");
        if dir.is_dir() {
            installed = true;
        }
        if let Some(content) = read_bounded_text(&config) {
            installed = true;
            if has_codex_easyproxy_marker(&content) {
                connected = true;
            }
        }
    }
    client_row("codex", "Codex", installed, connected)
}

fn is_easyproxy_antigravity_gateway(content: &str) -> bool {
    let Some(clean) = strip_jsonc(content) else {
        return false;
    };
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&clean) else {
        return false;
    };
    let Some(Value::Object(gateway)) = root.get("gateway") else {
        return false;
    };
    if gateway.get("enabled").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    let Some(url) = gateway.get("url").and_then(Value::as_str) else {
        return false;
    };
    let url_lower = url.trim().to_ascii_lowercase();
    let Some(port) = find_loopback_origin_port(&url_lower) else {
        return false;
    };
    if port == 10100 || url_lower.contains("easyproxy") {
        return true;
    }
    let key_lower = gateway
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    key_lower.contains("easyproxy") || has_easyproxy_key_prefix(&key_lower)
}

fn detect_antigravity(home: Option<&Path>, gateway_clients: Option<&Value>) -> Value {
    if let Some((installed, connected)) = server_gateway_antigravity(gateway_clients) {
        return client_row("antigravity", "Antigravity", installed, connected);
    }
    let mut installed = false;
    let mut connected = false;
    if let Some(home) = home {
        let dir = home.join(".antigravity");
        let settings = dir.join("settings.json");
        if dir.is_dir() {
            installed = true;
        }
        if let Some(content) = read_bounded_text(&settings) {
            installed = true;
            if is_easyproxy_antigravity_gateway(&content) {
                connected = true;
            }
        }
    }
    client_row("antigravity", "Antigravity", installed, connected)
}

fn detect_claude(home: Option<&Path>, native_integrations: Option<&Value>) -> Value {
    if let Some((installed, connected)) = server_native_client(native_integrations, "claude") {
        return client_row("claude", "Claude", installed, connected);
    }
    let mut installed = false;
    let mut connected = false;
    if let Some(home) = home {
        let candidates = [
            home.join(".claude").join("settings.json"),
            home.join(".claude.json"),
            home.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        ];
        if home.join(".claude").is_dir() {
            installed = true;
        }
        for path in candidates {
            if let Some(content) = read_bounded_text(&path) {
                installed = true;
                if has_easyproxy_marker(&content) && content.contains("ANTHROPIC_BASE_URL") {
                    connected = true;
                }
            }
        }
    }
    client_row("claude", "Claude", installed, connected)
}

fn is_cursor_proxy_url_key(key_lower: &str) -> bool {
    matches!(
        key_lower,
        "overrideopenaibaseurl"
            | "openaibaseurl"
            | "cursor.openaibaseurl"
            | "openai.baseurl"
            | "cursor.customopenaiurl"
            | "baseurl"
            | "base_url"
            | "apibase"
            | "apibaseurl"
            | "openai_base_url"
            | "anthropic_base_url"
            | "proxyurl"
            | "url"
    )
}

fn is_cursor_credential_key(key_lower: &str) -> bool {
    matches!(
        key_lower,
        "apikey"
            | "api_key"
            | "openaiapikey"
            | "openai.apikey"
            | "cursor.openaiapikey"
            | "token"
            | "authtoken"
            | "anthropic_auth_token"
            | "openai_api_key"
            | "authorization"
            | "x-api-key"
    )
}

fn inspect_cursor_json(
    value: &Value,
    key_hint: Option<&str>,
    saw_default_proxy_url: &mut bool,
    saw_loopback_proxy_url: &mut bool,
    saw_easyproxy_credential: &mut bool,
) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                inspect_cursor_json(
                    v,
                    Some(k.as_str()),
                    saw_default_proxy_url,
                    saw_loopback_proxy_url,
                    saw_easyproxy_credential,
                );
            }
        }
        Value::Array(items) => {
            for item in items {
                inspect_cursor_json(
                    item,
                    key_hint,
                    saw_default_proxy_url,
                    saw_loopback_proxy_url,
                    saw_easyproxy_credential,
                );
            }
        }
        Value::String(s) => {
            let Some(key) = key_hint else {
                return;
            };
            let key_lower = key.to_ascii_lowercase();
            let val_lower = s.trim().to_ascii_lowercase();
            if is_cursor_proxy_url_key(&key_lower) {
                if let Some(port) = find_loopback_origin_port(&val_lower) {
                    *saw_loopback_proxy_url = true;
                    if port == 10100 || val_lower.contains("easyproxy") {
                        *saw_default_proxy_url = true;
                    }
                }
            } else if is_cursor_credential_key(&key_lower)
                && (has_easyproxy_key_prefix(&val_lower)
                    || val_lower == "easyproxy-local"
                    || val_lower == "bearer easyproxy-local"
                    || val_lower == "easyproxy-loopback"
                    || val_lower.starts_with("bearer easyproxy-loopback")
                    || val_lower == "easyproxy")
            {
                *saw_easyproxy_credential = true;
            }
        }
        _ => {}
    }
}

fn is_easyproxy_cursor_config(content: &str) -> bool {
    let Some(clean) = strip_jsonc(content) else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&clean) else {
        return false;
    };
    if let Value::Object(map) = &parsed {
        if map.get("overrideOpenAiBaseUrl").and_then(Value::as_bool) == Some(false)
            || map
                .get("cursor.overrideOpenAiBaseUrl")
                .and_then(Value::as_bool)
                == Some(false)
        {
            return false;
        }
    }
    let mut saw_default_proxy_url = false;
    let mut saw_loopback_proxy_url = false;
    let mut saw_easyproxy_credential = false;
    inspect_cursor_json(
        &parsed,
        None,
        &mut saw_default_proxy_url,
        &mut saw_loopback_proxy_url,
        &mut saw_easyproxy_credential,
    );
    saw_default_proxy_url || (saw_loopback_proxy_url && saw_easyproxy_credential)
}

fn detect_cursor(home: Option<&Path>) -> Value {
    let mut installed = false;
    let mut connected = false;
    if let Some(home) = home {
        let candidates = [
            home.join(".cursor").join("mcp.json"),
            home.join(".cursor").join("cli-config.json"),
            home.join("Library")
                .join("Application Support")
                .join("Cursor")
                .join("User")
                .join("settings.json"),
        ];
        if home.join(".cursor").is_dir() {
            installed = true;
        }
        for path in candidates {
            if let Some(content) = read_bounded_text(&path) {
                installed = true;
                if is_easyproxy_cursor_config(&content) {
                    connected = true;
                }
            }
        }
    }
    client_row("cursor", "Cursor", installed, connected)
}

fn client_row(id: &str, label: &str, installed: bool, connected: bool) -> Value {
    let state = if connected {
        "connected"
    } else if installed {
        "detected"
    } else {
        "notDetected"
    };
    json!({
        "id": id,
        "label": label,
        "installed": installed,
        "connected": connected,
        "state": state,
    })
}

pub fn detect_local_clients(
    home: Option<&Path>,
    gateway_clients: Option<&Value>,
    native_integrations: Option<&Value>,
) -> Vec<Value> {
    vec![
        detect_codex(home, native_integrations),
        detect_antigravity(home, gateway_clients),
        detect_claude(home, native_integrations),
        detect_cursor(home),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(prefix: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("{prefix}-{}-{unique}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn passive_detection_reads_local_codex_antigravity_claude_and_cursor_without_mutating() {
        let temp = TestDir::new("epx-tray-clients");
        let home = temp.path();

        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex").join("config.toml"),
            "model_provider = \"easyproxy\"\n",
        )
        .unwrap();

        fs::create_dir_all(home.join(".antigravity")).unwrap();
        fs::write(
            home.join(".antigravity").join("settings.json"),
            r#"{"gateway":{"url":"http://127.0.0.1:10100"}}"#,
        )
        .unwrap();

        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(
            home.join(".claude").join("settings.json"),
            r#"{"env":{"ANTHROPIC_BASE_URL":"http://example.invalid"}}"#,
        )
        .unwrap();

        fs::create_dir_all(home.join(".cursor")).unwrap();
        fs::write(
            home.join(".cursor").join("mcp.json"),
            r#"{"overrideOpenAiBaseUrl":"http://127.0.0.1:10100/v1"}"#,
        )
        .unwrap();

        let rows = detect_local_clients(Some(home), None, None);
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0]["id"], "codex");
        assert_eq!(rows[0]["state"], "connected");
        assert_eq!(rows[1]["id"], "antigravity");
        assert_eq!(rows[1]["state"], "connected");
        assert_eq!(rows[2]["id"], "claude");
        assert_eq!(rows[2]["state"], "detected");
        assert_eq!(rows[3]["id"], "cursor");
        assert_eq!(rows[3]["state"], "connected");
    }

    #[test]
    fn passive_detection_rejects_unrelated_localhost_services() {
        let temp = TestDir::new("epx-tray-clients-neg");
        let home = temp.path();

        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex").join("config.toml"),
            "model_provider = \"openai\"\n[model_providers.local]\nbase_url = \"http://127.0.0.1:11434/v1\"\n",
        )
        .unwrap();

        fs::create_dir_all(home.join(".antigravity")).unwrap();
        fs::write(
            home.join(".antigravity").join("settings.json"),
            r#"{"gateway":{"url":"http://localhost:8080"}}"#,
        )
        .unwrap();

        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(
            home.join(".claude").join("settings.json"),
            r#"{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4000"}}"#,
        )
        .unwrap();

        fs::create_dir_all(home.join(".cursor")).unwrap();
        fs::write(
            home.join(".cursor").join("mcp.json"),
            r#"{"mcpServers":{"local":{"url":"http://localhost:3000/v1"}}}"#,
        )
        .unwrap();

        let rows = detect_local_clients(Some(home), None, None);
        assert_eq!(rows.len(), 4);
        for row in rows {
            assert_eq!(row["installed"], true);
            assert_eq!(row["connected"], false);
            assert_eq!(row["state"], "detected");
        }
    }

    #[test]
    fn passive_detection_prefers_live_server_status_when_present() {
        let gateway = json!({
            "clients": [{
                "id": "antigravity",
                "state": "connected",
                "files": [{"exists": true}]
            }]
        });
        let native = json!({
            "clients": [
                {
                    "clientId": "codex",
                    "installed": true,
                    "desiredEnabled": true,
                    "state": "current"
                },
                {
                    "clientId": "claude",
                    "installed": true,
                    "desiredEnabled": true,
                    "state": "current"
                }
            ]
        });
        let rows = detect_local_clients(None, Some(&gateway), Some(&native));
        assert_eq!(rows[0]["id"], "codex");
        assert_eq!(rows[0]["state"], "connected");
        assert_eq!(rows[1]["id"], "antigravity");
        assert_eq!(rows[1]["state"], "connected");
        assert_eq!(rows[2]["id"], "claude");
        assert_eq!(rows[2]["state"], "connected");
        assert_eq!(rows[3]["id"], "cursor");
        assert_eq!(rows[3]["state"], "notDetected");
    }

    #[test]
    fn passive_detection_supports_dynamic_loopback_ports_with_easyproxy_markers() {
        let temp = TestDir::new("epx-tray-clients-dyn");
        let home = temp.path();

        fs::create_dir_all(home.join(".antigravity")).unwrap();
        fs::write(
            home.join(".antigravity").join("settings.json"),
            r#"{"gateway":{"enabled":true,"url":"http://127.0.0.1:19090","apiKey":"epx_data_0123456789abcdef"}}"#,
        )
        .unwrap();

        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(
            home.join(".claude").join("settings.json"),
            r#"{"env":{"ANTHROPIC_BASE_URL":"http://localhost:24567","ANTHROPIC_AUTH_TOKEN":"epx_data_abcdef"}}"#,
        )
        .unwrap();

        fs::create_dir_all(home.join(".cursor")).unwrap();
        fs::write(
            home.join(".cursor").join("mcp.json"),
            r#"{"overrideOpenAiBaseUrl":"http://127.0.0.1:29999/v1","apiKey":"epx_data_cursor"}"#,
        )
        .unwrap();

        let rows = detect_local_clients(Some(home), None, None);
        assert_eq!(rows[1]["state"], "connected");
        assert_eq!(rows[2]["state"], "connected");
        assert_eq!(rows[3]["state"], "connected");
    }

    #[test]
    fn rejects_cursor_path_and_disabled_antigravity_and_drifted_server_false_positives() {
        let temp = TestDir::new("epx-tray-clients-fp");
        let home = temp.path();

        fs::create_dir_all(home.join(".antigravity")).unwrap();
        fs::write(
            home.join(".antigravity").join("settings.json"),
            r#"{"gateway":{"enabled":false,"url":"http://127.0.0.1:10100","apiKey":"epx_data_0123456789abcdef"}}"#,
        )
        .unwrap();

        fs::create_dir_all(home.join(".cursor")).unwrap();
        fs::write(
            home.join(".cursor").join("cli-config.json"),
            r#"{"recentFolders":["/Volumes/MACSSD/Projects/GitProjects/easyproxy"],"mcpServers":{"local":{"url":"http://localhost:3000/v1"}}}"#,
        )
        .unwrap();

        let rows = detect_local_clients(Some(home), None, None);
        assert_eq!(rows[1]["id"], "antigravity");
        assert_eq!(rows[1]["installed"], true);
        assert_eq!(rows[1]["connected"], false);
        assert_eq!(rows[1]["state"], "detected");

        assert_eq!(rows[3]["id"], "cursor");
        assert_eq!(rows[3]["installed"], true);
        assert_eq!(rows[3]["connected"], false);
        assert_eq!(rows[3]["state"], "detected");

        let native = json!({
            "clients": [
                {
                    "clientId": "codex",
                    "installed": false,
                    "desiredEnabled": true,
                    "state": "current"
                },
                {
                    "clientId": "claude",
                    "installed": true,
                    "desiredEnabled": true,
                    "state": "drifted"
                }
            ]
        });
        let server_rows = detect_local_clients(None, None, Some(&native));
        assert_eq!(server_rows[0]["id"], "codex");
        assert_eq!(server_rows[0]["installed"], false);
        assert_eq!(server_rows[0]["connected"], false);
        assert_eq!(server_rows[0]["state"], "notDetected");

        assert_eq!(server_rows[2]["id"], "claude");
        assert_eq!(server_rows[2]["installed"], true);
        assert_eq!(server_rows[2]["connected"], false);
        assert_eq!(server_rows[2]["state"], "detected");
    }

    #[test]
    fn cursor_supports_jsonc_and_placeholder_key_while_rejecting_query_spoofing_and_disabled_override() {
        let temp = TestDir::new("epx-tray-clients-jsonc");
        let home = temp.path();

        let cursor_settings = home
            .join("Library")
            .join("Application Support")
            .join("Cursor")
            .join("User")
            .join("settings.json");
        fs::create_dir_all(cursor_settings.parent().unwrap()).unwrap();
        fs::write(
            &cursor_settings,
            "{\n  // Cursor User settings with comment & trailing comma\n  /* block comment */\n  \"cursor.openAiBaseUrl\": \"http://127.0.0.1:24567/v1\",\n  \"cursor.openAiApiKey\": \"easyproxy-local\",\n}\n",
        )
        .unwrap();
        let ok_rows = detect_local_clients(Some(home), None, None);
        assert_eq!(ok_rows[3]["id"], "cursor");
        assert_eq!(ok_rows[3]["connected"], true);
        assert_eq!(ok_rows[3]["state"], "connected");

        // Disabled override boolean must stay detected, not connected.
        fs::write(
            &cursor_settings,
            r#"{"overrideOpenAiBaseUrl":false,"openai.baseUrl":"http://127.0.0.1:10100/v1"}"#,
        )
        .unwrap();
        let disabled_rows = detect_local_clients(Some(home), None, None);
        assert_eq!(disabled_rows[3]["connected"], false);
        assert_eq!(disabled_rows[3]["state"], "detected");

        // Query-string loopback URL must not spoof an EasyProxy gateway origin.
        fs::write(
            &cursor_settings,
            r#"{"openai.baseUrl":"https://evil.example/v1?redirect=http://127.0.0.1:10100"}"#,
        )
        .unwrap();
        fs::create_dir_all(home.join(".antigravity")).unwrap();
        fs::write(
            home.join(".antigravity").join("settings.json"),
            r#"{"gateway":{"enabled":true,"url":"https://evil.example/proxy?next=http://127.0.0.1:10100","apiKey":"epx_data_0123456789abcdef"}}"#,
        )
        .unwrap();
        let spoof_rows = detect_local_clients(Some(home), None, None);
        assert_eq!(spoof_rows[1]["connected"], false);
        assert_eq!(spoof_rows[1]["state"], "detected");
        assert_eq!(spoof_rows[3]["connected"], false);
        assert_eq!(spoof_rows[3]["state"], "detected");
    }
}
