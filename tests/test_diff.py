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



def test_update_records_daily_snapshot_and_report_when_unchanged(
    tmp_path, monkeypatch
) -> None:
    import json
    from argparse import Namespace

    from telegram_api_diff import cli

    current = {
        "layer": 225,
        "constructors": [{"predicate": "sample", "id": "1", "params": [], "type": "Sample"}],
        "methods": [],
    }
    latest = tmp_path / "snapshots" / "latest.json"
    latest.parent.mkdir(parents=True)
    latest.write_text(json.dumps(current), encoding="utf-8")

    monkeypatch.setattr(cli, "fetch_schema", lambda url, timeout: current)
    monkeypatch.setattr(
        cli, "_timestamp", lambda: ("2026-10-29T00:00:00Z", "2026-10-29")
    )
    args = Namespace(
        root=tmp_path,
        schema_url="https://core.telegram.org/schema/json",
        timeout=30.0,
    )

    assert cli.command_update(args) == 0
    assert (tmp_path / "snapshots" / "2026-10-29.json").is_file()
    assert (tmp_path / "reports" / "2026-10-29.md").is_file()
    assert (tmp_path / "reports" / "latest.md").is_file()
    assert "No schema changes were detected." in (
        tmp_path / "reports" / "latest.md"
    ).read_text(encoding="utf-8")



def test_canonicalize_rejects_missing_required_collections_and_malformed_records() -> None:
    with pytest.raises(SchemaError, match="required declaration arrays"):
        canonicalize_schema({"constructors": [{"predicate": "x"}]})
    with pytest.raises(SchemaError, match=r"constructors\[0\] is not a JSON object"):
        canonicalize_schema({"constructors": ["not-a-record"], "methods": []})
    with pytest.raises(SchemaError, match="no usable declaration name"):
        canonicalize_schema({"constructors": [{}], "methods": []})



def test_canonicalize_rejects_duplicate_declaration_names() -> None:
    duplicate = {"predicate": "same", "id": "01", "params": [], "type": "Item"}
    with pytest.raises(SchemaError, match="duplicate declaration name"):
        canonicalize_schema(
            {
                "constructors": [duplicate, dict(duplicate)],
                "methods": [],
            }
        )


def test_canonicalize_rejects_non_scalar_declaration_names() -> None:
    with pytest.raises(SchemaError, match="no usable declaration name"):
        canonicalize_schema(
            {
                "constructors": [{"predicate": {"unexpected": "object"}}],
                "methods": [],
            }
        )



def test_report_explains_parameter_level_changes() -> None:
    before = {
        "layer": 10,
        "constructors": [
            {
                "predicate": "sample",
                "id": "aa",
                "params": [{"name": "old_id", "type": "int"}],
                "type": "Sample",
            }
        ],
        "methods": [],
    }
    after = {
        "layer": 11,
        "constructors": [
            {
                "predicate": "sample",
                "id": "aa",
                "params": [
                    {"name": "new_id", "type": "long"},
                    {"name": "flags", "type": "#"},
                ],
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
    assert "Parameter added: " + chr(96) + "flags: #" + chr(96) in report
    assert "Parameter added: " + chr(96) + "new_id: long" + chr(96) in report
    assert "Parameter removed: " + chr(96) + "old_id: int" + chr(96) in report


def test_update_writes_github_actions_outputs(tmp_path, monkeypatch) -> None:
    import json
    from argparse import Namespace

    from telegram_api_diff import cli

    current = {
        "layer": 225,
        "constructors": [{"predicate": "sample", "id": "1", "params": [], "type": "Sample"}],
        "methods": [],
    }
    latest = tmp_path / "snapshots" / "latest.json"
    latest.parent.mkdir(parents=True)
    latest.write_text(json.dumps(current), encoding="utf-8")
    output = tmp_path / "github-output.txt"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(cli, "fetch_schema", lambda url, timeout: current)
    monkeypatch.setattr(cli, "_timestamp", lambda: ("2026-10-29T00:00:00Z", "2026-10-29"))

    assert cli.command_update(
        Namespace(
            root=tmp_path,
            schema_url="https://core.telegram.org/schema/json",
            timeout=30.0,
        )
    ) == 0

    values = dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines())
    assert values["has_changes"] == "false"
    assert values["added_count"] == "0"
    assert values["current_layer"] == "225"
