"""Structured schema comparison."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .schema import SCHEMA_COLLECTIONS, canonicalize_schema

Record = dict[str, Any]


@dataclass(frozen=True, slots=True)
class RecordChange:
    """An added, removed, or modified schema declaration."""

    collection: str
    name: str
    before: Record | None = None
    after: Record | None = None


@dataclass(slots=True)
class SchemaDiff:
    """All meaningful differences between two canonical schema documents."""

    added: list[RecordChange] = field(default_factory=list)
    removed: list[RecordChange] = field(default_factory=list)
    changed: list[RecordChange] = field(default_factory=list)
    metadata_changes: list[str] = field(default_factory=list)
    previous_layer: Any = None
    current_layer: Any = None

    @property
    def has_changes(self) -> bool:
        return bool(
            self.added
            or self.removed
            or self.changed
            or self.metadata_changes
            or self.previous_layer != self.current_layer
        )


def _identity(record: Any, collection: str, index: int) -> str:
    if isinstance(record, dict):
        preferred = "method" if collection == "methods" else "predicate"
        value = record.get(preferred) or record.get("name")
        if value is None:
            value = record.get("id")
        if value is not None:
            return str(value)
    return f"<unnamed-{index + 1}>"


def _record_map(schema: dict[str, Any], collection: str) -> dict[str, Record]:
    raw_records = schema.get(collection, [])
    if not isinstance(raw_records, list):
        return {}

    records: dict[str, Record] = {}
    for index, raw_record in enumerate(raw_records):
        if not isinstance(raw_record, dict):
            continue
        name = _identity(raw_record, collection, index)
        if name in records:
            name = f"{name} [duplicate {index + 1}]"
        records[name] = raw_record
    return records


def _stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def compare_schemas(previous: Any, current: Any) -> SchemaDiff:
    """Compare two schema documents, detecting declaration and metadata changes."""
    old = canonicalize_schema(previous)
    new = canonicalize_schema(current)
    result = SchemaDiff(
        previous_layer=old.get("layer", "unknown"),
        current_layer=new.get("layer", "unknown"),
    )

    for collection in SCHEMA_COLLECTIONS:
        old_records = _record_map(old, collection)
        new_records = _record_map(new, collection)

        for name in sorted(new_records.keys() - old_records.keys()):
            result.added.append(
                RecordChange(collection=collection, name=name, after=new_records[name])
            )
        for name in sorted(old_records.keys() - new_records.keys()):
            result.removed.append(
                RecordChange(collection=collection, name=name, before=old_records[name])
            )
        for name in sorted(old_records.keys() & new_records.keys()):
            before = old_records[name]
            after = new_records[name]
            if _stable(before) != _stable(after):
                result.changed.append(
                    RecordChange(
                        collection=collection,
                        name=name,
                        before=before,
                        after=after,
                    )
                )

    ignored_keys = set(SCHEMA_COLLECTIONS) | {"layer"}
    all_keys = (old.keys() | new.keys()) - ignored_keys
    result.metadata_changes = [
        key for key in sorted(all_keys) if _stable(old.get(key)) != _stable(new.get(key))
    ]
    return result


def schema_counts(schema: Any) -> dict[str, int]:
    """Return the number of declarations in each known collection."""
    normalized = canonicalize_schema(schema)
    return {
        collection: len(normalized.get(collection, []))
        for collection in SCHEMA_COLLECTIONS
        if collection in normalized and isinstance(normalized[collection], list)
    }
