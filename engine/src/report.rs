//! Human-readable Markdown reports for schema changes.

use crate::diff::{RecordChange, SchemaDiff, schema_counts};
use serde_json::Value;

fn name(record: &Value, collection: &str) -> String {
    let key = if collection == "methods" { "method" } else { "predicate" };
    record.get(key)
        .or_else(|| record.get("name"))
        .or_else(|| record.get("id"))
        .map(|value| value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string()))
        .unwrap_or_else(|| "unknown".to_owned())
}

fn signature(record: &Value, collection: &str) -> String {
    let mut result = name(record, collection);
    if let Some(id) = record.get("id").filter(|value| !value.is_null() && *value != "") {
        result.push('#');
        result.push_str(&id.to_string().trim_matches('"'));
    }
    if let Some(params) = record.get("params").and_then(Value::as_array) {
        let values: Vec<String> = params.iter().take(8).map(|param| {
            let param_name = param.get("name").and_then(Value::as_str).unwrap_or("?");
            let param_type = param.get("type").and_then(Value::as_str).unwrap_or("?");
            format!("{param_name}:{param_type}")
        }).collect();
        if !values.is_empty() {
            result.push(' ');
            result.push_str(&values.join(" "));
        }
        if params.len() > 8 {
            result.push_str(&format!(" ... +{} more", params.len() - 8));
        }
    }
    if let Some(kind) = record.get("type").and_then(Value::as_str) {
        result.push_str(" = ");
        result.push_str(kind);
    }
    result
}

fn section(lines: &mut Vec<String>, title: &str, entries: &[RecordChange], before: bool) {
    if entries.is_empty() {
        return;
    }
    lines.extend([String::new(), format!("## {title}"), String::new()]);
    for entry in entries.iter().take(100) {
        lines.push(format!("- **{}: {}**", entry.collection, entry.name));
        let record = if before {
            entry.before.as_ref().or(entry.after.as_ref())
        } else {
            entry.after.as_ref().or(entry.before.as_ref())
        };
        if let Some(record) = record {
            lines.push(format!("  - {}", signature(record, &entry.collection)));
        }
        if let (Some(old), Some(new)) = (&entry.before, &entry.after) {
            lines.push(format!("  - Before: {}", signature(old, &entry.collection)));
            lines.push(format!("  - After: {}", signature(new, &entry.collection)));
            if let (Some(old_params), Some(new_params)) = (
                old.get("params").and_then(Value::as_array),
                new.get("params").and_then(Value::as_array),
            ) {
                for old_param in old_params {
                    let old_name = old_param.get("name").and_then(Value::as_str).unwrap_or("?");
                    if !new_params.iter().any(|p| p.get("name").and_then(Value::as_str) == Some(old_name)) {
                        lines.push(format!("  - Parameter removed: {}: {}", old_name, old_param.get("type").and_then(Value::as_str).unwrap_or("?")));
                    }
                }
                for new_param in new_params {
                    let new_name = new_param.get("name").and_then(Value::as_str).unwrap_or("?");
                    if !old_params.iter().any(|p| p.get("name").and_then(Value::as_str) == Some(new_name)) {
                        lines.push(format!("  - Parameter added: {}: {}", new_name, new_param.get("type").and_then(Value::as_str).unwrap_or("?")));
                    }
                }
            }
        }
    }
    if entries.len() > 100 {
        lines.push(format!("- ... {} more entries omitted.", entries.len() - 100));
    }
}

/// Render the report created when the first schema baseline is stored.
pub fn render_baseline_report(
    schema: &Value,
    checked_at: &str,
    source_url: &str,
) -> Result<String, crate::schema::SchemaError> {
    let counts = schema_counts(schema)?;
    let layer = schema.get("layer").map(Value::to_string).unwrap_or_else(|| "unknown".into());
    let mut lines = vec![
        "# Telegram MTProto schema baseline".to_owned(),
        String::new(),
        "This is the first snapshot. No historical comparison is available yet.".to_owned(),
        String::new(),
        format!("- Checked at (UTC): {checked_at}"),
        format!("- Source: [{source_url}]({source_url})"),
        format!("- API layer: {layer}"),
        String::new(),
        "## Inventory".to_owned(),
        String::new(),
    ];
    for collection in ["constructors", "methods", "types"] {
        if let Some(count) = counts.get(collection) {
            lines.push(format!("- {}: **{count}**", collection.replace('_', " ").to_uppercase()));
        }
    }
    lines.push(String::new());
    lines.push("The next successful run will compare this baseline with Telegram's published schema.".into());
    lines.push(String::new());
    Ok(lines.join("\n"))
}

/// Render a Markdown report for a detected schema update.
pub fn render_report(diff: &SchemaDiff, checked_at: &str, source_url: &str) -> String {
    let mut lines = vec![
        "# Telegram MTProto schema changes".to_owned(),
        String::new(),
        format!("- Checked at (UTC): {checked_at}"),
        format!("- Source: [{source_url}]({source_url})"),
        format!("- API layer: {} → {}", diff.previous_layer, diff.current_layer),
        String::new(),
        "## Summary".to_owned(),
        String::new(),
        format!("- Added declarations: **{}**", diff.added.len()),
        format!("- Removed declarations: **{}**", diff.removed.len()),
        format!("- Modified declarations: **{}**", diff.changed.len()),
        format!("- Other metadata changes: **{}**", diff.metadata_changes.len()),
    ];

    if !diff.has_changes() {
        lines.extend([String::new(), "No schema changes were detected.".to_owned()]);
        return lines.join("\n") + "\n";
    }

    section(&mut lines, "Added declarations", &diff.added, false);
    section(&mut lines, "Removed declarations", &diff.removed, true);
    section(&mut lines, "Modified declarations", &diff.changed, false);

    if !diff.metadata_changes.is_empty() {
        lines.extend([String::new(), "## Other metadata changes".into(), String::new()]);
        for key in diff.metadata_changes.iter().take(100) {
            lines.push(format!("- {key} changed."));
        }
    }
    lines.extend([
        String::new(),
        "---".to_owned(),
        String::new(),
        "Generated automatically by Telegram API Diff.".to_owned(),
        String::new(),
    ]);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::compare_schemas;

    #[test]
    fn baseline_report_contains_inventory() {
        let schema = serde_json::json!({
            "layer": 225,
            "constructors": [{"predicate": "sample"}],
            "methods": []
        });
        let report = render_baseline_report(
            &schema,
            "2026-11-06T04:17:00Z",
            "https://core.telegram.org/schema/json",
        ).unwrap();
        assert!(report.contains("# Telegram MTProto schema baseline"));
        assert!(report.contains("API layer: 225"));
        assert!(report.contains("CONSTRUCTORS: **1**"));
    }

    #[test]
    fn report_includes_parameter_level_changes() {
        let before = serde_json::json!({
            "layer": 10,
            "constructors": [{
                "predicate": "sample",
                "id": "aa",
                "params": [{"name": "old_id", "type": "int"}],
                "type": "Sample"
            }],
            "methods": []
        });
        let after = serde_json::json!({
            "layer": 11,
            "constructors": [{
                "predicate": "sample",
                "id": "aa",
                "params": [
                    {"name": "new_id", "type": "long"},
                    {"name": "flags", "type": "#"}
                ],
                "type": "Sample"
            }],
            "methods": []
        });
        let diff = compare_schemas(&before, &after).unwrap();
        let report = render_report(&diff, "2026-11-06T04:17:00Z", "https://example.invalid/schema");
        assert!(report.contains("Parameter added: flags: #"));
        assert!(report.contains("Parameter added: new_id: long"));
        assert!(report.contains("Parameter removed: old_id: int"));
    }
}
