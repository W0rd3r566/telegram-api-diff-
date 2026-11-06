#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { checkSchema, SCHEMA_URL, updateSchema } from "./core.js";
import { crawlSite, saveCrawlResults } from "./crawler.js";
import { collectResources, saveResourceResults } from "./resource-collector.js";

const HELP = [
  "Telegram API Diff",
  "",
  "Usage:",
  "  node src/index.js <update|check|crawl|collect> [options]",
  "",
  "Commands:",
  "  update              Fetch and save the current MTProto schema",
  "  check               Check the MTProto schema without writing snapshots",
  "  crawl               Discover Telegram pages and static resource URLs",
  "  collect             Download, normalize, hash and archive tracked pages and resources",
  "",
  "General options:",
  "  --root PATH         Data directory (default: .)",
  "  --timeout SECONDS   Request timeout (default: 20 for crawl/collect, 30 otherwise)",
  "  -h, --help          Show this help",
  "",
  "Schema options:",
  "  --schema-url URL    Alternate MTProto schema endpoint",
  "",
  "Crawler options:",
  "  --max-pages N       Maximum pages to fetch, 1..5000 (default: 500)",
  "  --max-depth N       Link depth, 0..10 (default: 2)",
  "  --concurrency N     Parallel requests, 1..20 (default: 5)",
  "  --delay-ms N        Minimum delay between requests to one host (default: 150)",
  "  --seed URL          Add a crawl seed; repeat to add more seeds",
  "",
  "Resource collector options:",
  "  --max-resources N    Maximum URLs per run, rotated between runs (default: 1000)",
  "  --max-resource-mb N  Per-resource download limit in MiB (default: 4)",
  "  --max-total-mb N     Total download budget in MiB (default: 64)",
].join("\n");

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") return { help: true };
  if (!["update", "check", "crawl", "collect"].includes(command)) {
    throw new TypeError("Unknown command: " + command + "\n\n" + HELP);
  }

  const options = {
    root: ".",
    schemaUrl: SCHEMA_URL,
    timeout: command === "crawl" || command === "collect" ? 20 : 30,
    maxPages: 500,
    maxDepth: 2,
    concurrency: command === "collect" ? 4 : 5,
    perHostDelayMs: 150,
    maxResources: 1000,
    maxResourceMb: 4,
    maxTotalMb: 64,
    seeds: [],
  };
  const valueOptions = new Map([
    ["--root", "root"],
    ["--schema-url", "schemaUrl"],
    ["--timeout", "timeout"],
    ["--max-pages", "maxPages"],
    ["--max-depth", "maxDepth"],
    ["--concurrency", "concurrency"],
    ["--delay-ms", "perHostDelayMs"],
    ["--max-resources", "maxResources"],
    ["--max-resource-mb", "maxResourceMb"],
    ["--max-total-mb", "maxTotalMb"],
  ]);

  while (args.length) {
    const key = args.shift();
    if (key === "-h" || key === "--help") return { help: true };
    if (key === "--seed") {
      const seed = args.shift();
      if (seed === undefined || seed.startsWith("--")) throw new TypeError("Missing value for --seed.");
      options.seeds.push(seed);
      continue;
    }
    const option = valueOptions.get(key);
    if (!option) throw new TypeError("Unknown option: " + key + "\n\n" + HELP);
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) throw new TypeError("Missing value for " + key + ".");
    options[option] = ["timeout"].includes(option) ? Number(value) :
      ["maxPages", "maxDepth", "concurrency", "perHostDelayMs", "maxResources", "maxResourceMb", "maxTotalMb"].includes(option) ? Number(value) : value;
    if (["timeout", "maxPages", "maxDepth", "concurrency", "perHostDelayMs", "maxResources", "maxResourceMb", "maxTotalMb"].includes(option) && !Number.isFinite(options[option])) {
      throw new TypeError("Invalid numeric value for " + key + ".");
    }
  }
  return { command, options };
}

async function runCrawler(options) {
  const result = await crawlSite(options);
  const saved = await saveCrawlResults(result, options.root);
  console.log("Fetched pages: " + result.pagesFetched + "/" + result.pagesAttempted);
  console.log("Discovered pages: " + saved.pages);
  console.log("Discovered resources: " + saved.resources);
  console.log("Failed pages: " + result.failures.length);
  if (result.truncated) console.log("Crawl is partial: increase --max-pages or --max-depth for wider coverage.");
  if (result.failures.length) {
    for (const failure of result.failures.slice(0, 10)) {
      console.error("- " + failure.url + ": " + failure.error);
    }
    if (result.failures.length > 10) console.error("- ... " + (result.failures.length - 10) + " more failures in crawler-report.json");
  }
  console.log("Pages: " + saved.pagePath);
  console.log("Resources: " + saved.resourcePath);
  return 0;
}

async function runCollector(options) {
  const result = await collectResources({
    root: options.root,
    timeout: options.timeout,
    concurrency: options.concurrency,
    perHostDelayMs: options.perHostDelayMs,
    maxResources: options.maxResources,
    maxResourceBytes: Math.round(options.maxResourceMb * 1024 * 1024),
    maxTotalBytes: Math.round(options.maxTotalMb * 1024 * 1024),
  });
  const saved = await saveResourceResults(result, options.root);
  console.log("Tracked URLs: " + result.manifest.trackedCount);
  console.log("Checked this run: " + result.manifest.attemptedCount);
  console.log("Added: " + result.changes.added + "; changed: " + result.changes.changed +
    "; removed: " + result.changes.removed + "; unchanged: " + result.changes.unchanged);
  console.log("Downloaded: " + saved.bytesDownloaded + " bytes; archived objects: " + saved.objectsWritten);
  console.log("Errors: " + result.failures.length + "; partial: " + saved.partial);
  console.log("Manifest: " + saved.latestPath);
  console.log("Report: " + saved.latestReportPath);
  for (const failure of result.failures.slice(0, 10)) {
    console.error("- " + (failure.url ?? failure.input) + ": " + failure.error);
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      console.log(HELP);
      return 0;
    }
    if (parsed.command === "update") return await updateSchema(parsed.options);
    if (parsed.command === "check") return await checkSchema(parsed.options);
    if (parsed.command === "crawl") return await runCrawler(parsed.options);
    return await runCollector(parsed.options);
  } catch (error) {
    console.error("error: " + error.message);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
