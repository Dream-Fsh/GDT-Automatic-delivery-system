import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");

test("conversion actions resolve the titled conversion drawer instead of the first drawer", () => {
  assert.match(source, /const findConversionPanel = \(\) =>/);

  const allocation = source.slice(
    source.indexOf('if (input.type === "clickAllocationRule")'),
    source.indexOf('if (input.type === "conversionReady")')
  );
  assert.match(allocation, /const drawer = findConversionPanel\(\);/);

  const ready = source.slice(
    source.indexOf('if (input.type === "conversionReady")'),
    source.indexOf("  return { ok:false };", source.indexOf('if (input.type === "conversionReady")'))
  );
  assert.match(ready, /const dialog = findConversionPanel\(\) \|\| document;/);
});
