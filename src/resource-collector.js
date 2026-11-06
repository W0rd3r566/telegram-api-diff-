import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { atomicWrite } from "./core.js";
import { isAllowedByRobots, isAllowedHost, normalizeUrl, parseRobotsRules } from "./crawler.js";
import { normalizeResource } from "./normalize.js";

const USER_AGENT = "TelegramApiDiffBot/0.2 (+https://github.com/W0rd3r566/telegram-api-diff-)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MAX_ROBOTS_BYTES = 256 * 1024;
const MIB = 1024 * 1024;

export class ResourceCollectorError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ResourceCollectorError";
  }
}

class BudgetExhaustedError extends ResourceCollectorError {
  constructor(message) {
    super(message);
    this.name = "BudgetExhaustedError";
    this.code = "BUDGET_EXHAUSTED";
  }
}

function validateOptions(options) {
  const limits = {
    maxResources: options.maxResources ?? 1000,
    concurrency: options.concurrency ?? 4,
    timeout: options.timeout ?? 20,
    perHostDelayMs: options.perHostDelayMs ?? 150,
    maxPageBytes: options.maxPageBytes ?? 2 * MIB,
    maxResourceBytes: options.maxResourceBytes ?? 4 * MIB,
    maxTotalBytes: options.maxTotalBytes ?? 64 * MIB,
  };
  if (!Number.isInteger(limits.maxResources) || limits.maxResources < 1 || limits.maxResources > 10000) {
    throw new TypeError("maxResources must be an integer from 1 to 10000.");
  }
  if (!Number.isInteger(limits.concurrency) || limits.concurrency < 1 || limits.concurrency > 20) {
    throw new TypeError("concurrency must be an integer from 1 to 20.");
  }
  if (!Number.isFinite(limits.timeout) || limits.timeout <= 0 || limits.timeout > 180) {
    throw new TypeError("timeout must be greater than zero and no more than 180 seconds.");
  }
  if (!Number.isInteger(limits.perHostDelayMs) || limits.perHostDelayMs < 0 || limits.perHostDelayMs > 5000) {
    throw new TypeError("perHostDelayMs must be an integer from 0 to 5000.");
  }
  for (const key of ["maxPageBytes", "maxResourceBytes", "maxTotalBytes"]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > 512 * MIB) {
      throw new TypeError(key + " must be an integer from 1 byte to 512 MiB.");
    }
  }
  if (limits.maxPageBytes > limits.maxTotalBytes || limits.maxResourceBytes > limits.maxTotalBytes) {
    throw new TypeError("Per-file byte limits cannot exceed maxTotalBytes.");
  }
  return limits;
}

function makeRequestGate(delayMs) {
  const locks = new Map();
  const lastRequest = new Map();
  return async (hostname) => {
    const previous = locks.get(hostname) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const elapsed = Date.now() - (lastRequest.get(hostname) ?? 0);
      const wait = Math.max(0, delayMs - elapsed);
      if (wait) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
      lastRequest.set(hostname, Date.now());
    });
    locks.set(hostname, next);
    await next;
  };
}

async function readBody(response, maxBytes, budget) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ResourceCollectorError("Response exceeds the per-file limit of " + maxBytes + " bytes.");
  }
  if (Number.isFinite(declared) && budget && declared > budget.maxBytes - budget.used) {
    await response.body?.cancel().catch(() => {});
    throw new BudgetExhaustedError("Total download budget would be exceeded by this response.");
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const length = item.value.byteLength;
      if (size + length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResourceCollectorError("Response exceeds the per-file limit of " + maxBytes + " bytes.");
      }
      if (budget && budget.used + length > budget.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BudgetExhaustedError("Total download byte budget was exhausted.");
      }
      size += length;
      if (budget) budget.used += length;
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function fetchBytes(inputUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const targetUrl = new URL(inputUrl);
  const originalHost = targetUrl.hostname.toLowerCase();
  let target = targetUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (target.protocol !== "https:" || !isAllowedHost(target.hostname) ||
        target.hostname.toLowerCase() !== originalHost || target.username || target.password ||
        (target.port && target.port !== "443")) {
      throw new ResourceCollectorError("Refusing an unsafe resource URL or redirect: " + target.href);
    }
    if (options.requestGate) await options.requestGate(target.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout * 1000);
    timer.unref?.();
    try {
      const headers = {
        "Accept": options.accept ?? "*/*",
        "User-Agent": USER_AGENT,
        ...(options.headers ?? {}),
      };
      const response = await fetchImpl(target, {
        method: "GET",
        redirect: "manual",
        headers,
        signal: controller.signal,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location) throw new ResourceCollectorError("Redirect did not include a Location header.");
        if (redirects === MAX_REDIRECTS) throw new ResourceCollectorError("Too many redirects for " + inputUrl + ".");
        let next;
        try {
          next = new URL(location, target);
        } catch (error) {
          throw new ResourceCollectorError("Invalid redirect target.", { cause: error });
        }
        if (next.protocol !== "https:" || next.hostname.toLowerCase() !== originalHost ||
            !isAllowedHost(next.hostname) || (next.port && next.port !== "443") ||
            next.username || next.password) {
          throw new ResourceCollectorError("Refusing cross-host or insecure redirect from " + target.hostname + ".");
        }
        target = next;
        continue;
      }

      if (response.status === 304) {
        await response.body?.cancel().catch(() => {});
        return { status: 304, url: target.href, headers: response.headers, bytes: Buffer.alloc(0) };
      }
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel().catch(() => {});
        return { status: response.status, url: target.href, headers: response.headers, bytes: Buffer.alloc(0) };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const error = new ResourceCollectorError("HTTP " + response.status + " while fetching " + target.href + ".");
        error.status = response.status;
        throw error;
      }
      const bytes = await readBody(response, options.maxBytes, options.budget);
      return { status: response.status, url: target.href, headers: response.headers, bytes };
    } catch (error) {
      if (error instanceof ResourceCollectorError) throw error;
      if (error?.name === "AbortError") {
        throw new ResourceCollectorError("Request timed out after " + options.timeout + " seconds: " + target.href, { cause: error });
      }
      throw new ResourceCollectorError("Could not fetch " + target.href + ": " + error.message, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ResourceCollectorError("Redirect limit exceeded for " + inputUrl + ".");
}

async function loadRobots(hostname, options) {
  try {
    const result = await fetchBytes("https://" + hostname + "/robots.txt", {
      ...options,
      maxBytes: MAX_ROBOTS_BYTES,
      accept: "text/plain,*/*;q=0.1",
      budget: null,
    });
    if (result.status === 404 || result.status === 410) return { rules: [], error: null };
    const text = new TextDecoder("utf-8", { fatal: false }).decode(result.bytes);
    return { rules: parseRobotsRules(text), error: null };
  } catch (error) {
    return { rules: [{ allow: false, pattern: "/" }], error: error.message };
  }
}

function loadTrackedFile(text, kind, errors) {
  const urls = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const candidate = /^https?:\/\//i.test(line) ? line : "https://" + line;
    const url = normalizeUrl(candidate);
    if (!url) {
      errors.push({ input: line, kind, error: "Invalid URL or host outside the Telegram allowlist." });
      continue;
    }
    urls.push({ url, kind });
  }
  return urls;
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function loadPreviousManifest(path) {
  try {
    const text = await readFile(path, "utf8");
    const manifest = JSON.parse(text);
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.resources)) {
      throw new ResourceCollectorError("Previous resource manifest has an unsupported format.");
    }
    return manifest;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new ResourceCollectorError("Previous resource manifest is invalid JSON.", { cause: error });
    }
    throw error;
  }
}

function isTextResponse(contentType, url) {
  const type = String(contentType).toLowerCase().split(";", 1)[0].trim();
  if (type.startsWith("text/")) return true;
  if (/^(?:application|image)\/(?:[^;]+\+)?(?:json|javascript|xml|svg\+xml)$/.test(type)) return true;
  return /\.(?:css|csv|html?|js|json|map|svg|txt|webmanifest|xml)$/i.test(new URL(url).pathname);
}

function isJsonResponse(contentType, url) {
  const type = String(contentType).toLowerCase().split(";", 1)[0].trim();
  return type.includes("json") || /\.(?:json|webmanifest)$/i.test(new URL(url).pathname);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fetchOne(item, previous, options) {
  const hostname = new URL(item.url).hostname;
  const robots = await options.getRobots(hostname);
  if (robots.error) {
    throw new ResourceCollectorError("robots.txt could not be checked: " + robots.error);
  }
  if (!isAllowedByRobots(item.url, robots.rules)) {
    const error = new ResourceCollectorError("Blocked by robots.txt.");
    error.code = "ROBOTS_BLOCKED";
    throw error;
  }

  const headers = {};
  if (previous?.etag) headers["If-None-Match"] = previous.etag;
  if (previous?.lastModified) headers["If-Modified-Since"] = previous.lastModified;
  const response = await fetchBytes(item.url, {
    ...options,
    maxBytes: item.kind === "page" ? options.maxPageBytes : options.maxResourceBytes,
    headers,
    budget: options.budget,
  });
  const checkedAt = new Date().toISOString();

  if (response.status === 304) {
    if (!previous?.sha256 || !previous?.object) {
      throw new ResourceCollectorError("Server returned 304 but no previous archived body exists.");
    }
    const { error: _error, ...old } = previous;
    return {
      ...old,
      url: item.url,
      kind: item.kind,
      checkedAt,
      httpStatus: 304,
      fetchStatus: "unchanged",
      stale: false,
      unchanged: true,
    };
  }

  if (response.status === 404 || response.status === 410) {
    return {
      url: item.url,
      kind: item.kind,
      checkedAt,
      httpStatus: response.status,
      fetchStatus: "not_found",
      contentType: response.headers.get("content-type"),
      size: 0,
      sourceSize: 0,
      sha256: null,
      object: null,
      etag: null,
      lastModified: null,
      normalized: false,
      unchanged: false,
      removed: Boolean(previous?.sha256),
    };
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  let body = response.bytes;
  let normalized = false;
  if (isTextResponse(contentType, item.url)) {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch (error) {
      throw new ResourceCollectorError("Text resource is not valid UTF-8: " + item.url, { cause: error });
    }
    try {
      const output = normalizeResource(text, {
        json: isJsonResponse(contentType, item.url),
        fileName: basename(new URL(item.url).pathname),
      });
      body = Buffer.from(output, "utf8");
      normalized = true;
    } catch (error) {
      throw new ResourceCollectorError("Could not normalize " + item.url + ": " + error.message, { cause: error });
    }
  }

  const digest = sha256(body);
  return {
    url: item.url,
    kind: item.kind,
    checkedAt,
    httpStatus: response.status,
    fetchStatus: "ok",
    contentType,
    size: body.byteLength,
    sourceSize: response.bytes.byteLength,
    sha256: digest,
    object: "resource_objects/" + digest.slice(0, 2) + "/" + digest,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    normalized,
    unchanged: previous?.sha256 === digest,
    removed: false,
    _body: body,
  };
}

async function mapConcurrent(items, concurrency, handler) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await handler(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function makeReport(manifest, changes, failures) {
  const tick = String.fromCharCode(96);
  const lines = [
    "# Telegram web resource snapshot",
    "",
    "- Collected at (UTC): " + manifest.collectedAt,
    "- Tracked URLs: **" + manifest.trackedCount + "**",
    "- Attempted this run: **" + manifest.attemptedCount + "**",
    "- Downloaded bytes: **" + manifest.bytesDownloaded + "**",
    "- Added: **" + changes.added + "**",
    "- Changed: **" + changes.changed + "**",
    "- Removed (HTTP 404/410): **" + changes.removed + "**",
    "- Unchanged: **" + changes.unchanged + "**",
    "- Errors: **" + failures.length + "**",
    "- Partial run: **" + (manifest.partial ? "yes" : "no") + "**",
  ];
  for (const [label, items] of [
    ["Added resources", changes.addedItems],
    ["Changed resources", changes.changedItems],
    ["Removed resources", changes.removedItems],
  ]) {
    if (!items.length) continue;
    lines.push("", "## " + label, "");
    for (const item of items.slice(0, 100)) {
      lines.push("- " + tick + item.url + tick);
      if (item.before && item.after) lines.push("  - " + tick + item.before + tick + " → " + tick + item.after + tick);
      else if (item.after) lines.push("  - SHA-256: " + tick + item.after + tick);
    }
    if (items.length > 100) lines.push("- … " + (items.length - 100) + " more.");
  }
  if (failures.length) {
    lines.push("", "## Fetch failures", "");
    for (const failure of failures.slice(0, 100)) lines.push("- " + tick + failure.url + tick + ": " + failure.error);
    if (failures.length > 100) lines.push("- … " + (failures.length - 100) + " more.");
  }
  lines.push("", "Resource bodies are stored once by normalized SHA-256 in resource_objects/.", "");
  return lines.join("\n");
}

export async function collectResources(options = {}) {
  const limits = validateOptions(options);
  const root = resolve(options.root ?? ".");
  const readErrors = [];
  const [pageText, resourceText, previous] = await Promise.all([
    readOptional(join(root, "tracked_links.txt")),
    readOptional(join(root, "tracked_res_links.txt")),
    loadPreviousManifest(join(root, "resource_snapshots", "latest.json")),
  ]);
  const input = [
    ...loadTrackedFile(pageText, "page", readErrors),
    ...loadTrackedFile(resourceText, "resource", readErrors),
  ];
  const deduplicated = new Map();
  for (const item of input) {
    const existing = deduplicated.get(item.url);
    if (!existing || item.kind === "resource") deduplicated.set(item.url, item);
  }
  const all = [...deduplicated.values()].sort((a, b) =>
    a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  if (!all.length) throw new ResourceCollectorError("No valid URLs found in tracked_links.txt or tracked_res_links.txt.");

  const previousMap = new Map((previous?.resources ?? []).map((item) => [item.url, item]));
  const startIndex = Number.isInteger(previous?.nextIndex) ? previous.nextIndex % all.length : 0;
  const count = Math.min(limits.maxResources, all.length);
  const selected = Array.from({ length: count }, (_unused, index) => all[(startIndex + index) % all.length]);
  const budget = { maxBytes: limits.maxTotalBytes, used: 0 };
  const requestGate = makeRequestGate(limits.perHostDelayMs);
  const robotsCache = new Map();
  const getRobots = (hostname) => {
    if (!robotsCache.has(hostname)) {
      robotsCache.set(hostname, loadRobots(hostname, {
        timeout: limits.timeout,
        fetchImpl: options.fetchImpl,
        requestGate,
      }));
    }
    return robotsCache.get(hostname);
  };

  const rawResults = await mapConcurrent(selected, limits.concurrency, async (item) => {
    const old = previousMap.get(item.url);
    try {
      return await fetchOne(item, old, {
        ...limits,
        fetchImpl: options.fetchImpl,
        requestGate,
        getRobots,
        budget,
      });
    } catch (error) {
      return {
        url: item.url,
        kind: item.kind,
        checkedAt: new Date().toISOString(),
        fetchStatus: error.code === "ROBOTS_BLOCKED" ? "robots_blocked" :
          error.code === "BUDGET_EXHAUSTED" ? "deferred_budget" : "error",
        stale: Boolean(old?.sha256),
        error: error.message,
        previous: old ?? null,
      };
    }
  });

  const results = new Map();
  const failures = [...readErrors];
  let completed = 0;
  let deferredAt = -1;
  for (let index = 0; index < rawResults.length; index += 1) {
    const result = rawResults[index];
    if (result.fetchStatus === "deferred_budget") {
      if (deferredAt < 0) deferredAt = index;
      continue;
    }
    completed += 1;
    if (result.fetchStatus === "error" || result.fetchStatus === "robots_blocked") {
      failures.push({ url: result.url, error: result.error });
      const old = result.previous;
      results.set(result.url, old
        ? { ...old, kind: result.kind, checkedAt: result.checkedAt, fetchStatus: "stale", stale: true, error: result.error }
        : { url: result.url, kind: result.kind, checkedAt: result.checkedAt, fetchStatus: result.fetchStatus, stale: false, error: result.error, sha256: null, object: null });
    } else {
      results.set(result.url, result);
    }
  }

  const merged = new Map(previousMap);
  for (const [url, result] of results) merged.set(url, result);
  for (const item of all) {
    if (!merged.has(item.url)) {
      merged.set(item.url, {
        url: item.url,
        kind: item.kind,
        fetchStatus: "pending",
        stale: false,
        sha256: null,
        object: null,
      });
    }
  }

  const addedItems = [];
  const changedItems = [];
  const removedItems = [];
  let unchanged = 0;
  for (const result of results.values()) {
    const old = previousMap.get(result.url);
    if (result.fetchStatus === "unchanged" || (result.sha256 && old?.sha256 === result.sha256)) {
      unchanged += 1;
    } else if (result.removed && old?.sha256) {
      removedItems.push({ url: result.url, before: old.sha256, after: null });
    } else if (result.sha256 && !old?.sha256) {
      addedItems.push({ url: result.url, before: null, after: result.sha256 });
    } else if (result.sha256 && old?.sha256 && result.sha256 !== old.sha256) {
      changedItems.push({ url: result.url, before: old.sha256, after: result.sha256 });
    }
  }

  const deferredCount = rawResults.filter((item) => item.fetchStatus === "deferred_budget").length;
  const nextIndex = deferredAt >= 0
    ? (startIndex + deferredAt) % all.length
    : (startIndex + count) % all.length;
  const collectedAt = new Date().toISOString();
  const resources = [...merged.values()]
    .map((item) => {
      const { _body, previous: _previous, ...entry } = item;
      return entry;
    })
    .sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  const manifest = {
    version: 1,
    collectedAt,
    trackedCount: all.length,
    attemptedCount: count,
    completedCount: completed,
    deferredCount,
    nextIndex,
    partial: count < all.length || deferredCount > 0 || failures.length > 0,
    bytesDownloaded: budget.used,
    limits: {
      maxResources: limits.maxResources,
      concurrency: limits.concurrency,
      maxPageBytes: limits.maxPageBytes,
      maxResourceBytes: limits.maxResourceBytes,
      maxTotalBytes: limits.maxTotalBytes,
    },
    resources,
  };
  const changes = {
    added: addedItems.length,
    changed: changedItems.length,
    removed: removedItems.length,
    unchanged,
    addedItems,
    changedItems,
    removedItems,
  };

  return {
    manifest,
    changes,
    failures,
    bodies: rawResults.filter((item) => item?._body).map((item) => ({
      path: item.object,
      body: item._body,
    })),
  };
}

export async function saveResourceResults(result, root = ".") {
  const base = resolve(root);
  const manifest = result.manifest;
  if (!manifest || !Array.isArray(manifest.resources)) {
    throw new TypeError("A valid resource collection result is required.");
  }
  const successful = manifest.resources.some((item) =>
    item.fetchStatus === "ok" || item.fetchStatus === "unchanged" || item.fetchStatus === "not_found");
  if (!successful && result.failures.length) {
    throw new ResourceCollectorError("No resources could be checked successfully; previous manifest was left unchanged.");
  }

  for (const item of result.bodies ?? []) {
    const path = join(base, item.path);
    try {
      await access(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await atomicWrite(path, item.body);
    }
  }

  const date = manifest.collectedAt.slice(0, 10);
  const snapshotPath = join(base, "resource_snapshots", date + ".json");
  const latestPath = join(base, "resource_snapshots", "latest.json");
  const report = makeReport(manifest, result.changes, result.failures);
  const reportPath = join(base, "resource_reports", date + ".md");
  const latestReportPath = join(base, "resource_reports", "latest.md");
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";

  await atomicWrite(snapshotPath, manifestText);
  await atomicWrite(latestPath, manifestText);
  await atomicWrite(reportPath, report + "\n");
  await atomicWrite(latestReportPath, report + "\n");

  return {
    snapshotPath,
    latestPath,
    reportPath,
    latestReportPath,
    objectsWritten: result.bodies?.length ?? 0,
    resources: manifest.resources.length,
    attempted: manifest.attemptedCount,
    bytesDownloaded: manifest.bytesDownloaded,
    partial: manifest.partial,
  };
}
