//! Rust core for Telegram API Diff.
//!
//! The crate deliberately keeps the JSON snapshot format compatible with the
//! existing Python implementation and the JavaScript dashboard.

pub mod diff;
pub mod schema;

pub use diff::{compare_schemas, schema_counts, RecordChange, SchemaDiff};
pub use schema::{canonicalize_schema, SchemaError, SCHEMA_COLLECTIONS};
