#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { checkSchema, SCHEMA_URL, updateSchema } from "./core.js";
import { crawlSite, saveCrawlResults } from "./crawler.js";

const HELP = [
  "Telegram API Diff",
  "",
  "Usage:",
  "  node src/index.js <update|check|crawl> [options]",
  "",
  "Commands:",
  "  update              Fetch and save the current MTProto schema",
  "  check               Check the MTProto schema without writing snapshots",
  "  crawl               Discover Telegram pages and static resource URLs",
  "",
  "General options:",
  "  --root PATH         Data directory (default: .)",
  "  --timeout SECONDS   Request timeout (default: 20 for crawl, 30 otherwise)",
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
].join("\n");

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") return { help: true };
  if (!["update", "check", "crawl"].includes(command)) {
    throw new TypeError("Unknown command: " + command + "\n\n" + HELP);
  }

  const options = {
    root: ".",
    schemaUrl: SCHEMA_URL,
    timeout: command === "crawl" ? 20 : 30,
    maxPages: 500,
    maxDepth: 2,
    concurrency: 5,
    perHostDelayMs: 150,
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
      ["maxPages", "maxDepth", "concurrency", "perHostDelayMs"].includes(option) ? Number(value) : value;
    if (["timeout", "maxPages", "maxDepth", "concurrency", "perHostDelayMs"].includes(option) && !Number.isFinite(options[option])) {
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

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      console.log(HELP);
      return 0;
    }
    if (parsed.command === "update") return await updateSchema(parsed.options);
    if (parsed.command === "check") return await checkSchema(parsed.options);
    return await runCrawler(parsed.options);
  } catch (error) {
    console.error("error: " + error.message);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
