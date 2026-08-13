import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../app.html", import.meta.url), "utf8");
const manifest = await readFile(new URL("../manifest.json", import.meta.url), "utf8");

test("DingTalk webhook is configurable and never hardcoded", () => {
  assert.match(html, /id="dingTalkWebhook"/);
  assert.match(app, /dingTalkWebhook/);
  assert.doesNotMatch(background, /access_token=/);
});

test("workflow sends DingTalk notifications only for completion and errors", () => {
  assert.match(background, /async function sendDingTalkNotification/);
  assert.match(background, /runStep\(title, work\)/);
  assert.match(background, /预览完成/);
  assert.match(background, /已暂停/);
  assert.doesNotMatch(background, /自动化开始步骤/);
  assert.doesNotMatch(background, /自动化步骤完成/);
  assert.match(manifest, /oapi\.dingtalk\.com/);
});
