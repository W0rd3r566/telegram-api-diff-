#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { checkSchema, SCHEMA_URL, SchemaError, updateSchema } from "./core.js";

const HELP = [
  "Telegram API Diff",
  "",
  "Usage:",
  "  node src/index.js <update|check> [options]",
  "",
  "Options:",
  "  --root PATH          Data directory containing snapshots/ and reports/ (default: .)",
  "  --schema-url URL     Alternate schema endpoint (default: " + SCHEMA_URL + ")",
  "  --timeout SECONDS    HTTP timeout (default: 30)",
  "  -h, --help           Show this help",
].join("\n");

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") return { help: true };
  if (!["update", "check"].includes(command)) throw new TypeError("Unknown command: " + command + "\n\n" + HELP);

  const options = { root: ".", schemaUrl: SCHEMA_URL, timeout: 30 };
  while (args.length) {
    const key = args.shift();
    if (key === "-h" || key === "--help") return { help: true };
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) throw new TypeError("Missing value for " + key + ".");
    if (key === "--root") options.root = value;
    else if (key === "--schema-url") options.schemaUrl = value;
    else if (key === "--timeout") {
      options.timeout = Number(value);
      if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
        throw new TypeError("--timeout must be a finite number greater than zero.");
      }
    } else throw new TypeError("Unknown option: " + key);
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      console.log(HELP);
      return 0;
    }
    return parsed.command === "update"
      ? await updateSchema(parsed.options)
      : await checkSchema(parsed.options);
  } catch (error) {
    console.error((error instanceof SchemaError ? "error: " : "error: ") + error.message);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
