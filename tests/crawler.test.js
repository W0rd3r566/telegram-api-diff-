import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  crawlSite, extractLinks, isAllowedByRobots, isAllowedHost, normalizeUrl,
  parseRobotsRules, saveCrawlResults,
} from "../src/crawler.js";

test("restricts crawling to Telegram-owned hosts", () => {
  assert.equal(isAllowedHost("telegram.org"), true);
  assert.equal(isAllowedHost("core.telegram.org"), true);
  assert.equal(isAllowedHost("contest.com"), true);
  assert.equal(isAllowedHost("nottelegram.org"), false);
  assert.equal(isAllowedHost("example.com"), false);
});

test("canonicalizes URLs and removes known volatile query values", () => {
  assert.equal(
    normalizeUrl("http://core.telegram.org/api?token=abc&keep=1&12345_67890#section"),
    "https://core.telegram.org/api?keep=1",
  );
  assert.equal(normalizeUrl("https://example.com/"), null);
  assert.equal(normalizeUrl("https://telegram.org:8443/"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
});

test("extracts internal pages and static resources from HTML", () => {
  const result = extractLinks(
    '<a href="/api">API</a>' +
    '<a href="https://core.telegram.org/schema/json">Schema</a>' +
    '<link rel="stylesheet" href="/css/site.css?hash=volatile">' +
    '<script src="/js/app.js"></script>' +
    '<img src="/img/logo.png" srcset="/img/logo@2x.png 2x">' +
    '<a href="https://example.com/out">External</a>' +
    '<a href="mailto:test@example.com">Mail</a>',
    "https://telegram.org/",
  );

  assert.deepEqual(result.pages, [
    "https://core.telegram.org/schema/json",
    "https://telegram.org/api",
  ]);
  assert.deepEqual(result.resources, [
    "https://telegram.org/css/site.css",
    "https://telegram.org/img/logo.png",
    "https://telegram.org/img/logo@2x.png",
    "https://telegram.org/js/app.js",
  ]);
});

test("parses robots.txt rules and prefers the most specific match", () => {
  const rules = parseRobotsRules(
    "User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /assets/*.zip$",
  );
  assert.equal(isAllowedByRobots("https://telegram.org/private/page", rules), false);
  assert.equal(isAllowedByRobots("https://telegram.org/private/public/page", rules), true);
  assert.equal(isAllowedByRobots("https://telegram.org/assets/archive.zip", rules), false);
  assert.equal(isAllowedByRobots("https://telegram.org/about", rules), true);
});

test("crawlSite respects page limits, robots and host restrictions", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.href);
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /blocked", { status: 200, headers: { "content-type": "text/plain" } });
    }
    const pages = {
      "/": "<a href=\"/one\">one</a><a href=\"/blocked\">blocked</a><img src=\"/assets/logo.png\">",
      "/one": "<a href=\"/two\">two</a>",
    };
    const html = pages[url.pathname];
    if (!html) return new Response("not found", { status: 404 });
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };

  const result = await crawlSite({
    seeds: ["https://telegram.org/"],
    maxPages: 2,
    maxDepth: 3,
    concurrency: 2,
    perHostDelayMs: 0,
    fetchImpl,
  });

  assert.equal(result.pagesAttempted, 2);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.truncated, true);
  assert.ok(result.pages.includes("https://telegram.org/one"));
  assert.ok(result.resources.includes("https://telegram.org/assets/logo.png"));
  assert.ok(!calls.some((url) => url.endsWith("/blocked")));
});

test("rejects invalid crawler limits", async () => {
  await assert.rejects(() => crawlSite({ maxPages: 0 }), TypeError);
  await assert.rejects(() => crawlSite({ concurrency: 21 }), TypeError);
  await assert.rejects(() => crawlSite({ maxDiscoveredLinks: 99 }), TypeError);
});

test("does not follow redirects outside the allowlist", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
    return new Response(null, {
      status: 302,
      headers: { location: "https://example.com/external" },
    });
  };
  const result = await crawlSite({ seeds: ["https://telegram.org/"], perHostDelayMs: 0, fetchImpl });
  assert.equal(result.pagesFetched, 0);
  assert.match(result.failures[0].error, /cross-host redirect/);
});

test("saves URL inventories and refuses a suspiciously smaller replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-api-diff-crawler-"));
  try {
    const result = {
      pages: ["https://telegram.org/", "https://telegram.org/about"],
      resources: ["https://telegram.org/js/app.js"],
      pagesFetched: 2,
      pagesAttempted: 2,
      failures: [],
      limits: { maxPages: 10 },
    };
    const saved = await saveCrawlResults(result, root);
    assert.equal(saved.pages, 2);
    assert.equal(await readFile(join(root, "tracked_links.txt"), "utf8"), "telegram.org/\ntelegram.org/about\n");

    await writeFile(join(root, "tracked_links.txt"), Array.from({ length: 40 }, (_x, index) => "telegram.org/p" + index).join("\n") + "\n");
    await assert.rejects(
      () => saveCrawlResults(result, root),
      /below 50% of the previous 40/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not save an empty crawl result", async () => {
  await assert.rejects(
    () => saveCrawlResults({ pages: [], resources: [], pagesFetched: 0 }, "."),
    /No HTML pages were fetched successfully/,
  );
});

test("keeps file-like seeds in the resource inventory", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
    return new Response("<html><body>ok</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  const result = await crawlSite({
    seeds: ["https://telegram.org/", "https://telegram.org/config.json"],
    perHostDelayMs: 0,
    fetchImpl,
  });
  assert.ok(result.resources.includes("https://telegram.org/config.json"));
  assert.ok(!result.pages.includes("https://telegram.org/config.json"));
  assert.equal(result.pagesFetched, 1);
});
