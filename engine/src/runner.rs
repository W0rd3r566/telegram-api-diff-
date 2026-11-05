//! Network, filesystem, and GitHub Actions integration for the Rust tracker.

use crate::diff::{compare_schemas, schema_counts};
use crate::report::{render_baseline_report, render_report};
use crate::schema::{SchemaError, canonicalize_schema};
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use reqwest::blocking::{Client, Response};
use serde_json::{Value, json};
use std::env;
use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

pub const SCHEMA_URL: &str = "https://core.telegram.org/schema/json";
const SCHEMA_LAYER_URL: &str = "https://core.telegram.org/scheme";
const MAX_SCHEMA_BYTES: usize = 64 * 1024 * 1024;
const MAX_LAYER_BYTES: usize = 512 * 1024;
const USER_AGENT: &str = "telegram-api-diff/0.2 (+https://github.com/W0rd3r566/telegram-api-diff-)";

fn invalid_data(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
}

fn read_limited(response: Response, limit: usize, label: &str) -> Result<Vec<u8>, Box<dyn Error>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(invalid_data(format!(
            "{label} response exceeds the {limit}-byte safety limit."
        ))
        .into());
    }

    let mut bytes = Vec::new();
    response.take((limit + 1) as u64).read_to_end(&mut bytes)?;

    if bytes.len() > limit {
        return Err(invalid_data(format!(
            "{label} response exceeds the {limit}-byte safety limit."
        ))
        .into());
    }

    Ok(bytes)
}

fn fetch_bytes(
    client: &Client,
    url: &str,
    limit: usize,
    accept: &str,
    label: &str,
) -> Result<Vec<u8>, Box<dyn Error>> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, accept)
        .send()?
        .error_for_status()?;
    read_limited(response, limit, label)
}

/// Extract the current API layer from Telegram's public schema timeline.
pub fn parse_api_layer(text: &str) -> Result<u64, SchemaError> {
    let primary = Regex::new(r"(?im)^\s*(?:[-*+]\s*)?Layer\s+(\d+)\b")
        .expect("constant layer regex is valid");
    let fallback = Regex::new(r"(?i)\bLayer\s+(\d+)\b").expect("constant fallback regex is valid");

    primary
        .captures(text)
        .or_else(|| fallback.captures(text))
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<u64>().ok())
        .ok_or_else(|| {
            SchemaError(
                "The official schema timeline did not contain a recognizable API layer.".into(),
            )
        })
}

/// Download and validate Telegram's machine-readable TL schema.
pub fn fetch_schema(url: &str, timeout_seconds: f64) -> Result<Value, Box<dyn Error>> {
    if !timeout_seconds.is_finite() || timeout_seconds <= 0.0 {
        return Err(invalid_data("Timeout must be a positive finite number.").into());
    }
    let timeout = Duration::try_from_secs_f64(timeout_seconds)
        .map_err(|_| invalid_data("Timeout is outside the supported range."))?;

    let client = Client::builder()
        .timeout(timeout)
        .user_agent(USER_AGENT)
        .build()?;

    let raw = fetch_bytes(&client, url, MAX_SCHEMA_BYTES, "application/json", "Schema")?;
    let text = std::str::from_utf8(&raw)?;
    let payload: Value = serde_json::from_str(text).map_err(|error| {
        invalid_data(format!(
            "Schema endpoint did not return valid JSON: {error}"
        ))
    })?;
    let mut normalized = canonicalize_schema(&payload)?;

    if url == SCHEMA_URL {
        let layer_raw = fetch_bytes(
            &client,
            SCHEMA_LAYER_URL,
            MAX_LAYER_BYTES,
            "text/html, text/plain, */*",
            "Layer timeline",
        )?;
        let layer_text = std::str::from_utf8(&layer_raw)?;
        normalized["layer"] = json!(parse_api_layer(layer_text)?);
    }

    Ok(normalized)
}

fn timestamp() -> (String, String) {
    let now = Utc::now();
    (
        now.to_rfc3339_opts(SecondsFormat::Secs, true),
        now.format("%Y-%m-%d").to_string(),
    )
}

fn atomic_write(path: &Path, content: &str) -> Result<(), Box<dyn Error>> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "snapshot".to_owned());
    let temporary = parent.join(format!("{file_name}.tmp"));

    let result = (|| -> Result<(), Box<dyn Error>> {
        let mut file = File::create(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();

    if result.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }

    result
}

fn load_schema(path: &Path) -> Result<Value, Box<dyn Error>> {
    let content = fs::read_to_string(path)?;
    let payload: Value = serde_json::from_str(&content)
        .map_err(|error| invalid_data(format!("Stored snapshot is invalid JSON: {error}")))?;
    Ok(canonicalize_schema(&payload)?)
}

fn serialize_schema(schema: &Value) -> Result<String, Box<dyn Error>> {
    let normalized = canonicalize_schema(schema)?;
    Ok(serde_json::to_string_pretty(&normalized)? + "\n")
}

fn write_github_outputs(values: &[(&str, String)]) -> Result<(), Box<dyn Error>> {
    let Ok(output_path) = env::var("GITHUB_OUTPUT") else {
        return Ok(());
    };

    let mut output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(output_path)?;

    for (key, value) in values {
        if value.contains('\n') || value.contains('\r') {
            return Err(invalid_data(format!(
                "GitHub Actions output {key:?} must be a single line."
            ))
            .into());
        }
        writeln!(output, "{key}={value}")?;
    }

    Ok(())
}

fn print_summary(schema: &Value) -> Result<(), Box<dyn Error>> {
    let counts = schema_counts(schema)?;
    let inventory = counts
        .iter()
        .map(|(name, count)| format!("{name}={count}"))
        .collect::<Vec<_>>()
        .join(", ");
    let layer = schema
        .get("layer")
        .map(Value::to_string)
        .unwrap_or_else(|| "unknown".to_owned());
    println!("API layer: {layer}; {inventory}");
    Ok(())
}

/// Fetch, compare, and persist a dated schema snapshot and Markdown report.
pub fn command_update(
    root: &Path,
    schema_url: &str,
    timeout_seconds: f64,
) -> Result<i32, Box<dyn Error>> {
    let current = fetch_schema(schema_url, timeout_seconds)?;
    let (checked_at, date) = timestamp();

    let latest_snapshot = root.join("snapshots/latest.json");
    let dated_snapshot = root.join(format!("snapshots/{date}.json"));
    let dated_report = root.join(format!("reports/{date}.md"));
    let latest_report = root.join("reports/latest.md");

    let (diff, previous_layer, report) = if latest_snapshot.exists() {
        let previous = load_schema(&latest_snapshot)?;
        let diff = compare_schemas(&previous, &current)?;
        let previous_layer = diff.previous_layer.to_string();

        if !diff.has_changes() {
            println!("No schema changes detected; recording today's check.");
        } else {
            println!(
                "Schema updated: +{} added, -{} removed, ~{} modified.",
                diff.added.len(),
                diff.removed.len(),
                diff.changed.len()
            );
        }

        let report = render_report(&diff, &checked_at, schema_url);
        (Some(diff), previous_layer, report)
    } else {
        println!("Created the first baseline; future runs can detect changes.");
        let report = render_baseline_report(&current, &checked_at, schema_url)?;
        (None, "unknown".to_owned(), report)
    };

    let serialized = serialize_schema(&current)?;
    atomic_write(&dated_snapshot, &serialized)?;
    atomic_write(&latest_snapshot, &serialized)?;
    atomic_write(&dated_report, &report)?;
    atomic_write(&latest_report, &report)?;

    let added = diff.as_ref().map_or(0, |value| value.added.len());
    let removed = diff.as_ref().map_or(0, |value| value.removed.len());
    let modified = diff.as_ref().map_or(0, |value| value.changed.len());
    let metadata = diff
        .as_ref()
        .map_or(0, |value| value.metadata_changes.len());
    let has_changes = diff.as_ref().is_some_and(|value| value.has_changes());

    write_github_outputs(&[
        ("has_changes", has_changes.to_string()),
        ("added_count", added.to_string()),
        ("removed_count", removed.to_string()),
        ("modified_count", modified.to_string()),
        ("metadata_count", metadata.to_string()),
        ("previous_layer", previous_layer),
        (
            "current_layer",
            current
                .get("layer")
                .map(Value::to_string)
                .unwrap_or_else(|| "unknown".to_owned()),
        ),
        (
            "report_url",
            "https://github.com/W0rd3r566/telegram-api-diff-/blob/main/reports/latest.md"
                .to_owned(),
        ),
    ])?;

    print_summary(&current)?;
    println!("Snapshot: {}", dated_snapshot.display());
    println!("Report:   {}", dated_report.display());
    Ok(0)
}

/// Compare the remote schema to the current baseline without writing files.
pub fn command_check(
    root: &Path,
    schema_url: &str,
    timeout_seconds: f64,
) -> Result<i32, Box<dyn Error>> {
    let latest_snapshot = root.join("snapshots/latest.json");
    if !latest_snapshot.exists() {
        eprintln!("No baseline exists yet. Run telegram-api-diff update first.");
        return Ok(2);
    }

    let previous = load_schema(&latest_snapshot)?;
    let current = fetch_schema(schema_url, timeout_seconds)?;
    let diff = compare_schemas(&previous, &current)?;

    if !diff.has_changes() {
        println!("No schema changes detected.");
        print_summary(&current)?;
        return Ok(0);
    }

    let (checked_at, _) = timestamp();
    print!("{}", render_report(&diff, &checked_at, schema_url));
    eprintln!("Changes detected. Run telegram-api-diff update to save the snapshot.");
    Ok(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_layer_from_timeline_bullet() {
        assert_eq!(parse_api_layer("# TL scheme\n* Layer 225\n").unwrap(), 225);
    }

    #[test]
    fn parses_layer_from_inline_text() {
        assert_eq!(parse_api_layer("Current release: Layer 226").unwrap(), 226);
    }

    #[test]
    fn rejects_timeline_without_layer() {
        assert!(parse_api_layer("No layer here").is_err());
    }

    #[test]
    fn rejects_invalid_timeouts() {
        assert!(fetch_schema("https://example.invalid", 0.0).is_err());
        assert!(fetch_schema("https://example.invalid", f64::NAN).is_err());
    }

    #[test]
    fn writes_files_atomically_and_creates_parent_directories() {
        use std::path::PathBuf;

        let root: PathBuf =
            std::env::temp_dir().join(format!("telegram-api-diff-test-{}", std::process::id()));
        let path = root.join("snapshots").join("latest.json");
        atomic_write(&path, "{\"ok\": true}\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"ok\": true}\n");
        let _ = fs::remove_dir_all(root);
    }
}
