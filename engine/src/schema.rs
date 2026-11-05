//! Validation and deterministic canonicalization for Telegram TL schemas.

use serde_json::{Map, Value};
use std::collections::HashSet;
use std::error::Error;
use std::fmt;

pub const SCHEMA_COLLECTIONS: [&str; 3] = ["constructors", "methods", "types"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaError(pub String);

impl fmt::Display for SchemaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for SchemaError {}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.to_string() != "0" && value.to_string() != "0.0",
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn first_truthy<'a>(record: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|key| record.get(*key))
        .find(|value| is_truthy(value))
}

fn scalar_identity(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.trim().to_owned()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(_) | Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

fn sort_key(record: &Value) -> String {
    let identity = record
        .as_object()
        .and_then(|object| first_truthy(object, &["predicate", "method", "name"]))
        .map(|value| match value {
            Value::String(value) => value.clone(),
            _ => value.to_string(),
        })
        .unwrap_or_default();

    // serde_json serializes object keys deterministically (sorted by key).
    let serialized = serde_json::to_string(record).unwrap_or_default();
    format!("{identity}|{serialized}")
}

/// Validate a schema and return a clone with declaration arrays in stable order.
///
/// constructors and methods are required, while types is optional to retain
/// compatibility with snapshots produced by older Telegram responses.
pub fn canonicalize_schema(payload: &Value) -> Result<Value, SchemaError> {
    let object = payload
        .as_object()
        .ok_or_else(|| SchemaError("The schema response must be a JSON object.".into()))?;

    for collection in ["constructors", "methods"] {
        if !matches!(object.get(collection), Some(Value::Array(_))) {
            return Err(SchemaError(format!(
                "Schema is missing required declaration arrays: {collection}"
            )));
        }
    }

    let mut normalized = payload.clone();
    let mut declaration_count = 0usize;

    for collection in SCHEMA_COLLECTIONS {
        let Some(Value::Array(records)) = normalized.get(collection).cloned() else {
            continue;
        };

        declaration_count += records.len();
        let mut seen_names = HashSet::with_capacity(records.len());

        for (index, record) in records.iter().enumerate() {
            let record_object = record.as_object().ok_or_else(|| {
                SchemaError(format!("{collection}[{index}] is not a JSON object."))
            })?;

            let identity_key = if collection == "methods" {
                "method"
            } else {
                "predicate"
            };

            let identity = first_truthy(record_object, &[identity_key, "name", "id"])
                .and_then(scalar_identity)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| {
                    SchemaError(format!(
                        "{collection}[{index}] has no usable declaration name."
                    ))
                })?;

            if !seen_names.insert(identity.clone()) {
                return Err(SchemaError(format!(
                    "{collection} contains duplicate declaration name: {identity:?}."
                )));
            }
        }

        let mut sorted = records;
        sorted.sort_by_key(sort_key);
        normalized[collection] = Value::Array(sorted);
    }

    if declaration_count == 0 {
        return Err(SchemaError(
            "The schema contains no declarations; refusing to accept an empty schema.".into(),
        ));
    }

    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_schema() -> Value {
        serde_json::json!({
            "layer": 1,
            "constructors": [
                {"predicate": "zeta", "id": "02", "params": [], "type": "Z"},
                {"predicate": "alpha", "id": "01", "params": [], "type": "A"}
            ],
            "methods": [
                {"method": "getFoo", "id": "03", "params": [], "type": "Foo"}
            ]
        })
    }

    #[test]
    fn sorts_declarations_without_changing_records() {
        let canonical = canonicalize_schema(&minimal_schema()).unwrap();
        let constructors = canonical["constructors"].as_array().unwrap();
        assert_eq!(constructors[0]["predicate"], "alpha");
        assert_eq!(constructors[1]["predicate"], "zeta");
    }

    #[test]
    fn rejects_non_object_documents() {
        assert!(canonicalize_schema(&Value::Array(Vec::new())).is_err());
    }

    #[test]
    fn rejects_missing_required_collections() {
        let schema = serde_json::json!({"constructors": []});
        assert!(canonicalize_schema(&schema)
            .unwrap_err()
            .to_string()
            .contains("required declaration arrays"));
    }

    #[test]
    fn rejects_empty_schemas() {
        let schema = serde_json::json!({"constructors": [], "methods": []});
        assert!(canonicalize_schema(&schema)
            .unwrap_err()
            .to_string()
            .contains("no declarations"));
    }

    #[test]
    fn rejects_duplicate_names() {
        let schema = serde_json::json!({
            "constructors": [
                {"predicate": "same"},
                {"predicate": "same"}
            ],
            "methods": []
        });
        assert!(canonicalize_schema(&schema)
            .unwrap_err()
            .to_string()
            .contains("duplicate declaration name"));
    }

    #[test]
    fn rejects_non_scalar_names() {
        let schema = serde_json::json!({
            "constructors": [{"predicate": {"unexpected": "object"}}],
            "methods": []
        });
        assert!(canonicalize_schema(&schema)
            .unwrap_err()
            .to_string()
            .contains("no usable declaration name"));
    }
}
