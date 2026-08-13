import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");

test("multi-account conversion selects its allocation rule before the conversion checkbox", () => {
  const start = source.indexOf("async function configureOptimizationGoalAndConversion");
  const end = source.indexOf("async function runStep", start);
  const workflow = source.slice(start, end);
  const selectConversion = workflow.indexOf('type:"selectCheckboxLabels"');
  const selectAllocation = workflow.indexOf('type:"clickAllocationRule"');

  assert.ok(selectConversion >= 0, "workflow must select the conversion checkbox");
  assert.ok(selectAllocation >= 0, "multi-account workflow must select an allocation rule");
  assert.ok(selectAllocation < selectConversion, "allocation rule must be selected before the conversion checkbox");
});
