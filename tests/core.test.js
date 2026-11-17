import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeSchema, compareSchemas, parseApiLayer, renderReport, schemaCounts, SchemaError,
} from "../src/core.js";

const oldSchema = {
  layer: 225,
  constructors: [{ predicate: "old.item", id: 1 }],
  methods: [{
    method: "messages.sendMessage",
    params: [{ name: "message", type: "string" }],
    type: "Updates",
  }],
  version: "a",
};
const newSchema = {
  layer: 226,
  constructors: [{ predicate: "new.item", id: 2 }],
  methods: [{
    method: "messages.sendMessage",
    params: [
      { name: "message", type: "string" },
      { name: "silent", type: "Bool" },
    ],
    type: "Updates",
  }],
  version: "b",
};

test("canonicalizes declaration order deterministically", () => {
  const schema = canonicalizeSchema({
    constructors: [{ predicate: "z" }, { predicate: "a" }],
    methods: [{ method: "ping" }],
  });
  assert.deepEqual(schema.constructors.map((item) => item.predicate), ["a", "z"]);
});

test("rejects duplicate, empty, and malformed schemas", () => {
  assert.throws(() => canonicalizeSchema({
    constructors: [{ predicate: "dup" }, { predicate: "dup" }],
    methods: [{ method: "ping" }],
  }), SchemaError);
  assert.throws(() => canonicalizeSchema({ constructors: [], methods: [] }), SchemaError);
  assert.throws(() => canonicalizeSchema([]), SchemaError);
});

test("parses current layer text", () => {
  assert.equal(parseApiLayer("History\nLayer 225\nLayer 224"), 225);
  assert.equal(parseApiLayer("<h3>Layer 226</h3>"), 226);
  assert.throws(() => parseApiLayer("nothing here"), SchemaError);
});

test("detects declaration and metadata changes", () => {
  const diff = compareSchemas(oldSchema, newSchema);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.changed.length, 1);
  assert.deepEqual(diff.metadataChanges, ["version"]);
  assert.equal(diff.previousLayer, 225);
  assert.equal(diff.currentLayer, 226);
  assert.equal(diff.hasChanges, true);
});

test("counts constructor and method declarations", () => {
  assert.deepEqual(schemaCounts(newSchema), { constructors: 1, methods: 1 });
});

test("renders parameter-level differences", () => {
  const report = renderReport(
    compareSchemas(oldSchema, newSchema),
    "2026-11-06T00:00:00Z",
    "https://core.telegram.org/schema/json",
  );
  assert.match(report, /Added declarations/);
  assert.match(report, /Removed declarations/);
  assert.match(report, /Modified declarations/);
  assert.match(report, /Parameter added: `silent: Bool`/);
});
