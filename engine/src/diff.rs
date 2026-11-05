//! Structured comparison of two canonical Telegram TL schema documents.

use crate::schema::{SCHEMA_COLLECTIONS, SchemaError, canonicalize_schema};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq)]
pub struct RecordChange {
    pub collection: String,
    pub name: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SchemaDiff {
    pub added: Vec<RecordChange>,
    pub removed: Vec<RecordChange>,
    pub changed: Vec<RecordChange>,
    pub metadata_changes: Vec<String>,
    pub previous_layer: Value,
    pub current_layer: Value,
}

impl SchemaDiff {
    pub fn has_changes(&self) -> bool {
        !self.added.is_empty()
            || !self.removed.is_empty()
            || !self.changed.is_empty()
            || !self.metadata_changes.is_empty()
            || self.previous_layer != self.current_layer
    }
}

fn identity(record: &Value, collection: &str, index: usize) -> String {
    let preferred = if collection == "methods" {
        "method"
    } else {
        "predicate"
    };

    record
        .as_object()
        .and_then(|object| {
            [preferred, "name", "id"]
                .iter()
                .filter_map(|key| object.get(*key))
                .find(|value| !value.is_null() && *value != "")
        })
        .map(|value| match value {
            Value::String(value) => value.clone(),
            _ => value.to_string(),
        })
        .unwrap_or_else(|| format!("<unnamed-{}>", index + 1))
}

fn record_map(schema: &Value, collection: &str) -> BTreeMap<String, Value> {
    let Some(records) = schema.get(collection).and_then(Value::as_array) else {
        return BTreeMap::new();
    };

    let mut mapped = BTreeMap::new();
    for (index, record) in records.iter().enumerate() {
        if !record.is_object() {
            continue;
        }

        let mut name = identity(record, collection, index);
        if mapped.contains_key(&name) {
            name = format!("{name} [duplicate {}]", index + 1);
        }
        mapped.insert(name, record.clone());
    }
    mapped
}

fn layer(schema: &Value) -> Value {
    schema
        .get("layer")
        .cloned()
        .unwrap_or_else(|| Value::String("unknown".into()))
}

fn change(
    collection: &str,
    name: String,
    before: Option<Value>,
    after: Option<Value>,
) -> RecordChange {
    RecordChange {
        collection: collection.to_owned(),
        name,
        before,
        after,
    }
}

/// Compare declaration records and top-level metadata in two schema documents.
pub fn compare_schemas(previous: &Value, current: &Value) -> Result<SchemaDiff, SchemaError> {
    let old = canonicalize_schema(previous)?;
    let new = canonicalize_schema(current)?;

    let mut result = SchemaDiff {
        added: Vec::new(),
        removed: Vec::new(),
        changed: Vec::new(),
        metadata_changes: Vec::new(),
        previous_layer: layer(&old),
        current_layer: layer(&new),
    };

    for collection in SCHEMA_COLLECTIONS {
        let old_records = record_map(&old, collection);
        let new_records = record_map(&new, collection);

        for name in new_records
            .keys()
            .filter(|name| !old_records.contains_key(*name))
        {
            result.added.push(change(
                collection,
                name.clone(),
                None,
                new_records.get(name).cloned(),
            ));
        }

        for name in old_records
            .keys()
            .filter(|name| !new_records.contains_key(*name))
        {
            result.removed.push(change(
                collection,
                name.clone(),
                old_records.get(name).cloned(),
                None,
            ));
        }

        for name in old_records
            .keys()
            .filter(|name| new_records.contains_key(*name))
        {
            let before = old_records.get(name).cloned();
            let after = new_records.get(name).cloned();
            if before != after {
                result
                    .changed
                    .push(change(collection, name.clone(), before, after));
            }
        }
    }

    let ignored: BTreeSet<&str> = SCHEMA_COLLECTIONS.into_iter().chain(["layer"]).collect();
    let old_keys: BTreeSet<&str> = old
        .as_object()
        .into_iter()
        .flat_map(|map| map.keys().map(String::as_str))
        .collect();
    let new_keys: BTreeSet<&str> = new
        .as_object()
        .into_iter()
        .flat_map(|map| map.keys().map(String::as_str))
        .collect();

    for key in old_keys.union(&new_keys) {
        if ignored.contains(key) {
            continue;
        }
        if old.get(*key) != new.get(*key) {
            result.metadata_changes.push((*key).to_owned());
        }
    }

    Ok(result)
}

/// Return declaration counts for all known collections present in the schema.
pub fn schema_counts(schema: &Value) -> Result<BTreeMap<String, usize>, SchemaError> {
    let normalized = canonicalize_schema(schema)?;
    let mut counts = BTreeMap::new();

    for collection in SCHEMA_COLLECTIONS {
        if let Some(records) = normalized.get(collection).and_then(Value::as_array) {
            counts.insert(collection.to_owned(), records.len());
        }
    }

    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(layer: u64, constructors: Value, methods: Value) -> Value {
        serde_json::json!({
            "layer": layer,
            "constructors": constructors,
            "methods": methods
        })
    }

    #[test]
    fn detects_added_removed_modified_and_layer_changes() {
        let before = schema(
            220,
            serde_json::json!([
                {"predicate": "removed", "id": "01", "params": [], "type": "Item"},
                {"predicate": "updated", "id": "02", "params": [], "type": "Item"}
            ]),
            serde_json::json!([{"method": "oldMethod", "id": "03"}]),
        );
        let after = schema(
            221,
            serde_json::json!([
                {"predicate": "added", "id": "04", "params": [], "type": "Item"},
                {"predicate": "updated", "id": "02", "params": [{"name": "id", "type": "long"}], "type": "Item"}
            ]),
            serde_json::json!([]),
        );

        let diff = compare_schemas(&before, &after).unwrap();

        assert!(diff.has_changes());
        assert_eq!(diff.previous_layer, 220);
        assert_eq!(diff.current_layer, 221);
        assert_eq!(diff.added.len(), 1);
        assert_eq!(diff.added[0].name, "added");
        assert_eq!(diff.removed.len(), 2);
        assert_eq!(diff.changed.len(), 1);
        assert_eq!(diff.changed[0].name, "updated");
    }

    #[test]
    fn ignores_declaration_order() {
        let first = schema(
            1,
            serde_json::json!([
                {"predicate": "zeta"},
                {"predicate": "alpha"}
            ]),
            serde_json::json!([{"method": "getFoo"}]),
        );
        let second = schema(
            1,
            serde_json::json!([
                {"predicate": "alpha"},
                {"predicate": "zeta"}
            ]),
            serde_json::json!([{"method": "getFoo"}]),
        );

        assert!(!compare_schemas(&first, &second).unwrap().has_changes());
    }

    #[test]
    fn detects_other_top_level_metadata() {
        let before = serde_json::json!({
            "layer": 1,
            "constructors": [{"predicate": "x"}],
            "methods": [],
            "version": 1
        });
        let after = serde_json::json!({
            "layer": 1,
            "constructors": [{"predicate": "x"}],
            "methods": [],
            "version": 2
        });

        let diff = compare_schemas(&before, &after).unwrap();
        assert_eq!(diff.metadata_changes, vec!["version"]);
    }

    #[test]
    fn unchanged_schemas_have_no_changes() {
        let input = schema(
            225,
            serde_json::json!([{"predicate": "sample"}]),
            serde_json::json!([]),
        );

        assert!(!compare_schemas(&input, &input).unwrap().has_changes());
    }
}
