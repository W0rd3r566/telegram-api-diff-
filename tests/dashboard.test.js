import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard controller selectors all exist in the HTML document", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../site/index.html", import.meta.url), "utf8"),
    readFile(new URL("../site/app.js", import.meta.url), "utf8"),
  ]);
  const referencedIds = new Set(
    [...app.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]),
  );
  const documentIds = new Set(
    [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
  );
  const missing = [...referencedIds].filter((id) => !documentIds.has(id));
  assert.deepEqual(missing, []);
  assert.match(html, /<script type="module" src="\.\/app\.js"><\/script>/);
});
