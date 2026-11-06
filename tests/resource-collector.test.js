import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectResources, ResourceCollectorError, saveResourceResults,
} from "../src/resource-collector.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "telegram-resource-collector-"));
  await writeFile(join(root, "tracked_links.txt"), "telegram.org/about\n", "utf8");
  await writeFile(
    join(root, "tracked_res_links.txt"),
    "telegram.org/help.getAppConfig.json\ntelegram.org/assets/logo.png\ntelegram.org/assets/duplicate-logo.png\n",
    "utf8",
  );
  return root;
}

function notFound() {
  return new Response(null, { status: 404 });
}

function response(body, contentType, headers = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType, ...headers },
  });
}

function fixtureFetch(options = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({
      url: url.href,
      headers: new Headers(init.headers),
    });
    if (url.pathname === "/robots.txt") return options.robots ?? notFound();
    if (options.handler) return options.handler(url, init);
    if (url.pathname === "/about") {
      return response(
        "<html><time datetime='now'>volatile</time><p>Stable page</p><!-- page generated in 5 ms --></html>",
        "text/html; charset=utf-8",
        { etag: '"page-v1"' },
      );
    }
    if (url.pathname.endsWith("help.getAppConfig.json")) {
      return response(
        JSON.stringify({ hash: "rotating", ton_usd_rate: 5, stable: true, nested: { hash: "keep" } }),
        "application/json",
        { etag: '"config-v1"' },
      );
    }
    if (url.pathname === "/assets/logo.png" || url.pathname === "/assets/duplicate-logo.png") {
      return response(new Uint8Array([0, 1, 2, 255]), "image/png", { etag: '"image-v1"' });
    }
    return notFound();
  };
  return { fetchImpl, calls };
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

test("downloads pages and resources, normalizes text, hashes content, and archives objects once", async () => {
  const root = await fixture();
  try {
    const { fetchImpl } = fixtureFetch();
    const result = await collectResources({ root, fetchImpl, perHostDelayMs: 0 });
    assert.equal(result.manifest.trackedCount, 4);
    assert.equal(result.manifest.attemptedCount, 4);
    assert.equal(result.changes.added, 4);
    assert.equal(result.manifest.partial, false);

    const page = result.manifest.resources.find((item) => item.url.endsWith("/about"));
    const config = result.manifest.resources.find((item) => item.url.endsWith("help.getAppConfig.json"));
    const image = result.manifest.resources.find((item) => item.url.endsWith("/assets/logo.png"));
    const duplicateImage = result.manifest.resources.find((item) => item.url.endsWith("/assets/duplicate-logo.png"));
    assert.ok(page.normalized);
    assert.ok(config.normalized);
    assert.equal(image.normalized, false);

    const saved = await saveResourceResults(result, root);
    assert.equal(saved.objectsWritten, 3);
    assert.equal(image.object, duplicateImage.object);
    const pageBody = await readFile(join(root, page.object), "utf8");
    assert.doesNotMatch(pageBody, /<time\b|page generated in/);
    const configBody = JSON.parse(await readFile(join(root, config.object), "utf8"));
    assert.deepEqual(configBody, { stable: true, nested: { hash: "keep" } });
    assert.deepEqual(
      [...await readFile(join(root, image.object))],
      [0, 1, 2, 255],
    );

    const manifest = JSON.parse(await readFile(join(root, "resource_snapshots/latest.json"), "utf8"));
    assert.equal(manifest.resources.length, 3);
    assert.ok(await readFile(join(root, "resource_reports/latest.md"), "utf8"));
  } finally {
    await cleanup(root);
  }
});

test("uses ETag conditional requests and reuses the previous object on HTTP 304", async () => {
  const root = await fixture();
  try {
    let first = fixtureFetch();
    const initial = await collectResources({ root, fetchImpl: first.fetchImpl, perHostDelayMs: 0 });
    await saveResourceResults(initial, root);

    const previous = initial.manifest.resources.find((item) => item.url.endsWith("/about"));
    const second = fixtureFetch({
      handler: async (url, init) => {
        if (url.pathname === "/about") {
          assert.equal(new Headers(init.headers).get("if-none-match"), '"page-v1"');
          return new Response(null, { status: 304 });
        }
        if (url.pathname.endsWith("help.getAppConfig.json") || url.pathname.startsWith("/assets/")) {
          return new Response(null, { status: 304 });
        }
        return notFound();
      },
    });
    const next = await collectResources({ root, fetchImpl: second.fetchImpl, perHostDelayMs: 0 });
    assert.equal(next.changes.unchanged, 3);
    assert.equal(next.changes.changed, 0);
    assert.equal(next.manifest.bytesDownloaded, 0);
    const unchangedPage = next.manifest.resources.find((item) => item.url.endsWith("/about"));
    assert.equal(unchangedPage.sha256, previous.sha256);
    assert.equal(unchangedPage.object, previous.object);
    await saveResourceResults(next, root);
  } finally {
    await cleanup(root);
  }
});

test("detects normalized content changes and returns a stable diff", async () => {
  const root = await fixture();
  try {
    const first = fixtureFetch();
    const before = await collectResources({ root, fetchImpl: first.fetchImpl, perHostDelayMs: 0 });
    await saveResourceResults(before, root);

    const second = fixtureFetch({
      handler: async (url) => {
        if (url.pathname === "/robots.txt") return notFound();
        if (url.pathname === "/about") {
          return response("<p>Changed page</p>", "text/html", { etag: '"page-v2"' });
        }
        if (url.pathname.endsWith("help.getAppConfig.json")) {
          return response(
            JSON.stringify({ hash: "different-rotating-value", ton_usd_rate: 99, stable: true, nested: { hash: "keep" } }),
            "application/json",
            { etag: '"config-v2"' },
          );
        }
        if (url.pathname.startsWith("/assets/")) return response(new Uint8Array([0, 1, 2, 255]), "image/png");
        return notFound();
      },
    });
    const after = await collectResources({ root, fetchImpl: second.fetchImpl, perHostDelayMs: 0 });
    assert.equal(after.changes.changed, 1);
    assert.equal(after.changes.unchanged, 2);
    assert.ok(after.changes.changedItems[0].url.endsWith("/about"));
  } finally {
    await cleanup(root);
  }
});

test("records resources removed by HTTP 404 without deleting their prior history", async () => {
  const root = await fixture();
  try {
    const first = fixtureFetch();
    const before = await collectResources({ root, fetchImpl: first.fetchImpl, perHostDelayMs: 0 });
    await saveResourceResults(before, root);

    const second = fixtureFetch({
      handler: async (url) => {
        if (url.pathname === "/robots.txt") return notFound();
        if (url.pathname === "/assets/logo.png") return notFound();
        if (url.pathname === "/assets/duplicate-logo.png") return response(new Uint8Array([0, 1, 2, 255]), "image/png");
        if (url.pathname === "/about") return response("<p>Stable page</p>", "text/html");
        if (url.pathname.endsWith("help.getAppConfig.json")) {
          return response(JSON.stringify({ stable: true, nested: { hash: "keep" } }), "application/json");
        }
        return notFound();
      },
    });
    const after = await collectResources({ root, fetchImpl: second.fetchImpl, perHostDelayMs: 0 });
    assert.equal(after.changes.removed, 1);
    const removed = after.manifest.resources.find((item) => item.url.endsWith("/assets/logo.png"));
    assert.equal(removed.fetchStatus, "not_found");
    assert.equal(removed.sha256, null);
  } finally {
    await cleanup(root);
  }
});

test("round-robins over large inventories instead of starving later URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-resource-rotation-"));
  try {
    await writeFile(join(root, "tracked_links.txt"), "", "utf8");
    await writeFile(
      join(root, "tracked_res_links.txt"),
      ["telegram.org/a.txt", "telegram.org/b.txt", "telegram.org/c.txt"].join("\n") + "\n",
      "utf8",
    );
    const seen = [];
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/robots.txt") return notFound();
      seen.push(url.pathname);
      return response("content:" + url.pathname, "text/plain");
    };

    const first = await collectResources({
      root, fetchImpl, maxResources: 2, perHostDelayMs: 0,
    });
    assert.equal(first.manifest.partial, true);
    assert.equal(first.manifest.attemptedCount, 2);
    await saveResourceResults(first, root);

    const second = await collectResources({
      root, fetchImpl, maxResources: 2, perHostDelayMs: 0,
    });
    assert.ok(seen.includes("/c.txt"));
    assert.equal(second.manifest.attemptedCount, 2);
  } finally {
    await cleanup(root);
  }
});

test("fails closed for robots errors and cross-host redirects", async () => {
  const root = await fixture();
  try {
    const blocked = fixtureFetch({
      robots: new Response("temporarily unavailable", { status: 503 }),
    });
    const result = await collectResources({ root, fetchImpl: blocked.fetchImpl, perHostDelayMs: 0 });
    assert.equal(result.failures.length, 4);
    assert.ok(blocked.calls.every((call) => call.url.endsWith("/robots.txt")));
    await assert.rejects(
      saveResourceResults(result, root),
      /No resources could be checked successfully/,
    );

    const redirect = fixtureFetch({
      handler: async (url) => {
        if (url.pathname === "/robots.txt") return notFound();
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/out" },
        });
      },
    });
    const redirected = await collectResources({ root, fetchImpl: redirect.fetchImpl, perHostDelayMs: 0 });
    assert.equal(redirected.failures.length, 4);
    assert.match(redirected.failures[0].error, /cross-host or insecure redirect/);
  } finally {
    await cleanup(root);
  }
});

test("enforces per-file and total response byte limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-resource-limits-"));
  try {
    await writeFile(join(root, "tracked_links.txt"), "", "utf8");
    await writeFile(join(root, "tracked_res_links.txt"), "telegram.org/large.bin\n", "utf8");
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/robots.txt") return notFound();
      return response(new Uint8Array([1, 2, 3, 4]), "application/octet-stream");
    };
    const result = await collectResources({
      root,
      fetchImpl,
      perHostDelayMs: 0,
      maxPageBytes: 3,
      maxResourceBytes: 3,
      maxTotalBytes: 3,
    });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].error, /per-file limit/);
    await assert.rejects(saveResourceResults(result, root), ResourceCollectorError);
  } finally {
    await cleanup(root);
  }
});

test("rejects empty inventories and invalid collection limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-resource-empty-"));
  try {
    await writeFile(join(root, "tracked_links.txt"), "", "utf8");
    await writeFile(join(root, "tracked_res_links.txt"), "", "utf8");
    await assert.rejects(
      collectResources({ root, maxResources: 0 }),
      TypeError,
    );
    await assert.rejects(
      collectResources({ root }),
      /No valid URLs found/,
    );
  } finally {
    await cleanup(root);
  }
});
