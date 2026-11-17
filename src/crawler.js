import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWrite } from "./core.js";

export const DEFAULT_SEEDS = [
  "https://telegram.org/",
  "https://telegram.org/tour",
  "https://telegram.org/evolution",
  "https://telegram.org/privacy",
  "https://core.telegram.org/",
  "https://core.telegram.org/getProxyConfig",
  "https://core.telegram.org/resources/cidr.txt",
  "https://desktop.telegram.org/",
  "https://td.telegram.org/current",
  "https://osx.telegram.org/updates/versions.xml",
  "https://mac-updates.telegram.org/beta/versions.xml",
  "https://translations.telegram.org/",
  "https://instantview.telegram.org/",
  "https://bugs.telegram.org/",
  "https://blogfork.telegram.org/",
  "https://corefork.telegram.org/",
  "https://web.telegram.org/",
  "https://webappcontent.telegram.org/demo",
  "https://webappcontent.telegram.org/cafe",
  "https://webappinternal.telegram.org/botfather",
  "https://contest.com/",
];

const USER_AGENT = "TelegramApiDiffBot/0.1 (+https://github.com/W0rd3r566/telegram-api-diff-)";
const VOLATILE_QUERY_KEYS = new Set(["hash", "token", "passport_ssid", "nonce", "tgcrawlnocache"]);
const RESOURCE_EXTENSION = /\.(?:avif|bmp|css|csv|eot|gif|ico|jpe?g|js|json|map|m4a|m4v|mp3|mp4|pdf|png|svg|txt|ttf|wasm|webm|webmanifest|webp|woff2?|xml|zip)(?:$)/i;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_PAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ROBOTS_BYTES = 256 * 1024;

export class CrawlerError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CrawlerError";
  }
}

export function isAllowedHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  return host === "telegram.org" || host.endsWith(".telegram.org") ||
    host === "contest.com" || host.endsWith(".contest.com");
}

export function normalizeUrl(input, base) {
  let url;
  try {
    url = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || !isAllowedHost(url.hostname)) return null;
  if (url.port && url.port !== "443") return null;
  url.hostname = url.hostname.replace(/\.$/, "");
  url.protocol = "https:";
  url.username = "";
  url.password = "";
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (VOLATILE_QUERY_KEYS.has(lower) || /^\d{4,}_\d{3,}$/.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname === "") url.pathname = "/";
  return url.href;
}

function parseAttributes(tag) {
  const attributes = new Map();
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(tag))) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function addCandidate(value, base, kind, pages, resources) {
  const candidate = normalizeUrl(value, base);
  if (!candidate) return;
  const path = new URL(candidate).pathname;
  if (pages.size + resources.size >= 2_000) return;
  if (kind === "resource" || RESOURCE_EXTENSION.test(path)) {
    resources.add(candidate);
  } else {
    pages.add(candidate);
  }
}

export function extractLinks(html, pageUrl) {
  const pages = new Set();
  const resources = new Set();
  const source = String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, "$1")
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style\s*>/gi, "$1");
  const tagPattern = /<(a|area|link|script|img|source|video|audio|iframe|embed|object|input|meta)\b[^>]*>/gi;
  let match;

  while ((match = tagPattern.exec(source))) {
    const tagName = match[1].toLowerCase();
    const attrs = parseAttributes(match[0]);
    const rel = (attrs.get("rel") ?? "").toLowerCase();
    const resourceLink = tagName === "link" && /(?:stylesheet|icon|preload|modulepreload|manifest|apple-touch-icon)/.test(rel);

    for (const attr of ["href", "src", "poster", "data-src", "data-href", "data-original"]) {
      const value = attrs.get(attr);
      if (!value) continue;
      const forceResource = attr !== "href" || resourceLink || ["script", "img", "source", "video", "audio", "embed", "object", "input"].includes(tagName);
      addCandidate(value, pageUrl, forceResource ? "resource" : "auto", pages, resources);
    }

    const srcset = attrs.get("srcset");
    if (srcset) {
      for (const candidate of srcset.split(",")) {
        const value = candidate.trim().split(/\s+/, 1)[0];
        if (value) addCandidate(value, pageUrl, "resource", pages, resources);
      }
    }

    if (tagName === "meta") {
      const property = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
      if (/(?:og:image|twitter:image|og:video|twitter:player)/.test(property)) {
        addCandidate(attrs.get("content"), pageUrl, "resource", pages, resources);
      }
    }
  }

  return {
    pages: [...pages].sort(),
    resources: [...resources].sort(),
  };
}

export function parseRobotsRules(text, userAgent = "TelegramApiDiffBot") {
  const groups = [];
  let group = null;
  let hasRules = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!group || hasRules) {
        group = { agents: [], rules: [] };
        groups.push(group);
        hasRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (["allow", "disallow"].includes(field) && group) {
      if (value) {
        group.rules.push({ allow: field === "allow", pattern: value });
        hasRules = true;
      }
    }
  }

  const wanted = userAgent.toLowerCase();
  const exact = groups.filter((item) => item.agents.includes(wanted));
  const selected = exact.length ? exact : groups.filter((item) => item.agents.includes("*"));
  return selected.flatMap((item) => item.rules);
}

function robotPatternMatches(pattern, path) {
  if (!pattern) return false;
  const endAnchored = pattern.endsWith("$");
  const source = endAnchored ? pattern.slice(0, -1) : pattern;
  const escaped = source
    .replace(/[.+?^{}$()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  try {
    return new RegExp("^" + escaped + (endAnchored ? "$" : "")).test(path);
  } catch {
    return false;
  }
}

export function isAllowedByRobots(url, rules) {
  const parsed = new URL(url);
  const target = parsed.pathname + parsed.search;
  let selected = null;
  for (const rule of rules) {
    if (!robotPatternMatches(rule.pattern, target)) continue;
    if (!selected || rule.pattern.length > selected.pattern.length ||
        (rule.pattern.length === selected.pattern.length && rule.allow)) {
      selected = rule;
    }
  }
  return selected ? selected.allow : true;
}

async function readResponseText(response, maxBytes, label) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new CrawlerError(label + " exceeds the " + maxBytes + "-byte limit.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CrawlerError(label + " exceeds the " + maxBytes + "-byte limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch (error) {
    throw new CrawlerError(label + " is not valid UTF-8.", { cause: error });
  }
}

async function requestText(inputUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeout ?? 20;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PAGE_BYTES;
  const accept = options.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";
  const originalHost = new URL(inputUrl).hostname;
  let target = new URL(inputUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!isAllowedHost(target.hostname)) {
      throw new CrawlerError("Refusing to fetch a URL outside the Telegram host allowlist: " + target.hostname);
    }
    if (options.requestGate) await options.requestGate(target.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    timer.unref?.();
    try {
      const response = await fetchImpl(target, {
        method: "GET",
        redirect: "manual",
        headers: {
          "Accept": accept,
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location) throw new CrawlerError("Redirect from " + target.href + " had no Location header.");
        if (redirects === MAX_REDIRECTS) throw new CrawlerError("Too many redirects for " + inputUrl + ".");
        let next;
        try {
          next = new URL(location, target);
        } catch {
          throw new CrawlerError("Invalid redirect target returned by " + target.hostname + ".");
        }
        if (!isAllowedHost(next.hostname) || next.hostname !== originalHost || (next.port && next.port !== "443")) {
          throw new CrawlerError("Refusing a cross-host redirect from " + target.hostname + " to " + next.hostname + ".");
        }
        target = next;
        continue;
      }

      if (!response.ok) {
        const error = new CrawlerError("HTTP " + response.status + " while fetching " + target.href + ".");
        error.status = response.status;
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      return {
        url: target.href,
        contentType: response.headers.get("content-type") ?? "",
        text: await readResponseText(response, maxBytes, target.hostname),
      };
    } catch (error) {
      if (error instanceof CrawlerError) throw error;
      if (error?.name === "AbortError") {
        throw new CrawlerError("Request timed out after " + timeout + " seconds: " + target.href, { cause: error });
      }
      throw new CrawlerError("Could not fetch " + target.href + ": " + error.message, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new CrawlerError("Redirect limit exceeded for " + inputUrl + ".");
}

function validateOptions(options) {
  const maxPages = options.maxPages ?? 500;
  const maxDepth = options.maxDepth ?? 2;
  const concurrency = options.concurrency ?? 5;
  const timeout = options.timeout ?? 20;
  const perHostDelayMs = options.perHostDelayMs ?? 150;
  const maxDiscoveredLinks = options.maxDiscoveredLinks ?? 50_000;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5000) {
    throw new TypeError("maxPages must be an integer from 1 to 5000.");
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) {
    throw new TypeError("maxDepth must be an integer from 0 to 10.");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new TypeError("concurrency must be an integer from 1 to 20.");
  }
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 180) {
    throw new TypeError("timeout must be a finite number greater than zero and no more than 180 seconds.");
  }
  if (!Number.isInteger(perHostDelayMs) || perHostDelayMs < 0 || perHostDelayMs > 5000) {
    throw new TypeError("perHostDelayMs must be an integer from 0 to 5000.");
  }
  if (!Number.isInteger(maxDiscoveredLinks) || maxDiscoveredLinks < 100 || maxDiscoveredLinks > 100_000) {
    throw new TypeError("maxDiscoveredLinks must be an integer from 100 to 100000.");
  }
  return { maxPages, maxDepth, concurrency, timeout, perHostDelayMs, maxDiscoveredLinks };
}

async function loadRobots(hostname, options) {
  const url = "https://" + hostname + "/robots.txt";
  try {
    const result = await requestText(url, {
      ...options,
      requestGate: options.requestGate,
      maxBytes: DEFAULT_MAX_ROBOTS_BYTES,
      accept: "text/plain,*/*;q=0.1",
    });
    return { rules: parseRobotsRules(result.text), error: null };
  } catch (error) {
    if (error.status === 404 || error.status === 410) return { rules: [], error: null };
    return { rules: [{ allow: false, pattern: "/" }], error: error.message };
  }
}

export async function crawlSite(options = {}) {
  const limits = validateOptions(options);
  const seeds = options.seeds?.length ? options.seeds : DEFAULT_SEEDS;
  const seedUrls = [...new Set(seeds.map((seed) => normalizeUrl(seed)).filter(Boolean))].sort();
  if (!seedUrls.length) throw new CrawlerError("No valid Telegram seed URLs were supplied.");

  const startedAt = new Date().toISOString();
  const pages = new Set(seedUrls.filter((url) => !RESOURCE_EXTENSION.test(new URL(url).pathname)));
  const resources = new Set(seedUrls.filter((url) => RESOURCE_EXTENSION.test(new URL(url).pathname)));
  const visited = new Set();
  const failures = [];
  const robotsCache = new Map();
  let frontier = [...pages];
  let depth = 0;
  let successfulPages = 0;
  let depthLimited = false;
  let linksLimited = false;
  const hostLocks = new Map();
  const hostLastRequest = new Map();
  const requestGate = async (hostname) => {
    const previous = hostLocks.get(hostname) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const elapsed = Date.now() - (hostLastRequest.get(hostname) ?? 0);
      const wait = Math.max(0, limits.perHostDelayMs - elapsed);
      if (wait) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
      hostLastRequest.set(hostname, Date.now());
    });
    hostLocks.set(hostname, next);
    await next;
  };

  const getRobots = async (hostname) => {
    if (!robotsCache.has(hostname)) {
      robotsCache.set(hostname, loadRobots(hostname, {
        ...limits,
        fetchImpl: options.fetchImpl,
        requestGate,
      }));
    }
    return robotsCache.get(hostname);
  };

  while (frontier.length && visited.size < limits.maxPages && depth <= limits.maxDepth) {
    const candidates = frontier.filter((url) => !visited.has(url));
    if (!candidates.length) break;

    const policyResults = await Promise.all(candidates.map(async (url) => {
      const robots = await getRobots(new URL(url).hostname);
      if (robots.error) {
        failures.push({ url, error: "robots.txt could not be checked: " + robots.error });
        return false;
      }
      return isAllowedByRobots(url, robots.rules);
    }));
    const remaining = limits.maxPages - visited.size;
    const current = candidates.filter((_url, index) => {
      if (!policyResults[index]) pages.delete(_url);
      return policyResults[index];
    }).slice(0, remaining);
    if (!current.length) break;
    current.forEach((url) => visited.add(url));
    const discoveredNext = new Set();

    for (let offset = 0; offset < current.length; offset += limits.concurrency) {
      const batch = current.slice(offset, offset + limits.concurrency);
      const results = await Promise.all(batch.map(async (url) => {
        try {
          const page = await requestText(url, {
            ...limits,
            fetchImpl: options.fetchImpl,
            requestGate,
            maxBytes: options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES,
          });
          if (!/(?:text\/html|application\/xhtml\+xml)/i.test(page.contentType)) return null;
          successfulPages += 1;
          return { requestedUrl: url, finalUrl: normalizeUrl(page.url), html: page.text };
        } catch (error) {
          failures.push({ url, error: error.message });
          return null;
        }
      }));

      for (const result of results) {
        if (!result) continue;
        if (result.finalUrl) pages.add(result.finalUrl);
        const found = extractLinks(result.html, result.finalUrl ?? result.requestedUrl);
        for (const resource of found.resources) {
          if (resources.has(resource)) continue;
          if (pages.size + resources.size >= limits.maxDiscoveredLinks) {
            linksLimited = true;
            break;
          }
          resources.add(resource);
        }
        const remainingLinks = Math.max(0, limits.maxDiscoveredLinks - pages.size - resources.size);
        if (found.pages.length > remainingLinks) linksLimited = true;
        const pageCandidates = found.pages.slice(0, remainingLinks);
        const pageChecks = await Promise.all(pageCandidates.map(async (page) => {
          const policy = await getRobots(new URL(page).hostname);
          return { page, allowed: !policy.error && isAllowedByRobots(page, policy.rules) };
        }));
        for (const { page, allowed } of pageChecks) {
          if (!allowed) continue;
          if (!pages.has(page)) pages.add(page);
          if (depth < limits.maxDepth && !visited.has(page)) discoveredNext.add(page);
          else if (depth >= limits.maxDepth) depthLimited = true;
        }
      }
    }

    frontier = [...discoveredNext].sort();
    depth += 1;
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    limits,
    seeds: seedUrls,
    pages: [...pages].sort(),
    resources: [...resources].sort(),
    pagesAttempted: visited.size,
    pagesFetched: successfulPages,
    failures,
    truncated: frontier.length > 0 || visited.size >= limits.maxPages || depthLimited || linksLimited,
  };
}

function toTrackedPath(value) {
  const url = new URL(value);
  return url.host + url.pathname + url.search;
}

async function readExistingCount(path) {
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).length;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertSafeGrowth(path, nextCount, minRetainRatio) {
  const previousCount = await readExistingCount(path);
  if (previousCount === null || previousCount < 20) return;
  if (nextCount < Math.floor(previousCount * minRetainRatio)) {
    throw new CrawlerError(
      "Refusing to replace " + path + ": discovered " + nextCount + " entries, below " +
      Math.round(minRetainRatio * 100) + "% of the previous " + previousCount + ". Run with a wider crawl or inspect the failures.",
    );
  }
}

export async function saveCrawlResults(result, root = ".", options = {}) {
  if (!result.pagesFetched) {
    throw new CrawlerError("No HTML pages were fetched successfully; existing link lists were left unchanged.");
  }
  const base = resolve(root);
  const pagePath = join(base, "tracked_links.txt");
  const resourcePath = join(base, "tracked_res_links.txt");
  const minRetainRatio = options.minRetainRatio ?? 0.5;
  if (!Number.isFinite(minRetainRatio) || minRetainRatio <= 0 || minRetainRatio > 1) {
    throw new TypeError("minRetainRatio must be greater than zero and no more than one.");
  }

  const pageContent = result.pages.map(toTrackedPath).sort().join("\n") + "\n";
  const resourceContent = result.resources.map(toTrackedPath).sort().join("\n") + (result.resources.length ? "\n" : "");
  await assertSafeGrowth(pagePath, result.pages.length, minRetainRatio);
  await assertSafeGrowth(resourcePath, result.resources.length, minRetainRatio);

  await mkdir(base, { recursive: true });
  await atomicWrite(pagePath, pageContent);
  await atomicWrite(resourcePath, resourceContent);
  await atomicWrite(join(base, "crawler-report.json"), JSON.stringify(result, null, 2) + "\n");
  return { pagePath, resourcePath, pages: result.pages.length, resources: result.resources.length };
}