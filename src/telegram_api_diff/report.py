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


def _short_value(value: Any, limit: int = 180) -> str:
    import json

    rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if len(rendered) > limit:
        return rendered[: limit - 1] + "…"
    return rendered


def _parameter_map(record: dict[str, Any]) -> dict[str, dict[str, Any]]:
    params = record.get("params", [])
    if not isinstance(params, list):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for param in params:
        if isinstance(param, dict) and param.get("name") is not None:
            result[str(param["name"])] = param
    return result


def _append_record_differences(
    lines: list[str], before: dict[str, Any], after: dict[str, Any]
) -> None:
    """Describe changed declaration fields, including individual parameter changes."""
    keys = (before.keys() | after.keys()) - {"params"}
    for key in sorted(keys):
        old_value = before.get(key, "<missing>")
        new_value = after.get(key, "<missing>")
        if old_value != new_value:
            lines.append(
                f"  - Field {chr(96)}{key}{chr(96)}: "
                f"{chr(96)}{_short_value(old_value)}{chr(96)} → "
                f"{chr(96)}{_short_value(new_value)}{chr(96)}"
            )

    old_params = _parameter_map(before)
    new_params = _parameter_map(after)
    for name in sorted(new_params.keys() - old_params.keys()):
        param = new_params[name]
        lines.append(f"  - Parameter added: {chr(96)}{name}: {param.get('type', '?')}{chr(96)}")
    for name in sorted(old_params.keys() - new_params.keys()):
        param = old_params[name]
        lines.append(f"  - Parameter removed: {chr(96)}{name}: {param.get('type', '?')}{chr(96)}")
    for name in sorted(old_params.keys() & new_params.keys()):
        if old_params[name] != new_params[name]:
            lines.append(
                f"  - Parameter changed: {chr(96)}{name}{chr(96)} "
                f"{chr(96)}{_short_value(old_params[name])}{chr(96)} → "
                f"{chr(96)}{_short_value(new_params[name])}{chr(96)}"
            )


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
        lines.append(f"- **{_collection_title(item.collection)}: {item.name}**")
        lines.append(f"  - {_signature(record, item.collection)}")
        if show_before_after and item.before is not None and item.after is not None:
            lines.append(f"  - Before: {_signature(item.before, item.collection)}")
            lines.append(f"  - After: {_signature(item.after, item.collection)}")
            _append_record_differences(lines, item.before, item.after)
    if len(records) > len(shown):
        lines.append(
            f"- … {len(records) - len(shown)} more entries omitted from this report section."
        )


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
        f"- Checked at (UTC): {checked_at}",
        f"- Source: [{source_url}]({source_url})",
        f"- API layer: {schema.get('layer', 'unknown')}",
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
    return chr(10).join(lines)


def render_report(
    diff: SchemaDiff,
    checked_at: str,
    source_url: str,
) -> str:
    """Render a Markdown report for a detected schema update."""
    lines = [
        "# Telegram MTProto schema changes",
        "",
        f"- Checked at (UTC): {checked_at}",
        f"- Source: [{source_url}]({source_url})",
        f"- API layer: {diff.previous_layer} → {diff.current_layer}",
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
        return chr(10).join(lines) + chr(10)

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
            lines.append(f"- {key} changed.")
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
    return chr(10).join(lines)
