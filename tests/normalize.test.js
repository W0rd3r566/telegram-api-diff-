import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJsonResource, normalizeText } from "../src/normalize.js";

test("normalizes volatile fields described by the reference archive", () => {
  const source = [
    "<time datetime='now'>today</time>",
    "<!-- page generated in 42 ms -->",
    "https://example.test/a.js?hash=abc&12345_67890&keep=yes",
    "192.0.2.10:8888",
    "sig=secret se=signature",
  ].join("\n");
  const normalized = normalizeText(source);
  assert.doesNotMatch(normalized, /<time\b|page generated in|12345_67890/);
  assert.match(normalized, /hash=<volatile>&keep=yes/);
  assert.match(normalized, /<IP>:8888/);
  assert.match(normalized, /sig=<volatile>/);
  assert.match(normalized, /se=<volatile>/);
});

test("ignores only top-level app-config volatile fields", () => {
  const normalized = normalizeJsonResource(JSON.stringify({
    hash: "random",
    ton_usd_rate: 5,
    nested: { hash: "keep" },
    stable: true,
  }), { fileName: "help.getAppConfig.json" });
  assert.deepEqual(JSON.parse(normalized), { nested: { hash: "keep" }, stable: true });
});

test("does not filter those fields in unrelated JSON resources", () => {
  const normalized = normalizeJsonResource('{"hash":"keep","ton_usd_rate":2}', { fileName: "other.json" });
  assert.deepEqual(JSON.parse(normalized), { hash: "keep", ton_usd_rate: 2 });
});
