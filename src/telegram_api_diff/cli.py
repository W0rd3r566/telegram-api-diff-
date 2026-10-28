"""Command-line interface for Telegram API Diff."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .diff import compare_schemas, schema_counts
from .report import render_baseline_report, render_report
from .schema import SCHEMA_URL, SchemaError, canonicalize_schema, fetch_schema, schema_to_json


def _timestamp() -> tuple[str, str]:
    now = datetime.now(UTC).replace(microsecond=0)
    return now.isoformat().replace("+00:00", "Z"), now.strftime("%Y-%m-%d")


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text(content, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _load_schema(path: Path) -> dict[str, Any]:
    try:
        content = path.read_text(encoding="utf-8")
        schema = json.loads(content)
    except json.JSONDecodeError as exc:
        raise SchemaError(f"Stored snapshot is invalid JSON: {path}") from exc
    except OSError as exc:
        raise SchemaError(f"Could not read snapshot {path}: {exc}") from exc
    return canonicalize_schema(schema)


def _print_summary(schema: dict[str, Any]) -> None:
    counts = schema_counts(schema)
    inventory = ", ".join(f"{name}={count}" for name, count in counts.items())
    print(f"API layer: {schema.get('layer', 'unknown')}; {inventory}")


def command_update(args: argparse.Namespace) -> int:
    root: Path = args.root
    current = fetch_schema(args.schema_url, args.timeout)
    checked_at, date = _timestamp()
    latest_path = root / "snapshots" / "latest.json"
    dated_snapshot = root / "snapshots" / f"{date}.json"
    dated_report = root / "reports" / f"{date}.md"
    latest_report = root / "reports" / "latest.md"

    if latest_path.exists():
        previous = _load_schema(latest_path)
        diff = compare_schemas(previous, current)
        report = render_report(diff, checked_at, args.schema_url)
        if not diff.has_changes:
            print("No schema changes detected; recording today's check.")
        else:
            print(
                "Schema updated: "
                f"+{len(diff.added)} added, -{len(diff.removed)} removed, "
                f"~{len(diff.changed)} modified."
            )
    else:
        report = render_baseline_report(current, checked_at, args.schema_url)
        print("Created the first baseline; future runs can detect changes.")

    serialized = schema_to_json(current)
    _atomic_write(dated_snapshot, serialized)
    _atomic_write(latest_path, serialized)
    _atomic_write(dated_report, report)
    _atomic_write(latest_report, report)
    _print_summary(current)
    print(f"Snapshot: {dated_snapshot}")
    print(f"Report:   {dated_report}")
    return 0


def command_check(args: argparse.Namespace) -> int:
    root: Path = args.root
    latest_path = root / "snapshots" / "latest.json"
    if not latest_path.exists():
        print("No baseline exists yet. Run telegram-api-diff update first.", file=sys.stderr)
        return 2

    previous = _load_schema(latest_path)
    current = fetch_schema(args.schema_url, args.timeout)
    diff = compare_schemas(previous, current)
    if not diff.has_changes:
        print("No schema changes detected.")
        _print_summary(current)
        return 0

    checked_at, _ = _timestamp()
    print(render_report(diff, checked_at, args.schema_url), end="")
    print("Changes detected. Run telegram-api-diff update to save the snapshot.", file=sys.stderr)
    return 1


def _add_common_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("."),
        help="Directory containing snapshots/ and reports/ (default: current directory).",
    )
    parser.add_argument(
        "--schema-url",
        default=SCHEMA_URL,
        help=f"Machine-readable schema endpoint (default: {SCHEMA_URL}).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="HTTP request timeout in seconds (default: 30).",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="telegram-api-diff",
        description="Track changes in Telegram's official MTProto TL schema.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    update_parser = subparsers.add_parser("update", help="save a snapshot and report changes")
    _add_common_options(update_parser)
    update_parser.set_defaults(handler=command_update)

    check_parser = subparsers.add_parser("check", help="check for changes without writing files")
    _add_common_options(check_parser)
    check_parser.set_defaults(handler=command_check)

    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except (SchemaError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
