"""Human-readable Markdown change reports."""

from __future__ import annotations

from typing import Any

from .diff import RecordChange, SchemaDiff, schema_counts


MAX_ITEMS_PER_SECTION = 100


def _name(record: dict[str, Any], collection: str) -> str:
    if collection == "methods":
        return str(record.get("method") or record.get("name") or record.get("id") or "unknown")
    return str(record.get("predicate") or record.get("name") or record.get("id") or "unknown")


def _signature(record: dict[str, Any], collection: str) -> str:
    name = _name(record, collection)
    identifier = record.get("id")
    label = f"{name}#{identifier}" if identifier not in (None, "") else name

    params = record.get("params", [])
    if isinstance(params, list) and params:
        pieces: list[str] = []
        for param in params[:8]:
            if isinstance(param, dict):
                param_name = param.get("name", "?")
                param_type = param.get("type", "?")
                pieces.append(f"{param_name}:{param_type}")
            else:
                pieces.append(str(param))
        if len(params) > 8:
            pieces.append(f"... +{len(params) - 8} more")
        label += " " + " ".join(pieces)

    result_type = record.get("type")
    if result_type:
        label += f" = {result_type}"
    return label.replace(chr(96), "'")


def _collection_title(collection: str) -> str:
    return collection.replace("_", " ").title()


def _append_change_section(
    lines: list[str],
    title: str,
    records: list[RecordChange],
    *,
    side: str,
    show_before_after: bool = False,
) -> None:
    if not records:
        return
    lines.extend(["", f"## {title}", ""])
    shown = records[:MAX_ITEMS_PER_SECTION]
    for item in shown:
        record = item.after if side == "after" else item.before
        if record is None:
            record = item.after or item.before or {}
        lines.append(f"- **{_collection_title(item.collection)}:** `{item.name}`")
        lines.append(f"  - `{_signature(record, item.collection)}`")
        if show_before_after and item.before is not None and item.after is not None:
            lines.append(f"  - Before: `{_signature(item.before, item.collection)}`")
            lines.append(f"  - After: `{_signature(item.after, item.collection)}`")
    if len(records) > len(shown):
        lines.append(f"- … {len(records) - len(shown)} more entries omitted from this report section.")


def render_baseline_report(
    schema: dict[str, Any], checked_at: str, source_url: str
) -> str:
    """Render the report created when the first schema baseline is stored."""
    counts = schema_counts(schema)
    lines = [
        "# Telegram MTProto schema baseline",
        "",
        "This is the first snapshot. No historical comparison is available yet.",
        "",
        f"- Checked at (UTC): `{checked_at}`",
        f"- Source: [{source_url}]({source_url})",
        f"- API layer: `{schema.get('layer', 'unknown')}`",
        "",
        "## Inventory",
        "",
    ]
    for collection in ("constructors", "methods", "types"):
        if collection in counts:
            lines.append(f"- {_collection_title(collection)}: **{counts[collection]}**")
    lines.extend(
        [
            "",
            "The next successful run will compare this baseline with Telegram's published schema.",
            "",
        ]
    )
    return "\\n".join(lines)


def render_report(
    diff: SchemaDiff,
    schema: dict[str, Any],
    checked_at: str,
    source_url: str,
) -> str:
    """Render a Markdown report for a detected schema update."""
    lines = [
        "# Telegram MTProto schema changes",
        "",
        f"- Checked at (UTC): `{checked_at}`",
        f"- Source: [{source_url}]({source_url})",
        f"- API layer: `{diff.previous_layer}` → `{diff.current_layer}`",
        "",
        "## Summary",
        "",
        f"- Added declarations: **{len(diff.added)}**",
        f"- Removed declarations: **{len(diff.removed)}**",
        f"- Modified declarations: **{len(diff.changed)}**",
        f"- Other metadata changes: **{len(diff.metadata_changes)}**",
    ]

    if not diff.has_changes:
        lines.extend(["", "No schema changes were detected."])
        return "\\n".join(lines) + "\\n"

    _append_change_section(lines, "Added declarations", diff.added, side="after")
    _append_change_section(lines, "Removed declarations", diff.removed, side="before")
    _append_change_section(
        lines,
        "Modified declarations",
        diff.changed,
        side="after",
        show_before_after=True,
    )

    if diff.metadata_changes:
        lines.extend(["", "## Other metadata changes", ""])
        for key in diff.metadata_changes[:MAX_ITEMS_PER_SECTION]:
            lines.append(f"- `{key}` changed.")
        if len(diff.metadata_changes) > MAX_ITEMS_PER_SECTION:
            lines.append(
                f"- … {len(diff.metadata_changes) - MAX_ITEMS_PER_SECTION} more keys omitted."
            )

    lines.extend(
        [
            "",
            "---",
            "",
            "Generated automatically by [Telegram API Diff](https://github.com/W0rd3r566/telegram-api-diff-).",
            "",
        ]
    )
    return "\\n".join(lines)
