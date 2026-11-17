import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp, mkdir, readFile, readdir, rm, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_URL, SchemaError, atomicWrite, canonicalizeSchema, checkSchema,
  fetchSchema, fetchText, loadSchema, schemaToJson, updateSchema,
  writeGitHubOutputs,
} from "../src/core.js";

const baseline = {
  constructors: [{ predicate: "sample", id: "01", params: [], type: "Sample" }],
  methods: [],
};

async function withFetch(fetchImpl, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

function officialFetch(schema = baseline, layer = 225) {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/schema/json") {
      return new Response(JSON.stringify(schema), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (url.pathname === "/scheme") {
      return new Response("# TL schema\n* Layer " + layer + "\n", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

async function makeTempDirectory() {
  return mkdtemp(join(tmpdir(), "telegram-api-diff-compat-"));
}

test("schema serialization is deterministic when declaration order changes", () => {
  const first = {
    layer: 225,
    constructors: [
      { predicate: "zeta", id: "02", params: [], type: "Z" },
      { predicate: "alpha", id: "01", params: [], type: "A" },
    ],
    methods: [{ method: "getFoo", id: "03", params: [], type: "Foo" }],
  };
  const second = {
    ...first,
    constructors: [...first.constructors].reverse(),
  };
  assert.equal(schemaToJson(first), schemaToJson(second));
});

test("schema validation rejects missing arrays, malformed records and invalid identities", () => {
  assert.throws(
    () => canonicalizeSchema({ constructors: [{ predicate: "x" }] }),
    SchemaError,
  );
  assert.throws(
    () => canonicalizeSchema({ constructors: ["not-a-record"], methods: [] }),
    SchemaError,
  );
  assert.throws(
    () => canonicalizeSchema({ constructors: [{}], methods: [] }),
    SchemaError,
  );
  assert.throws(
    () => canonicalizeSchema({
      constructors: [{ predicate: { unexpected: "object" } }],
      methods: [],
    }),
    SchemaError,
  );
  assert.throws(
    () => canonicalizeSchema({
      constructors: [{ predicate: "duplicate" }, { predicate: "duplicate" }],
      methods: [],
    }),
    SchemaError,
  );
});

test("fetchSchema reads the official API layer alongside the JSON schema", async () => {
  const schema = await withFetch(officialFetch(), () => fetchSchema(SCHEMA_URL));
  assert.equal(schema.layer, 225);
  assert.equal(schema.constructors[0].predicate, "sample");
});

test("fetchSchema rejects malformed JSON from an endpoint", async () => {
  await withFetch(
    async () => new Response("<html>upstream error</html>", { status: 200 }),
    async () => {
      await assert.rejects(
        fetchSchema("https://example.test/schema.json"),
        SchemaError,
      );
    },
  );
});

test("fetchText enforces the response-size limit before parsing", async () => {
  await withFetch(
    async () => new Response("12345", {
      status: 200,
      headers: { "content-length": "5" },
    }),
    async () => {
      await assert.rejects(
        fetchText("https://example.test/large", { maxBytes: 4 }),
        /exceeds the 4-byte safety limit/,
      );
    },
  );
});

test("updateSchema preserves the daily snapshot/report contract and Actions outputs", async () => {
  const root = await makeTempDirectory();
  const previousOutput = process.env.GITHUB_OUTPUT;
  const outputPath = join(root, "github-output.txt");
  const previousLog = console.log;
  process.env.GITHUB_OUTPUT = outputPath;
  console.log = () => {};
  try {
    await mkdir(join(root, "snapshots"), { recursive: true });
    await writeFile(
      join(root, "snapshots", "latest.json"),
      schemaToJson({ ...baseline, layer: 225 }),
      "utf8",
    );
    const code = await withFetch(officialFetch(), () => updateSchema({ root }));
    assert.equal(code, 0);

    const snapshotFiles = await readdir(join(root, "snapshots"));
    assert.ok(snapshotFiles.includes("latest.json"));
    assert.equal(snapshotFiles.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).length, 1);

    const report = await readFile(join(root, "reports", "latest.md"), "utf8");
    assert.match(report, /No schema changes were detected/);
    assert.ok(await readFile(join(root, "reports", "latest.md"), "utf8"));

    const output = await readFile(outputPath, "utf8");
    assert.match(output, /has_changes=false/);
    assert.match(output, /current_layer=225/);
    assert.match(output, /added_count=0/);
  } finally {
    console.log = previousLog;
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    await rm(root, { recursive: true, force: true });
  }
});

test("checkSchema keeps its documented exit codes for missing baselines and detected changes", async () => {
  const root = await makeTempDirectory();
  const previousLog = console.log;
  const previousError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(await checkSchema({ root }), 2);
    await mkdir(join(root, "snapshots"), { recursive: true });
    await writeFile(
      join(root, "snapshots", "latest.json"),
      schemaToJson({ ...baseline, layer: 224 }),
      "utf8",
    );
    const code = await withFetch(
      officialFetch(baseline, 225),
      () => checkSchema({ root }),
    );
    assert.equal(code, 1);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic storage writes readable snapshots and rejects corrupted JSON", async () => {
  const root = await makeTempDirectory();
  const path = join(root, "snapshots", "latest.json");
  try {
    await atomicWrite(path, schemaToJson(baseline));
    const loaded = await loadSchema(path);
    assert.equal(loaded.constructors[0].predicate, "sample");
    await writeFile(path, "{ broken", "utf8");
    await assert.rejects(loadSchema(path), SchemaError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub Actions outputs reject multiline values", async () => {
  await assert.rejects(
    writeGitHubOutputs({ unsafe: "first line\nsecond line" }, join(tmpdir(), "unused-gh-output")),
    /single-line/,
  );
});
