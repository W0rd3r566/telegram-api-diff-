import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const SCHEMA_URL = "https://core.telegram.org/schema/json";
export const SCHEMA_LAYER_URL = "https://core.telegram.org/scheme";
export const COLLECTIONS = ["constructors", "methods", "types"];
const USER_AGENT = "telegram-api-diff/0.2 (+https://github.com/W0rd3r566/telegram-api-diff-)";
const MAX_SCHEMA_BYTES = 64 * 1024 * 1024;

export class SchemaError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SchemaError";
  }
}

export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

export function canonicalizeSchema(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SchemaError("The schema response must be a JSON object.");
  }
  for (const key of ["constructors", "methods"]) {
    if (!Array.isArray(data[key])) throw new SchemaError("Schema is missing required declaration array: " + key + ".");
  }

  const result = { ...data };
  const collections = COLLECTIONS.filter((key) => Array.isArray(data[key]));
  if (collections.reduce((n, key) => n + data[key].length, 0) === 0) {
    throw new SchemaError("The schema contains no declarations; refusing to accept an empty schema.");
  }

  for (const collection of collections) {
    const idKey = collection === "methods" ? "method" : "predicate";
    const seen = new Set();
    data[collection].forEach((record, index) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new SchemaError(collection + "[" + index + "] is not a JSON object.");
      }
      const id = record[idKey] ?? record.name ?? record.id;
      const valid = typeof id === "string" || (typeof id === "number" && Number.isInteger(id));
      if (!valid || String(id).trim() === "") {
        throw new SchemaError(collection + "[" + index + "] has no usable declaration name.");
      }
      const name = String(id).trim();
      if (seen.has(name)) throw new SchemaError(collection + " contains duplicate declaration name: " + name + ".");
      seen.add(name);
    });

    result[collection] = [...data[collection]].sort((a, b) => {
      const left = String(a[idKey] ?? a.name ?? a.id) + "|" + stableStringify(a);
      const right = String(b[idKey] ?? b.name ?? b.id) + "|" + stableStringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
  return result;
}

export function schemaToJson(data) {
  return JSON.stringify(sortKeysDeep(canonicalizeSchema(data)), null, 2) + "\n";
}

export function parseApiLayer(text) {
  const match = text.match(/^[ \t]*(?:[-*+][ \t]*)?Layer[ \t]+(\d+)\b/im) ??
    text.match(/\bLayer[ \t]+(\d+)\b/i);
  if (!match) throw new SchemaError("The official schema timeline did not contain a recognizable API layer.");
  return Number.parseInt(match[1], 10);
}

async function responseText(response, maxBytes, label) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new SchemaError(label + " exceeds the " + maxBytes + "-byte safety limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SchemaError(label + " exceeds the " + maxBytes + "-byte safety limit.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SchemaError(label + " was not valid UTF-8.", { cause: error });
  }
}

export async function fetchText(url, options = {}) {
  const timeout = options.timeout ?? 30;
  const maxBytes = options.maxBytes ?? MAX_SCHEMA_BYTES;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new SchemaError("HTTP timeout must be a finite number greater than zero.");
  }
  let target;
  try {
    target = new URL(url);
  } catch (error) {
    throw new SchemaError("Invalid URL: " + url, { cause: error });
  }
  if (!["http:", "https:"].includes(target.protocol)) throw new SchemaError("Only HTTP and HTTPS URLs are supported.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  timer.unref?.();
  try {
    const response = await fetch(target, {
      headers: { Accept: options.accept ?? "application/json", "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new SchemaError("Request to " + target.origin + " returned HTTP " + response.status + ".");
    return await responseText(response, maxBytes, "Response from " + target.origin);
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    if (error?.name === "AbortError") throw new SchemaError("Request timed out after " + timeout + " seconds.", { cause: error });
    throw new SchemaError("Could not fetch " + target.origin + ": " + error.message, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSchema(url = SCHEMA_URL, timeout = 30) {
  let data;
  try {
    data = JSON.parse((await fetchText(url, { timeout })).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    throw new SchemaError("Schema endpoint did not return valid JSON.", { cause: error });
  }
  let schema;
  try {
    schema = canonicalizeSchema(data);
  } catch (error) {
    throw new SchemaError("Unexpected schema response from " + url + ": " + error.message, { cause: error });
  }
  if (url === SCHEMA_URL) {
    const timeline = await fetchText(SCHEMA_LAYER_URL, {
      timeout,
      maxBytes: 512 * 1024,
      accept: "text/html, text/plain, */*",
    });
    schema.layer = parseApiLayer(timeline);
  }
  return schema;
}

function recordMap(schema, collection) {
  const records = Array.isArray(schema[collection]) ? schema[collection] : [];
  const map = new Map();
  records.forEach((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    const key = collection === "methods" ? "method" : "predicate";
    let name = String(record[key] ?? record.name ?? record.id ?? "<unnamed-" + (index + 1) + ">");
    if (map.has(name)) name += " [duplicate " + (index + 1) + "]";
    map.set(name, record);
  });
  return map;
}

export function compareSchemas(before, after) {
  const oldData = canonicalizeSchema(before);
  const newData = canonicalizeSchema(after);
  const diff = {
    added: [], removed: [], changed: [], metadataChanges: [],
    previousLayer: oldData.layer ?? "unknown",
    currentLayer: newData.layer ?? "unknown",
  };

  for (const collection of COLLECTIONS) {
    const oldMap = recordMap(oldData, collection);
    const newMap = recordMap(newData, collection);
    for (const name of [...newMap.keys()].filter((key) => !oldMap.has(key)).sort()) {
      diff.added.push({ collection, name, before: null, after: newMap.get(name) });
    }
    for (const name of [...oldMap.keys()].filter((key) => !newMap.has(key)).sort()) {
      diff.removed.push({ collection, name, before: oldMap.get(name), after: null });
    }
    for (const name of [...oldMap.keys()].filter((key) => newMap.has(key)).sort()) {
      if (stableStringify(oldMap.get(name)) !== stableStringify(newMap.get(name))) {
        diff.changed.push({ collection, name, before: oldMap.get(name), after: newMap.get(name) });
      }
    }
  }

  const ignored = new Set([...COLLECTIONS, "layer"]);
  const keys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
  diff.metadataChanges = [...keys]
    .filter((key) => !ignored.has(key))
    .filter((key) => stableStringify(oldData[key]) !== stableStringify(newData[key]))
    .sort();
  diff.hasChanges = Boolean(
    diff.added.length || diff.removed.length || diff.changed.length ||
    diff.metadataChanges.length || diff.previousLayer !== diff.currentLayer
  );
  return diff;
}

export function schemaCounts(schema) {
  const data = canonicalizeSchema(schema);
  return Object.fromEntries(COLLECTIONS.filter((key) => Array.isArray(data[key]))
    .map((key) => [key, data[key].length]));
}

function signature(record, collection) {
  const name = collection === "methods"
    ? (record.method ?? record.name ?? record.id ?? "unknown")
    : (record.predicate ?? record.name ?? record.id ?? "unknown");
  let value = String(name);
  if (record.id !== undefined && record.id !== null && record.id !== "") value += "#" + record.id;
  const params = Array.isArray(record.params) ? record.params : [];
  if (params.length) {
    const parts = params.slice(0, 8).map((p) =>
      p && typeof p === "object" ? String(p.name ?? "?") + ":" + String(p.type ?? "?") : String(p));
    if (params.length > 8) parts.push("... +" + (params.length - 8) + " more");
    value += " " + parts.join(" ");
  }
  if (record.type) value += " = " + record.type;
  return value.replaceAll(String.fromCharCode(96), "'");
}

function titleCase(value) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortValue(value) {
  const text = stableStringify(value);
  return text.length > 180 ? text.slice(0, 179) + "…" : text;
}

function appendChangeSection(lines, title, entries, side, details = false) {
  if (!entries.length) return;
  const tick = String.fromCharCode(96);
  lines.push("", "## " + title, "");
  for (const item of entries.slice(0, 100)) {
    const record = side === "before" ? (item.before ?? item.after) : (item.after ?? item.before);
    lines.push("- **" + titleCase(item.collection) + ": " + item.name + "**");
    lines.push("  - " + signature(record, item.collection));
    if (!details || !item.before || !item.after) continue;
    lines.push("  - Before: " + signature(item.before, item.collection));
    lines.push("  - After: " + signature(item.after, item.collection));
    const keys = new Set([...Object.keys(item.before), ...Object.keys(item.after)]);
    keys.delete("params");
    for (const key of [...keys].sort()) {
      const a = Object.hasOwn(item.before, key) ? item.before[key] : "<missing>";
      const b = Object.hasOwn(item.after, key) ? item.after[key] : "<missing>";
      if (stableStringify(a) !== stableStringify(b)) {
        lines.push("  - Field " + tick + key + tick + ": " + tick + shortValue(a) + tick + " → " + tick + shortValue(b) + tick);
      }
    }
    const params = (record) => new Map((Array.isArray(record.params) ? record.params : [])
      .filter((p) => p && typeof p === "object" && p.name !== undefined)
      .map((p) => [String(p.name), p]));
    const oldParams = params(item.before);
    const newParams = params(item.after);
    for (const [name, p] of newParams) {
      if (!oldParams.has(name)) lines.push("  - Parameter added: " + tick + name + ": " + (p.type ?? "?") + tick);
      else if (stableStringify(oldParams.get(name)) !== stableStringify(p)) {
        lines.push("  - Parameter changed: " + tick + name + tick + " " + tick + shortValue(oldParams.get(name)) + tick + " → " + tick + shortValue(p) + tick);
      }
    }
    for (const [name, p] of oldParams) {
      if (!newParams.has(name)) lines.push("  - Parameter removed: " + tick + name + ": " + (p.type ?? "?") + tick);
    }
  }
  if (entries.length > 100) lines.push("- … " + (entries.length - 100) + " more entries omitted from this report section.");
}

export function renderBaselineReport(schema, checkedAt, sourceUrl) {
  const counts = schemaCounts(schema);
  const lines = [
    "# Telegram MTProto schema baseline", "",
    "This is the first snapshot. No historical comparison is available yet.", "",
    "- Checked at (UTC): " + checkedAt,
    "- Source: [" + sourceUrl + "](" + sourceUrl + ")",
    "- API layer: " + (schema.layer ?? "unknown"), "",
    "## Inventory", "",
  ];
  for (const key of COLLECTIONS) if (counts[key] !== undefined) lines.push("- " + titleCase(key) + ": **" + counts[key] + "**");
  lines.push("", "The next successful run will compare this baseline with Telegram's published schema.", "");
  return lines.join("\n");
}

export function renderReport(diff, checkedAt, sourceUrl) {
  const lines = [
    "# Telegram MTProto schema changes", "",
    "- Checked at (UTC): " + checkedAt,
    "- Source: [" + sourceUrl + "](" + sourceUrl + ")",
    "- API layer: " + diff.previousLayer + " → " + diff.currentLayer, "",
    "## Summary", "",
    "- Added declarations: **" + diff.added.length + "**",
    "- Removed declarations: **" + diff.removed.length + "**",
    "- Modified declarations: **" + diff.changed.length + "**",
    "- Other metadata changes: **" + diff.metadataChanges.length + "**",
  ];
  if (!diff.hasChanges) {
    lines.push("", "No schema changes were detected.");
    return lines.join("\n") + "\n";
  }
  appendChangeSection(lines, "Added declarations", diff.added, "after");
  appendChangeSection(lines, "Removed declarations", diff.removed, "before");
  appendChangeSection(lines, "Modified declarations", diff.changed, "after", true);
  if (diff.metadataChanges.length) {
    lines.push("", "## Other metadata changes", "");
    for (const key of diff.metadataChanges.slice(0, 100)) lines.push("- " + key + " changed.");
    if (diff.metadataChanges.length > 100) lines.push("- … " + (diff.metadataChanges.length - 100) + " more keys omitted.");
  }
  lines.push("", "---", "", "Generated automatically by [Telegram API Diff](https://github.com/W0rd3r566/telegram-api-diff-).", "");
  return lines.join("\n");
}

export function timestampUtc(date = new Date()) {
  const checkedAt = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { checkedAt, date: checkedAt.slice(0, 10) };
}

export async function loadSchema(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new SchemaError("Could not read snapshot " + path + ": " + error.message, { cause: error });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new SchemaError("Stored snapshot is invalid JSON: " + path, { cause: error });
  }
  return canonicalizeSchema(data);
}

export async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeGitHubOutputs(values, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => {
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new TypeError("GitHub Actions output " + key + " must be single-line.");
    return key + "=" + text;
  });
  await appendFile(outputPath, lines.join("\n") + "\n", "utf8");
}

async function pathExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function printSummary(schema) {
  const counts = Object.entries(schemaCounts(schema)).map(([key, value]) => key + "=" + value).join(", ");
  console.log("API layer: " + (schema.layer ?? "unknown") + "; " + counts);
}

const REPORT_URL = "https://github.com/W0rd3r566/telegram-api-diff-/blob/main/reports/latest.md";

export async function updateSchema(options = {}) {
  const root = resolve(options.root ?? ".");
  const schemaUrl = options.schemaUrl ?? SCHEMA_URL;
  const timeout = options.timeout ?? 30;
  const current = await fetchSchema(schemaUrl, timeout);
  const { checkedAt, date } = timestampUtc();
  const latest = join(root, "snapshots", "latest.json");
  let diff = null;
  let report;
  let previousLayer = "unknown";

  if (await pathExists(latest)) {
    diff = compareSchemas(await loadSchema(latest), current);
    previousLayer = diff.previousLayer;
    report = renderReport(diff, checkedAt, schemaUrl);
    if (!diff.hasChanges) console.log("No schema changes detected; recording today's check.");
    else console.log("Schema updated: +" + diff.added.length + " added, -" + diff.removed.length +
      " removed, ~" + diff.changed.length + " modified.");
  } else {
    report = renderBaselineReport(current, checkedAt, schemaUrl);
    console.log("Created the first baseline; future runs can detect changes.");
  }

  const serialized = schemaToJson(current);
  const datedSnapshot = join(root, "snapshots", date + ".json");
  const datedReport = join(root, "reports", date + ".md");
  await mkdir(join(root, "snapshots"), { recursive: true });
  await mkdir(join(root, "reports"), { recursive: true });
  await atomicWrite(datedSnapshot, serialized);
  await atomicWrite(latest, serialized);
  await atomicWrite(datedReport, report);
  await atomicWrite(join(root, "reports", "latest.md"), report);
  await writeGitHubOutputs({
    has_changes: Boolean(diff && diff.hasChanges),
    added_count: diff?.added.length ?? 0,
    removed_count: diff?.removed.length ?? 0,
    modified_count: diff?.changed.length ?? 0,
    metadata_count: diff?.metadataChanges.length ?? 0,
    previous_layer: previousLayer,
    current_layer: current.layer ?? "unknown",
    report_url: REPORT_URL,
  });
  printSummary(current);
  console.log("Snapshot: " + datedSnapshot);
  console.log("Report:   " + datedReport);
  return 0;
}

export async function checkSchema(options = {}) {
  const root = resolve(options.root ?? ".");
  const schemaUrl = options.schemaUrl ?? SCHEMA_URL;
  const latest = join(root, "snapshots", "latest.json");
  if (!(await pathExists(latest))) {
    console.error("No baseline exists yet. Run telegram-api-diff update first.");
    return 2;
  }
  const previous = await loadSchema(latest);
  const current = await fetchSchema(schemaUrl, options.timeout ?? 30);
  const diff = compareSchemas(previous, current);
  if (!diff.hasChanges) {
    console.log("No schema changes detected.");
    printSummary(current);
    return 0;
  }
  console.log(renderReport(diff, timestampUtc().checkedAt, schemaUrl));
  console.error("Changes detected. Run telegram-api-diff update to save the snapshot.");
  return 1;
}
