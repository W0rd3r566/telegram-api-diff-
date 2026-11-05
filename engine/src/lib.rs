//! Rust core for Telegram API Diff.
//!
//! The crate deliberately keeps the JSON snapshot format compatible with the
//! existing Python implementation and the JavaScript dashboard.

pub mod diff;
pub mod normalize;
pub mod report;
pub mod runner;
pub mod schema;

pub use diff::{RecordChange, SchemaDiff, compare_schemas, schema_counts};
pub use normalize::{normalize_app_config_json, normalize_text};
pub use runner::{command_check, command_update, fetch_schema, parse_api_layer, SCHEMA_URL};
pub use schema::{SCHEMA_COLLECTIONS, SchemaError, canonicalize_schema};
