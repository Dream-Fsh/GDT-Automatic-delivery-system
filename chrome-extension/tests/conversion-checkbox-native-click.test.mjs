import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");

test("conversion checkbox selection clicks the native checkbox control", () => {
  const block = source.slice(
    source.indexOf('if (input.type === "selectCheckboxLabels")'),
    source.indexOf('if (input.type === "goToLastProductPage")')
  );
  assert.match(block, /nativeInput\.click\(\)/);
  assert.match(block, /nativeInput\.checked \|\| label\.classList\.contains\("is-checked"\)/);
});
