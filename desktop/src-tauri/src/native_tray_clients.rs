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

fn has_loopback_port_url(lower: &str) -> bool {
    const PREFIXES: [&str; 6] = [
        "http://127.0.0.1:",
        "https://127.0.0.1:",
        "http://localhost:",
        "https://localhost:",
        "http://[::1]:",
        "https://[::1]:",
    ];
    for prefix in PREFIXES {
        let mut search_from = 0usize;
        while let Some(offset) = lower[search_from..].find(prefix) {
            let after_colon = search_from + offset + prefix.len();
            let rest = lower[after_colon..].as_bytes();
            let digit_count = rest.iter().take_while(|b| b.is_ascii_digit()).count();
            if digit_count > 0 && digit_count <= 5 {
                if let Ok(port) = lower[after_colon..after_colon + digit_count].parse::<u32>() {
                    if (1..=65535).contains(&port) {
                        let next_byte = rest.get(digit_count).copied();
                        if next_byte.is_none_or(|b| {
                            matches!(
                                b,
                                b'/' | b'?' | b'#' | b'"' | b'\'' | b' ' | b'\t' | b'\r' | b'\n' | b',' | b'}'
                            )
                        }) {
                            return true;
                        }
                    }
                }
            }
            search_from = after_colon;
        }
    }
    false
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
    let connected =
        row["desiredEnabled"].as_bool() == Some(true) || row["state"].as_str() == Some("current");
    Some((installed || connected, connected))
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
            if has_easyproxy_marker(&content) && content.contains("gateway") {
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
                let lower = content.to_ascii_lowercase();
                if has_easyproxy_marker(&content)
                    && (content.contains("overrideOpenAiBaseUrl")
                        || lower.contains("easyproxy-loopback")
                        || lower.contains("easyproxy")
                        || has_easyproxy_key_prefix(&lower))
                {
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
            r#"{"overrideOpenAiBaseUrl":"http://127.0.0.1:29999/v1","apiKey":"epx_data_cursor"}}"#,
        )
        .unwrap();

        let rows = detect_local_clients(Some(home), None, None);
        assert_eq!(rows[1]["state"], "connected");
        assert_eq!(rows[2]["state"], "connected");
        assert_eq!(rows[3]["state"], "connected");
    }
}
