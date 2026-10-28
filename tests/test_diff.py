from __future__ import annotations

import pytest

from telegram_api_diff.diff import compare_schemas
from telegram_api_diff.report import render_report
from telegram_api_diff.schema import (
    SchemaError,
    canonicalize_schema,
    parse_api_layer,
    schema_to_json,
)


def test_canonicalization_ignores_declaration_order() -> None:
    first = {
        "layer": 1,
        "constructors": [
            {"predicate": "zeta", "id": "02", "params": [], "type": "Z"},
            {"predicate": "alpha", "id": "01", "params": [], "type": "A"},
        ],
        "methods": [{"method": "getFoo", "id": "03", "params": [], "type": "Foo"}],
    }
    second = {
        "layer": 1,
        "constructors": list(reversed(first["constructors"])),
        "methods": first["methods"],
    }

    assert schema_to_json(first) == schema_to_json(second)
    assert not compare_schemas(first, second).has_changes


def test_compare_detects_added_removed_changed_and_layer() -> None:
    previous = {
        "layer": 220,
        "constructors": [
            {"predicate": "oldItem", "id": "01", "params": [], "type": "Item"},
            {"predicate": "changedItem", "id": "02", "params": [], "type": "Item"},
        ],
        "methods": [{"method": "oldMethod", "id": "03", "params": [], "type": "Bool"}],
    }
    current = {
        "layer": 221,
        "constructors": [
            {"predicate": "newItem", "id": "04", "params": [], "type": "Item"},
            {
                "predicate": "changedItem",
                "id": "02",
                "params": [{"name": "flags", "type": "#"}],
                "type": "Item",
            },
        ],
        "methods": [],
    }

    diff = compare_schemas(previous, current)

    assert diff.has_changes
    assert diff.previous_layer == 220
    assert diff.current_layer == 221
    assert {(item.collection, item.name) for item in diff.added} == {
        ("constructors", "newItem")
    }
    assert {(item.collection, item.name) for item in diff.removed} == {
        ("constructors", "oldItem"),
        ("methods", "oldMethod"),
    }
    assert [(item.collection, item.name) for item in diff.changed] == [
        ("constructors", "changedItem")
    ]


def test_report_includes_layer_and_modified_signature() -> None:
    before = {
        "layer": 10,
        "constructors": [
            {"predicate": "sample", "id": "aa", "params": [], "type": "Sample"}
        ],
        "methods": [],
    }
    after = {
        "layer": 11,
        "constructors": [
            {
                "predicate": "sample",
                "id": "aa",
                "params": [{"name": "id", "type": "long"}],
                "type": "Sample",
            }
        ],
        "methods": [],
    }

    report = render_report(
        compare_schemas(before, after),
        "2026-10-29T04:17:00Z",
        "https://core.telegram.org/schema/json",
    )

    assert "# Telegram MTProto schema changes" in report
    assert "10 → 11" in report
    assert "Modified declarations" in report
    assert "id:long" in report


def test_canonicalize_rejects_error_documents_and_empty_schemas() -> None:
    with pytest.raises(SchemaError):
        canonicalize_schema({"message": "not found"})
    with pytest.raises(SchemaError):
        canonicalize_schema({"constructors": [], "methods": []})


def test_extra_top_level_metadata_is_tracked() -> None:
    before = {"layer": 1, "constructors": [{"predicate": "x"}], "methods": [], "version": 1}
    after = {"layer": 1, "constructors": [{"predicate": "x"}], "methods": [], "version": 2}

    diff = compare_schemas(before, after)

    assert diff.has_changes
    assert diff.metadata_changes == ["version"]



def test_parse_api_layer_from_official_page() -> None:
    text = chr(10).join(["# Actual TL-scheme", "* Layer 225", "* 1 - Base layer"])
    assert parse_api_layer(text) == 225
