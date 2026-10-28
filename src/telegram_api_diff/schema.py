"""Fetching and canonicalizing Telegram's public schema."""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SCHEMA_URL = "https://core.telegram.org/schema/json"
SCHEMA_LAYER_URL = "https://core.telegram.org/scheme"
SCHEMA_COLLECTIONS = ("constructors", "methods", "types")
MAX_SCHEMA_BYTES = 64 * 1024 * 1024
USER_AGENT = "telegram-api-diff/0.1 (+https://github.com/W0rd3r566/telegram-api-diff-)"


class SchemaError(RuntimeError):
    """Raised when the official schema cannot be fetched or validated."""


def parse_api_layer(text: str) -> int:
    """Extract the current layer number from Telegram's official schema timeline."""
    match = re.search(r"(?im)^\s*(?:[-*+]\s*)?Layer\s+(\d+)\b", text)
    if match is None:
        match = re.search(r"\bLayer\s+(\d+)\b", text, re.IGNORECASE)
    if match is None:
        raise SchemaError("The official schema timeline did not contain a recognizable API layer.")
    return int(match.group(1))


def fetch_api_layer(timeout: float = 30.0) -> int:
    """Fetch the current API layer from Telegram's official schema timeline."""
    request = Request(
        SCHEMA_LAYER_URL,
        headers={
            "Accept": "text/html, text/plain, */*",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(512 * 1024)
    except HTTPError as exc:
        raise SchemaError(f"Layer timeline returned HTTP {exc.code}: {exc.reason}") from exc
    except OSError as exc:
        raise SchemaError(f"Could not fetch layer timeline: {exc}") from exc

    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SchemaError("Layer timeline response was not valid UTF-8.") from exc
    return parse_api_layer(text)


def _record_sort_key(record: Any) -> str:
    """Return a stable key without reordering fields inside parameter arrays."""
    if isinstance(record, dict):
        identity = record.get("predicate") or record.get("method") or record.get("name") or ""
    else:
        identity = ""
    serialized = json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return f"{identity}|{serialized}"


def canonicalize_schema(payload: Any) -> dict[str, Any]:
    """Validate the schema shape and normalize declaration ordering."""
    if not isinstance(payload, dict):
        raise SchemaError("The schema response must be a JSON object.")

    collection_keys = [
        key for key in SCHEMA_COLLECTIONS if isinstance(payload.get(key), list)
    ]
    if not collection_keys:
        raise SchemaError(
            "No declaration arrays were found. Expected at least one of: "
            + ", ".join(SCHEMA_COLLECTIONS)
            + ". The endpoint may have changed or returned an error document."
        )

    declaration_count = sum(len(payload[key]) for key in collection_keys)
    if declaration_count == 0:
        raise SchemaError(
            "The schema contains no declarations; refusing to accept an empty schema."
        )

    normalized = dict(payload)
    for key in collection_keys:
        normalized[key] = sorted(payload[key], key=_record_sort_key)
    return normalized


def schema_to_json(payload: Any) -> str:
    """Serialize a validated schema in a deterministic, readable format."""
    normalized = canonicalize_schema(payload)
    return json.dumps(normalized, ensure_ascii=False, indent=2, sort_keys=True) + chr(10)


def fetch_schema(url: str = SCHEMA_URL, timeout: float = 30.0) -> dict[str, Any]:
    """Fetch and validate the official machine-readable JSON schema."""
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )

    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_SCHEMA_BYTES + 1)
    except HTTPError as exc:
        raise SchemaError(f"Schema endpoint returned HTTP {exc.code}: {exc.reason}") from exc
    except OSError as exc:
        raise SchemaError(f"Could not fetch schema from {url}: {exc}") from exc

    if len(raw) > MAX_SCHEMA_BYTES:
        raise SchemaError(f"Schema response exceeds the {MAX_SCHEMA_BYTES}-byte safety limit.")

    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SchemaError("Schema response was not valid UTF-8.") from exc

    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        preview = text[:160].replace(chr(10), " ")
        raise SchemaError(
            f"Schema endpoint did not return valid JSON (response begins: {preview!r})."
        ) from exc

    try:
        normalized = canonicalize_schema(payload)
    except SchemaError as exc:
        raise SchemaError(f"Unexpected schema response from {url}: {exc}") from exc

    if url == SCHEMA_URL:
        normalized["layer"] = fetch_api_layer(timeout=timeout)
    return normalized


def load_schema_text(text: str) -> dict[str, Any]:
    """Load, validate and canonicalize schema JSON text."""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SchemaError(f"Invalid schema JSON: {exc}") from exc
    return canonicalize_schema(payload)
