let cancelled = false;
let attachedTabId = null;
let activeDingTalkWebhook = "";
const UI_RENDER_MIN_DELAY_MS = 800;
const UI_RENDER_TIMEOUT_MS = 8000;
const UI_RENDER_POLL_MS = 250;
const ACCOUNT_RENDER_MIN_DELAY_MS = 350;
const ACCOUNT_RENDER_TIMEOUT_MS = 4000;
const PRODUCT_RENDER_MIN_DELAY_MS = 1800;
const PRODUCT_RENDER_TIMEOUT_MS = 20000;
const TARGETING_RENDER_MIN_DELAY_MS = 1200;
const TARGETING_RENDER_TIMEOUT_MS = 30000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stabilize(tabId, minDelay = UI_RENDER_MIN_DELAY_MS, timeout = UI_RENDER_TIMEOUT_MS) {
  // Element UI 的弹窗、分页和列表会异步重绘。先等待最小动画时间，
  // 再连续两次确认无可见加载层且页面结构未变化，避免抢在新 DOM 出现前定位。
  await pause(minDelay);
  if (tabId == null) return;
  const deadline = Date.now() + timeout;
  let previous = "";
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const state = await evaluate(tabId, { type:"renderState" });
    if (state?.ok && state.signature === previous && state.loading === 0) {
      stableSamples += 1;
      if (stableSamples >= 2) return;
    } else {
      stableSamples = 0;
      previous = state?.signature || "";
    }
    await pause(UI_RENDER_POLL_MS);
  }
}
const notify = (message, level = "ok") => chrome.runtime.sendMessage({ type:"LOG", message, level }).catch(() => {});
const status = (kind, label, summary) => chrome.runtime.sendMessage({ type:"STATUS", kind, label, summary }).catch(() => {});
const finish = () => chrome.runtime.sendMessage({ type:"FINISHED" }).catch(() => {});
async function sendDingTalkNotification(webhook, title, text) {
  if (!webhook) return;
  try {
    const url = new URL(webhook);
    if (url.protocol !== "https:" || url.hostname !== "oapi.dingtalk.com") return;
    const response = await fetch(url.href, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ msgtype:"markdown", markdown:{ title, text:`### ${title}\n\n${text}` } }),
      signal:AbortSignal.timeout(8000)
    });
    if (!response.ok) await notify(`钉钉播报失败：HTTP ${response.status}`, "warn");
  } catch (error) { await notify(`钉钉播报失败：${error.message}`, "warn"); }
}

async function inspectTarget() {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((tab) => /^https:\/\/cl\.mobgi\.com\/promotion\/ad\/tencent\/create\//.test(tab.url || ""));
  if (candidates.length === 0) throw new Error("未找到创量页面。请先打开并登录创量的“批量新建”页面，再重新执行。");
  if (candidates.length > 1) throw new Error("检测到多个腾讯广告相关页面。请只保留本次要执行的创量页面，避免选错账户。");
  return candidates[0];
}

async function attach(tabId) { await chrome.debugger.attach({ tabId }, "1.3"); attachedTabId = tabId; }
async function detach() { if (attachedTabId !== null) { try { await chrome.debugger.detach({ tabId:attachedTabId }); } catch {} attachedTabId = null; } }
async function evaluate(tabId, input) {
  const expression = `(${pageAgent.toString()})(${JSON.stringify(input)})`;
  const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression, awaitPromise:true, returnByValue:true });
  if (result.exceptionDetails) throw new Error("页面脚本执行失败：" + result.exceptionDetails.text);
  return result.result.value;
}
async function clickPagePoint(tabId, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("页面点击坐标无效。");
  const base = { x:point.x, y:point.y, button:"left", clickCount:1 };
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type:"mouseMoved", x:point.x, y:point.y });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type:"mousePressed", buttons:1, ...base });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type:"mouseReleased", buttons:0, ...base });
}

async function waitFor(tabId, labels, timeout = 9000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cancelled) throw new Error("任务已由操作人停止。");
    const result = await evaluate(tabId, { type:"hasText", labels });
    if (result?.ok) { await notify(`页面文字确认：${result.matches.join(" / ")}`); return result; }
    await pause(UI_RENDER_POLL_MS);
  }
  throw new Error(`未等到页面状态：${labels.join(" / ")}`);
}
async function waitForAction(tabId, input, timeout = UI_RENDER_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let lastResult;
  while (Date.now() < deadline) {
    if (cancelled) throw new Error("任务已由操作人停止。");
    lastResult = await evaluate(tabId, input);
    if (lastResult?.ok) return lastResult;
    await pause(UI_RENDER_POLL_MS);
  }
  return lastResult;
}
async function click(tabId, labels, expected, minDelay, timeout) {
  if (cancelled) throw new Error("任务已由操作人停止。");
  const result = await waitForAction(tabId, { type:"clickText", labels });
  if (!result?.ok) throw new Error(`找不到可点击项：${labels.join(" / ")}`);
  await notify(`已操作：${result.label}`);
  await stabilize(tabId, minDelay, timeout);
  if (expected?.length) await waitFor(tabId, expected);
}
async function fill(tabId, placeholders, value, minDelay, timeout) {
  const result = await waitForAction(tabId, { type:"fill", placeholders, value });
  if (!result?.ok) throw new Error(`找不到输入框：${placeholders.join(" / ")}`);
  await notify(`已填写：${result.label}`);
  await stabilize(tabId, minDelay, timeout);
}
async function pressEnter(tabId, placeholders) {
  const result = await evaluate(tabId, { type:"focus", placeholders });
  if (!result?.ok) throw new Error(`找不到输入框：${placeholders.join(" / ")}`);
  const target = { tabId };
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type:"keyDown", key:"Enter", code:"Enter", windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type:"keyUp", key:"Enter", code:"Enter", windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
  await notify("已触发页面搜索。");
  await stabilize(tabId);
}
async function clickSearch(tabId, minDelay, timeout) {
  const result = await waitForAction(tabId, { type:"clickSearchButton" });
  if (!result?.ok) throw new Error(result?.error || "未找到唯一可用的搜索按钮。");
  await notify("已点击页面搜索按钮。");
  await stabilize(tabId, minDelay, timeout);
}
async function clickDialogConfirm(tabId, dialogTitle) {
  // 账户、资源等 Element UI 标准弹窗会在勾选后异步启用 footer 的确认按钮；
  // 自定义弹层才使用标题范围内的备用定位。两者不能混用。
  const deadline = Date.now() + 12000;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await evaluate(tabId, { type:"clickDialogConfirm", dialogTitle });
    if (lastResult?.ok) { await notify(`已确认：${dialogTitle}`); await stabilize(tabId); return; }
    if (lastResult?.error?.includes("未打开") || lastResult?.error?.includes("不唯一")) break;
    await pause(200);
  }
  throw new Error(lastResult?.error || `未找到“${dialogTitle}”弹窗内的确认按钮。`);
}
// 账户批量搜索：多账户时点击搜索框后的批量搜索图标，逐行录入账户ID后执行搜索。
// 这些操作非幂等（点击图标会 toggle 弹窗、回车会新增行），因此用 evaluate 一次性执行
// 并在页面脚本内等待状态就绪，避免 waitForAction 重试造成重复点击或覆盖输入。
async function openAccountBatchSearch(tabId) {
  const result = await evaluate(tabId, { type:"openAccountBatchSearch" });
  if (!result?.ok) throw new Error(result?.error || "未找到批量搜索图标。");
  await notify("已打开账户批量搜索弹窗。");
  await stabilize(tabId, ACCOUNT_RENDER_MIN_DELAY_MS, ACCOUNT_RENDER_TIMEOUT_MS);
}
async function fillAccountBatchLine(tabId, id, isLast) {
  const result = await evaluate(tabId, { type:"fillAccountBatchLine", id, isLast });
  if (!result?.ok) throw new Error(result?.error || `批量搜索输入失败：${id}`);
  await notify(`已输入账户ID：${id}${isLast ? "" : "（换行）"}。`);
  await stabilize(tabId, ACCOUNT_RENDER_MIN_DELAY_MS, ACCOUNT_RENDER_TIMEOUT_MS);
}
async function clickAccountBatchSearch(tabId) {
  const result = await evaluate(tabId, { type:"clickAccountBatchSearch" });
  if (!result?.ok) throw new Error(result?.error || "未找到批量搜索的搜索按钮。");
  await notify("已执行账户批量搜索。");
  await stabilize(tabId, ACCOUNT_RENDER_MIN_DELAY_MS, ACCOUNT_RENDER_TIMEOUT_MS);
}
async function clickOptimizationGoalConfirm(tabId) {
  const deadline = Date.now() + 12000;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await evaluate(tabId, { type:"confirmOptimizationGoal" });
    if (lastResult?.ok) { await notify("已确认：优化目标"); await stabilize(tabId); return; }
    await pause(200);
  }
  throw new Error(lastResult?.error || "优化目标子窗口确认按钮未启用。");
}
async function clickTargetingTemplateConfirm(tabId) {
  const deadline = Date.now() + 12000;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await evaluate(tabId, { type:"confirmTargetingTemplate" });
    if (lastResult?.ok) { await notify("已确认：定向模板"); await stabilize(tabId); return; }
    await pause(200);
  }
  throw new Error(lastResult?.error || "定向模板确认按钮未启用。");
}
async function clickBrandImageConfirm(tabId) {
  const deadline = Date.now() + 12000;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await evaluate(tabId, { type:"confirmBrandImage" });
    if (lastResult?.ok) { await notify("已确认：品牌形象"); await stabilize(tabId); return; }
    await pause(200);
  }
  throw new Error(lastResult?.error || "品牌形象确认按钮未启用。");
}
async function confirmMaterialSettings(tabId) {
  const deadline = Date.now() + 12000;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await evaluate(tabId, { type:"confirmMaterialPanel" });
    if (lastResult?.ok) { await notify("已确认：素材配置面板"); await stabilize(tabId); return; }
    await pause(200);
  }
  throw new Error(lastResult?.error || "素材配置面板确认按钮未启用。");
}
async function confirmUnifiedProductRule(tabId) {
  // 多账户选择“全部相同”后，平台可能提示所选账户需处于同一业务单元。
  // 该提示仅多账户时出现；出现时必须点掉，未出现则按单账户处理跳过。
  const deadline = Date.now() + 8000;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await evaluate(tabId, { type:"confirmUnifiedProductRule" });
    if (lastResult?.ok) { await notify("已确认：全部相同分配规则业务单元提示"); await stabilize(tabId); return; }
    await pause(250);
  }
  if (lastResult?.error?.includes("未找到")) return;
  throw new Error(lastResult?.error || "业务单元提示弹窗确认按钮未启用。");
}
async function openGlobalImageMaterialPicker(tabId) {
  const opened = await evaluate(tabId, { type:"openGlobalMaterialBatchMenu" });
  if (!opened?.ok) throw new Error(opened?.error || "未能打开全局“批量添加”菜单。");
  // 下拉层由 portal 异步挂载；稳定检测会早于菜单项产生，需给菜单明确挂载时间。
  await pause(900);
  const chosen = await waitForAction(tabId, { type:"chooseGlobalAddImage" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!chosen?.ok) throw new Error(chosen?.error || "未能从全局“批量添加”菜单选择“添加图片”。");
  await stabilize(tabId, TARGETING_RENDER_MIN_DELAY_MS, TARGETING_RENDER_TIMEOUT_MS);
}
async function submitMaterialPicker(tabId) {
  const deadline = Date.now() + TARGETING_RENDER_TIMEOUT_MS;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await evaluate(tabId, { type:"submitSelectedMaterials" });
    if (lastResult?.ok) { await notify(`素材库：已提交 ${lastResult.count} 条素材。`); break; }
    await pause(UI_RENDER_POLL_MS);
  }
  if (!lastResult?.ok) throw new Error(lastResult?.error || "素材库提交按钮尚未启用。");
  const closed = await waitForAction(tabId, { type:"materialPickerClosed" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!closed?.ok) throw new Error("素材库提交后未关闭，已停止。 ");
  await notify("素材库：已提交并关闭，等待素材写入创意组。");
  await stabilize(tabId, TARGETING_RENDER_MIN_DELAY_MS, TARGETING_RENDER_TIMEOUT_MS);
}
async function selectMaterialDirectory(tabId, folder) {
  const opened = await evaluate(tabId, { type:"openMaterialDirectory" });
  if (!opened?.ok) throw new Error(opened?.error || "素材目录下拉框未打开。");
  const treeReady = await waitForAction(tabId, { type:"materialDirectorySearchReady" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!treeReady?.ok) throw new Error(treeReady?.error || "素材目录树未完成渲染。");
  const searched = await evaluate(tabId, { type:"searchMaterialDirectory", folder });
  if (!searched?.ok) throw new Error(searched?.error || `素材目录搜索框未找到：${folder}`);
  await pause(700);
  const selected = await waitForAction(tabId, { type:"chooseMaterialDirectory", folder }, TARGETING_RENDER_TIMEOUT_MS);
  if (!selected?.ok) throw new Error(selected?.error || `未能选择素材目录：${folder}`);
  await notify(`素材目录：已选择「${folder}」。`);
  // 目录树选择后须回到素材库列表，等候列表按目录重新请求并刷新。
  await pause(900);
  const closeResult = await evaluate(tabId, { type:"closeMaterialDirectory" });
  if (!closeResult?.ok) throw new Error(closeResult?.error || "未能收起素材目录树。");
  const treeClosed = await waitForAction(tabId, { type:"materialDirectoryClosed" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!treeClosed?.ok) throw new Error("素材目录树仍处于展开状态，已停止。 ");
  await stabilize(tabId, TARGETING_RENDER_MIN_DELAY_MS, TARGETING_RENDER_TIMEOUT_MS);
}
async function configureMaterialDataTime(tabId, range) {
  const openedUpload = await evaluate(tabId, { type:"openUploadTimeFilter" });
  if (!openedUpload?.ok) throw new Error(openedUpload?.error || "未能打开上传时间筛选框。");
  const clearReady = await waitForAction(tabId, { type:"uploadTimeClearReady" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!clearReady?.ok) throw new Error(clearReady?.error || "上传时间清空浮窗尚未渲染。");
  const cleared = await evaluate(tabId, { type:"clearUploadTimePopup" });
  if (!cleared?.ok) throw new Error(cleared?.error || "未能点击上传时间浮窗中的清空。");
  const popupClosed = await waitForAction(tabId, { type:"uploadTimePopupClosed" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!popupClosed?.ok) throw new Error("上传时间浮窗清空后未关闭。");
  await notify("素材筛选：已清空上传时间范围。");
  const listSelected = await waitForAction(tabId, { type:"selectMaterialListView" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!listSelected?.ok) throw new Error(listSelected?.error || "未能切换到素材列表视图。");
  const metricsReady = await waitForAction(tabId, { type:"materialCustomMetricsReady" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!metricsReady?.ok) throw new Error(metricsReady?.error || "自定义指标与排序入口尚未完成渲染。");
  // 列表切换后按钮虽已进入 DOM，但 Element UI 仍可能在重排/动画中；
  // 留出稳定时间，避免真实鼠标事件落在即将被替换的旧节点上。
  await pause(900);
  const metricsStable = await waitForAction(tabId, { type:"materialCustomMetricsReady" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!metricsStable?.ok) throw new Error(metricsStable?.error || "自定义指标与时间入口未稳定渲染。");
  const opened = await evaluate(tabId, { type:"openMaterialCustomMetrics" });
  if (!opened?.ok) throw new Error(opened?.error || "未能打开自定义指标与排序。");
  // 先由页面原生 click() 触发；若 DevTools 检查模式或 Vue 状态阻断，再回退到浏览器级真实鼠标事件。
  // 成功后不重复点击，避免 Popover 被第二次点击关闭。
  await pause(450);
  let customSelected = await waitForAction(tabId, { type:"selectMaterialCustomMetric" }, 1400);
  if (!customSelected?.ok) {
    await clickPagePoint(tabId, opened.point);
    await pause(550);
    customSelected = await waitForAction(tabId, { type:"selectMaterialCustomMetric" }, TARGETING_RENDER_TIMEOUT_MS);
  }
  if (!customSelected?.ok) throw new Error(customSelected?.error || "未能点击自定义指标。");
  await pause(300);
  const configured = await waitForAction(tabId, { type:"setMaterialCustomDays", start:range.start, end:range.end }, TARGETING_RENDER_TIMEOUT_MS);
  if (!configured?.ok) throw new Error(configured?.error || "未能设置素材自定义数据时间。");
  await notify(`素材筛选：自定义指标数据时间已设为 ${range.start} 至 ${range.end}。`);
  // 时间修改完成后必须先退出指标浮窗，回到素材库列表，不能在浮层上直接勾选素材。
  const returned = await evaluate(tabId, { type:"closeMaterialCustomTimePanel" });
  if (!returned?.ok) throw new Error(returned?.error || "未能返回素材库列表。");
  await pause(450);
  let panelClosed = await waitForAction(tabId, { type:"materialCustomTimePanelClosed" }, 1400);
  if (!panelClosed?.ok) {
    await clickPagePoint(tabId, returned.point);
    await pause(450);
    panelClosed = await waitForAction(tabId, { type:"materialCustomTimePanelClosed" }, TARGETING_RENDER_TIMEOUT_MS);
  }
  if (!panelClosed?.ok) throw new Error(panelClosed?.error || "数据时间浮窗未关闭，无法返回素材库选择素材。");
  const rowsReady = await waitForAction(tabId, { type:"materialPickerRowsReady" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!rowsReady?.ok) throw new Error(rowsReady?.error || "时间修改后素材列表尚未刷新。");
  await notify("素材筛选：已返回素材库，列表已按新的数据时间刷新。");
  await stabilize(tabId, TARGETING_RENDER_MIN_DELAY_MS, TARGETING_RENDER_TIMEOUT_MS);
}
async function configureMaterialColumnFilters(tabId, conditions) {
  const first = conditions[0];
  if (!first) throw new Error("缺少素材筛选条件。");
  // 只打开第一个条件对应的表头；其余条件必须在同一浮窗中通过“添加条件”创建。
  await pause(650);
  const opened = await evaluate(tabId, { type:"openMaterialColumnFilter", label:first.label });
  if (!opened?.ok) throw new Error(opened?.error || `未能打开“${first.label}”筛选框。`);
  await pause(450);
  let ready = await waitForAction(tabId, { type:"materialColumnFilterReady", label:first.label }, 1600);
  if (!ready?.ok && opened.point) {
    await clickPagePoint(tabId, opened.point);
    await pause(600);
    ready = await waitForAction(tabId, { type:"materialColumnFilterReady", label:first.label }, TARGETING_RENDER_TIMEOUT_MS);
  }
  if (!ready?.ok) throw new Error(ready?.error || `“${first.label}”筛选浮窗未完成渲染。`);
  for (let index = 0; index < conditions.length; index += 1) {
    if (index > 0) {
      const added = await waitForAction(tabId, { type:"addMaterialColumnFilterCondition", expectedRows:index }, TARGETING_RENDER_TIMEOUT_MS);
      if (!added?.ok) throw new Error(added?.error || "未能添加素材筛选条件行。");
      const rowReady = await waitForAction(tabId, { type:"materialColumnFilterRowsReady", count:index + 1 }, TARGETING_RENDER_TIMEOUT_MS);
      if (!rowReady?.ok) throw new Error(rowReady?.error || "新增素材筛选条件行未完成渲染。");
      const metricOpened = await waitForAction(tabId, { type:"openMaterialFilterMetric", index }, TARGETING_RENDER_TIMEOUT_MS);
      if (!metricOpened?.ok) throw new Error(metricOpened?.error || `未能打开第 ${index + 1} 条条件的指标下拉框。`);
      await pause(400);
      const option = await waitForAction(tabId, { type:"materialFilterMetricOptionReady", label:conditions[index].label }, TARGETING_RENDER_TIMEOUT_MS);
      if (!option?.ok || !option.point) throw new Error(option?.error || `指标“${conditions[index].label}”未出现在下拉选项中。`);
      await clickPagePoint(tabId, option.point);
      await pause(400);
      const metricSelected = await waitForAction(tabId, { type:"materialFilterMetricSelected", index, label:conditions[index].label }, TARGETING_RENDER_TIMEOUT_MS);
      if (!metricSelected?.ok) throw new Error(metricSelected?.error || `第 ${index + 1} 条条件未选中指标“${conditions[index].label}”。`);
    }
    const filled = await waitForAction(tabId, { type:"fillMaterialColumnFilterCondition", index, condition:conditions[index] }, TARGETING_RENDER_TIMEOUT_MS);
    if (!filled?.ok) throw new Error(filled?.error || `未能填写第 ${index + 1} 条素材筛选条件。`);
    const valueTarget = await waitForAction(tabId, { type:"materialFilterValueReady", index }, TARGETING_RENDER_TIMEOUT_MS);
    if (!valueTarget?.ok || !valueTarget.point) throw new Error(valueTarget?.error || `第 ${index + 1} 条条件数值框未渲染。`);
    await clickPagePoint(tabId, valueTarget.point);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type:"keyDown", key:"Control", code:"ControlLeft", modifiers:2, windowsVirtualKeyCode:17, nativeVirtualKeyCode:17 });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type:"keyDown", key:"a", code:"KeyA", modifiers:2, windowsVirtualKeyCode:65, nativeVirtualKeyCode:65 });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type:"keyUp", key:"a", code:"KeyA", modifiers:2, windowsVirtualKeyCode:65, nativeVirtualKeyCode:65 });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type:"keyUp", key:"Control", code:"ControlLeft", modifiers:0, windowsVirtualKeyCode:17, nativeVirtualKeyCode:17 });
    await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text:String(conditions[index].value) });
    const valueSet = await waitForAction(tabId, { type:"materialFilterValueSet", index, value:String(conditions[index].value) }, TARGETING_RENDER_TIMEOUT_MS);
    if (!valueSet?.ok) throw new Error(valueSet?.error || `第 ${index + 1} 条条件数值未写入筛选模型。`);
  }
  const confirmed = await waitForAction(tabId, { type:"confirmMaterialColumnFilters" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!confirmed?.ok) throw new Error(confirmed?.error || "素材筛选确认按钮未启用。");
  await pause(450);
  // 确定后回到素材库主标签，主动收起筛选浮层，避免浮层残留阻断分页控件。
  const materialLibrary = await evaluate(tabId, { type:"clickMaterialLibraryTab" });
  if (!materialLibrary?.ok) throw new Error(materialLibrary?.error || "未能返回素材库列表。");
  await pause(500);
  let filterClosed = await waitForAction(tabId, { type:"materialColumnFilterClosed" }, 1400);
  if (!filterClosed?.ok && confirmed.point) {
    await clickPagePoint(tabId, confirmed.point);
    await pause(450);
    filterClosed = await waitForAction(tabId, { type:"materialColumnFilterClosed" }, TARGETING_RENDER_TIMEOUT_MS);
  }
  if (!filterClosed?.ok) throw new Error(filterClosed?.error || "素材筛选确认按钮点击后浮窗仍未关闭。");
  await pause(700);
  const refreshed = await waitForAction(tabId, { type:"materialPickerRowsReady" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!refreshed?.ok) throw new Error("素材条件筛选后列表尚未刷新。");
  await notify(`素材筛选：已设置 ${conditions.map((item) => `${item.label} ≥ ${item.value}`).join("；")}。`);
}
async function configureMaterialPageSize(tabId) {
  await pause(700);
  const opened = await waitForAction(tabId, { type:"openMaterialPageSize" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!opened?.ok) throw new Error(opened?.error || "素材分页控件未找到。");
  await pause(350);
  const option = await waitForAction(tabId, { type:"selectMaterialPageSize", size:100 }, TARGETING_RENDER_TIMEOUT_MS);
  if (!option?.ok) throw new Error(option?.error || "未能将素材分页设置为100条/页。");
  await pause(500);
  const ready = await waitForAction(tabId, { type:"materialPageSizeReady", size:100 }, TARGETING_RENDER_TIMEOUT_MS);
  if (!ready?.ok) throw new Error(ready?.error || "素材分页100条/页尚未生效。");
  const rowsReady = await waitForAction(tabId, { type:"materialPickerRowsReady" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!rowsReady?.ok) throw new Error(rowsReady?.error || "素材分页切换后列表尚未完成刷新。");
  // 100条/页数据量大，必须等列表稳定后再全选，避免在虚拟渲染或异步回填阶段触发全选。
  await stabilize(tabId, TARGETING_RENDER_MIN_DELAY_MS, TARGETING_RENDER_TIMEOUT_MS);
  await notify("素材筛选：已将分页设置为100条/页，列表已刷新。");
}
async function clickNewAdCard(tabId) {
  const result = await waitForAction(tabId, { type:"clickNewAdCard" });
  if (!result?.ok) throw new Error(result?.error || "未找到“新建广告”卡片。");
  await notify("已选择：新建广告");
  await stabilize(tabId);
}
async function openInput(tabId, placeholder, dialogTitle) {
  const result = await waitForAction(tabId, { type:"openInput", placeholder, dialogTitle });
  if (!result?.ok) throw new Error(result?.error || `找不到输入控件：${placeholder}`);
  await stabilize(tabId);
}
async function clickExactText(tabId, label, dialogTitle) {
  const result = await waitForAction(tabId, { type:"clickExactText", label, dialogTitle });
  if (!result?.ok) throw new Error(result?.error || `找不到可点击项：${label}`);
  await notify(`已操作：${label}`);
  await stabilize(tabId);
}
async function waitForInputValue(tabId, placeholder, value, dialogTitle, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await evaluate(tabId, { type:"inputValue", placeholder, value, dialogTitle });
    if (result?.ok) { await notify(`字段确认：${placeholder} = ${value}`); return; }
    await pause(200);
  }
  throw new Error(`未确认字段值：${placeholder} = ${value}`);
}
async function selectPlacementCards(tabId, labels) {
  for (const label of labels) {
    const result = await evaluate(tabId, { type:"selectCheckboxLabels", labels:[label] });
    if (!result?.ok || result.count !== 1) throw new Error(`版位未能选中：${label}`);
    await notify(`已选择版位：${label}`);
    await stabilize(tabId);
    const verified = await evaluate(tabId, { type:"checkLabels", labels:[label] });
    if (!verified?.ok) throw new Error(`版位状态未确认：${label}`);
    await notify(`版位确认：${label}`);
  }
}
async function selectPlacementRadio(tabId, label) {
  const result = await evaluate(tabId, { type:"selectPlacementRadio", label });
  if (!result?.ok) throw new Error(result?.error || `未能选择：${label}`);
  await notify(`版位策略确认：${label}`);
  await stabilize(tabId);
}
async function clearPlacementCards(tabId, labels) {
  const result = await evaluate(tabId, { type:"clearCheckboxLabels", labels });
  if (!result?.ok) throw new Error(`未能清理非指定版位：${result?.missing?.join(" / ") || "未知"}`);
  await notify("已清理非指定版位。");
  await stabilize(tabId);
}
async function selectRadio(tabId, label, dialogTitle) {
  const result = await evaluate(tabId, { type:"selectRadioLabel", label, dialogTitle });
  if (!result?.ok) throw new Error(result?.error || `未能选择：${label}`);
  await notify(`已选择：${label}`);
  await stabilize(tabId);
}
async function selectRadioInSection(tabId, sectionTitle, label) {
  const result = await waitForAction(tabId, { type:"selectRadioInSection", sectionTitle, label });
  if (!result?.ok) throw new Error(result?.error || `未能在“${sectionTitle}”中选择：${label}`);
  await notify(`已选择：${sectionTitle} / ${label}`);
  await stabilize(tabId);
}
async function fillInputInSection(tabId, sectionTitle, value) {
  const result = await waitForAction(tabId, { type:"fillInputInSection", sectionTitle, value });
  if (!result?.ok) throw new Error(result?.error || `未找到“${sectionTitle}”的预算输入框。`);
  await notify(`已填写：${sectionTitle}`);
  await stabilize(tabId);
}
async function fillInputByIndex(tabId, placeholders, value, index) {
  const result = await waitForAction(tabId, { type:"fillInputByIndex", placeholders, value, index });
  if (!result?.ok) throw new Error(`未找到第 ${index + 1} 个文案输入框。`);
  await notify(`已填写：第 ${index + 1} 条文案`);
  await stabilize(tabId);
}
async function fillCopyPanelInput(tabId, placeholders, value) {
  const result = await waitForAction(tabId, { type:"fillCopyPanelInput", placeholders, value });
  if (!result?.ok) throw new Error(`找不到创意文案面板输入框：${placeholders.join(" / ")}`);
  await notify(`已填写：${result.label}`);
  await stabilize(tabId);
}
async function pressEnterInCopyPanel(tabId) {
  const result = await evaluate(tabId, { type:"focusCopyPanelInput", placeholders:["请输入文案关键词"] });
  if (!result?.ok) throw new Error("未找到文案关键词搜索框。");
  const target = { tabId };
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type:"keyDown", key:"Enter", code:"Enter", windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type:"keyUp", key:"Enter", code:"Enter", windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
  await notify("已触发文案搜索。");
  await stabilize(tabId);
}
async function clearCopySearch(tabId) {
  const result = await waitForAction(tabId, { type:"clearCopySearch" });
  if (!result?.ok) throw new Error(result?.error || "未能清空文案搜索框。");
  await notify("已清空文案搜索框。");
  await stabilize(tabId);
}
async function confirmCopySettings(tabId) {
  const deadline = Date.now() + 12000;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await evaluate(tabId, { type:"confirmCopyPanel" });
    if (lastResult?.ok) { await notify("已确认：创意文案面板"); await stabilize(tabId); return; }
    await pause(200);
  }
  throw new Error(lastResult?.error || "创意文案面板确认按钮未启用。");
}
async function prependAdNameWithPlacements(tabId) {
  const result = await waitForAction(tabId, { type:"prependAdNameWithPlacements" });
  if (!result?.ok) throw new Error(result?.error || "未能生成广告名称前缀。");
  await notify(`广告名称前缀：${result.prefix}`);
  await stabilize(tabId);
}
async function saveAdSettings(tabId) {
  const result = await waitForAction(tabId, { type:"clickExactVisibleButton", label:"保存" });
  if (!result?.ok) throw new Error(result?.error || "未找到广告设置保存按钮。");
  await notify("已保存广告设置。");
  await stabilize(tabId);
}
async function openTargetingTemplate(tabId) {
  const result = await waitForAction(tabId, { type:"clickTargetingTemplateAdd" });
  if (!result?.ok) throw new Error(result?.error || "未找到定向模板添加入口。");
  await notify("已打开定向模板选择。");
  await stabilize(tabId);
}
async function openCreativeInfoEditor(tabId) {
  const result = await waitForAction(tabId, { type:"clickCreativeInfoEdit" });
  if (!result?.ok) throw new Error(result?.error || "未找到创意信息编辑入口。");
  await notify("已打开创意信息编辑。");
  const ready = await waitForAction(tabId, { type:"creativeInfoReady" }, PRODUCT_RENDER_TIMEOUT_MS);
  if (!ready?.ok) throw new Error("创意信息加载超时。");
  await stabilize(tabId);
}
async function clickSectionAction(tabId, sectionTitle, actionLabel) {
  const result = await waitForAction(tabId, { type:"clickSectionAction", sectionTitle, actionLabel }, PRODUCT_RENDER_TIMEOUT_MS);
  if (!result?.ok) throw new Error(result?.error || `未找到“${sectionTitle}”的“${actionLabel}”入口。`);
  await notify(`已打开：${sectionTitle} / ${actionLabel}`);
  await stabilize(tabId);
}
async function selectBrandImage(tabId, keyword) {
  await clickSectionAction(tabId, "品牌形象跳转", "选择品牌形象");
  const ready = await waitForAction(tabId, { type:"brandImagePanelReady" }, PRODUCT_RENDER_TIMEOUT_MS);
  if (!ready?.ok) throw new Error("品牌形象选择页未完成渲染。");
  const searched = await evaluate(tabId, { type:"searchBrandImage", keyword });
  if (!searched?.ok) throw new Error(searched?.error || `品牌形象搜索未能触发：${keyword}`);
  await notify(`品牌形象：已搜索关键词「${keyword}」。`);
  await stabilize(tabId, TARGETING_RENDER_MIN_DELAY_MS, TARGETING_RENDER_TIMEOUT_MS);
  const selected = await waitForAction(tabId, { type:"selectFirstBrandImage" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!selected?.ok || selected.count !== 1) throw new Error(`品牌形象搜索后未能勾选第 1 条结果：${keyword}`);
  await notify("品牌形象已勾选第 1 条并确认已选状态。");
  await clickBrandImageConfirm(tabId);
}
async function selectCreativeButtonCopy(tabId) {
  const result = await waitForAction(tabId, { type:"selectDropdownInSection", sectionTitle:"按钮文案", label:"立即领取" });
  if (!result?.ok) throw new Error(result?.error || "未能选择按钮文案“立即领取”。");
  await notify("已选择：按钮文案 / 立即领取");
  await stabilize(tabId);
}
async function selectOptimizationGoal(tabId, goal) {
  const search = await waitForAction(tabId, { type:"searchOptimizationGoal", goal }, TARGETING_RENDER_TIMEOUT_MS);
  if (!search?.ok) throw new Error(search?.error || `优化目标下拉框未能搜索“${goal}”。`);
  await notify(`优化目标：已搜索「${goal}」。`);
  await stabilize(tabId);
  const result = await waitForAction(tabId, { type:"selectOptimizationGoalOption", goal }, TARGETING_RENDER_TIMEOUT_MS);
  if (!result?.ok) throw new Error(result?.error || `优化目标下拉框未能选中“${goal}”。`);
  await notify(`优化目标：下拉框已选中「${goal}」。`);
  await stabilize(tabId);
}
async function saveCreativeInfo(tabId) {
  await clickDialogConfirm(tabId, "创意基本信息");
  const closed = await waitForAction(tabId, { type:"panelClosed", title:"创意基本信息" }, PRODUCT_RENDER_TIMEOUT_MS);
  if (!closed?.ok) throw new Error("创意信息未保存成功，编辑弹层仍在页面上。");
}
async function configureMarketingContent(tabId, job) {
  // 营销目的为卡片，不是 radio；必须先选中线索留资，才选择对应产品类型。
  await clickExactText(tabId, "线索留资");
  await selectRadio(tabId, "运营商产品");
  await selectRadio(tabId, "页面跳转");
  await click(tabId, ["选择产品"], ["选择推广产品"]);
  await selectRadio(tabId, "全部相同", "选择推广产品");
  await confirmUnifiedProductRule(tabId);
  await fill(tabId, ["请输入关键词"], job.productKeyword);
  await pressEnter(tabId, ["请输入关键词"]);
  await stabilize(tabId, PRODUCT_RENDER_MIN_DELAY_MS, PRODUCT_RENDER_TIMEOUT_MS);
  const lastPage = await evaluate(tabId, { type:"goToLastProductPage" });
  if (!lastPage?.ok) throw new Error(lastPage?.error || "未能进入产品列表最后一页。");
  const pageReady = await waitForAction(tabId, { type:"productPageReady", page:lastPage.page }, PRODUCT_RENDER_TIMEOUT_MS);
  if (!pageReady?.ok) throw new Error("产品末页尚未渲染完成。");
  const selected = await waitForAction(tabId, { type:"selectProductFromEnd", keyword:job.productKeyword }, PRODUCT_RENDER_TIMEOUT_MS);
  if (!selected?.ok || selected.count !== 1) {
    throw new Error(`最后一页倒序列表中未找到名称为“${job.productKeyword}”的产品。`);
  }
  await clickDialogConfirm(tabId, "选择推广产品");
  await stabilize(tabId, PRODUCT_RENDER_MIN_DELAY_MS, PRODUCT_RENDER_TIMEOUT_MS);
}
async function configureOptimizationGoalAndConversion(tabId, isMultiAccount) {
  await click(tabId, ["选择转化"]);
  await openInput(tabId, "请选择优化目标");
  await clickExactText(tabId, "更多目标");
  await selectOptimizationGoal(tabId, "表单预约");
  // 先确认子窗口字段已实际回写，才能点击它自己的确认；不能误点外层“选择转化”。
  const goalSelected = await waitForAction(tabId, { type:"optimizationGoalSelected", goal:"表单预约" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!goalSelected?.ok) throw new Error("优化目标子窗口未实际选中“表单预约”。");
  await notify("优化目标：子窗口已验证选中「表单预约」。");
  await notify("优化目标：开始点击子窗口确认。", "info");
  await clickOptimizationGoalConfirm(tabId);
  // 点击成功不等于平台已接收。必须等待该子窗口消失，避免带着未保存的目标去点外层确认。
  const childClosed = await waitForAction(tabId, { type:"optimizationGoalDialogClosed" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!childClosed?.ok) throw new Error("优化目标子窗口点击“确定”后仍未关闭，已停止。");
  await notify("优化目标：子窗口已确认并关闭。");
  // 平台会提示“归因尚未配置”，确认该提示仅用于返回外层补齐归因，不是最终提交。
  const notice = await waitForAction(tabId, { type:"dialogVisible", title:"当前转化归因未配置完成" }, 3000);
  if (notice?.ok) await clickDialogConfirm(tabId, "当前转化归因未配置完成");
  const goalApplied = await waitForAction(tabId, { type:"optimizationGoalApplied", goal:"表单预约" }, TARGETING_RENDER_TIMEOUT_MS);
  if (!goalApplied?.ok) throw new Error("优化目标未回写到“选择转化”窗口，已停止。");
  await notify("优化目标：已回写至外层“选择转化”窗口。");
  await click(tabId, ["API上报"]);
  await click(tabId, ["点击归因"]);
  if (isMultiAccount) {
    const allocResult = await waitForAction(tabId, { type:"clickAllocationRule", rule:"全部相同" }, TARGETING_RENDER_TIMEOUT_MS);
    if (!allocResult?.ok) throw new Error(`未能选择分配规则"全部相同"：${allocResult?.error || "未知错误"}`);
    await notify("已选择：转化分配规则 / 全部相同");
    await stabilize(tabId);
  }
  // SOP 顺序：先确定转化分配规则，再勾选具体转化复选框。
  const selected = await evaluate(tabId, { type:"selectCheckboxLabels", labels:["优投-表单预约"] });
  if (!selected?.ok || selected.count !== 1) throw new Error("未能选中“优投-表单预约”转化。");
  await stabilize(tabId);
  const ready = await waitForAction(tabId, { type:"conversionReady", goal:"表单预约", conversion:"优投-表单预约", allocationRule: isMultiAccount ? "全部相同" : undefined }, TARGETING_RENDER_TIMEOUT_MS);
  if (!ready?.ok) throw new Error(`转化目标、归因方式或转化规则尚未全部生效（allocationOk=${ready?.allocationOk}），已停止。`);
  await clickDialogConfirm(tabId, "选择转化");
  await waitFor(tabId, ["表单预约"]);
}
async function runStep(title, work) {
  if (cancelled) throw new Error("任务已由操作人停止。");
  await notify(`开始：${title}`);
  await work();
  await notify(`完成：${title}`);
}

async function runWorkflow(tab, job) {
  activeDingTalkWebhook = job.dingTalkWebhook?.trim() || "";
  await attach(tab.id);
  const page = await evaluate(tab.id, { type:"pageInfo" });
  if (!page?.ok) throw new Error("当前标签页不可访问。请确认它是创量的已登录页面。");
  await notify(`已连接页面：${page.title || tab.url}`);
  await status("running", "正在执行", `目标账户 ${job.accountIds.length} 个；执行中会在每个可见状态点校验。`);
  await runStep("进入批量新建", async () => {
    const present = await evaluate(tab.id, { type:"hasText", labels:["更改", "新建广告"] });
    if (!present?.ok) await click(tab.id, ["批量新建", "批量创建"], ["更改", "新建广告"]);
  });
  await runStep("导入并校验账户", async () => {
    await click(tab.id, ["更改"], ["选择媒体账户", "账户ID"], ACCOUNT_RENDER_MIN_DELAY_MS, ACCOUNT_RENDER_TIMEOUT_MS);
    const accountMode = await evaluate(tab.id, { type:"clickText", labels:["账户ID"] });
    if (accountMode?.ok) await notify("已切换为账户 ID 查询。");
    if (job.accountIds.length > 1) {
      // 多账户：关键词输入框为单行，无法一次性录入多个 ID，改用搜索框后缀的批量搜索弹窗逐行录入。
      await openAccountBatchSearch(tab.id);
      for (let i = 0; i < job.accountIds.length; i++) {
        await fillAccountBatchLine(tab.id, job.accountIds[i], i === job.accountIds.length - 1);
      }
      await clickAccountBatchSearch(tab.id);
      await waitFor(tab.id, [job.accountIds[0]], ACCOUNT_RENDER_TIMEOUT_MS);
      const selected = await evaluate(tab.id, { type:"selectAllAccountRows" });
      if (!selected?.ok || selected.count === 0) throw new Error(`批量搜索后未勾选到账户（结果行 ${selected?.total || 0}）。`);
      if (selected.total !== job.accountIds.length) await notify(`批量搜索结果 ${selected.total} 行，期望 ${job.accountIds.length}，已全部勾选 ${selected.count} 行。`, "warn");
      else await notify(`已选账户 ${selected.count}/${job.accountIds.length}。`);
    } else {
      // 单账户：沿用关键词搜索，无需打开批量搜索弹窗。
      await fill(tab.id, ["请输入关键词", "账户ID"], job.accountIds.join("\n"), ACCOUNT_RENDER_MIN_DELAY_MS, ACCOUNT_RENDER_TIMEOUT_MS);
      await clickSearch(tab.id, ACCOUNT_RENDER_MIN_DELAY_MS, ACCOUNT_RENDER_TIMEOUT_MS);
      for (const id of job.accountIds) await waitFor(tab.id, [id]);
      const selected = await evaluate(tab.id, { type:"selectAccountRows", accountIds:job.accountIds });
      if (!selected?.ok || selected.count !== job.accountIds.length) throw new Error(`账户选择不完整：期望 ${job.accountIds.length}，实际 ${selected?.count || 0}。`);
      await notify(`已选账户 ${selected.count}/${job.accountIds.length}。`);
    }
    await stabilize(tab.id, ACCOUNT_RENDER_MIN_DELAY_MS, ACCOUNT_RENDER_TIMEOUT_MS);
    await clickDialogConfirm(tab.id, "选择媒体账户");
    await waitFor(tab.id, ["新建广告", "广告版位"]);
  });
  await runStep("进入新建广告表单", async () => {
    const hasForm = await evaluate(tab.id, { type:"hasText", labels:["广告版位"] });
    if (!hasForm?.ok) { await clickNewAdCard(tab.id); await waitFor(tab.id, ["广告版位"]); }
  });
  await runStep("配置营销内容", async () => {
    await configureMarketingContent(tab.id, job);
  });
  await runStep("配置广告版位", async () => {
    await selectPlacementRadio(tab.id, "智能版位");
    await selectPlacementRadio(tab.id, "稳步探索");
    // 不假设微信视频号存在或被默认选中；仅处理 SOP 明确排除的朋友圈和 PC 端。
    await clearPlacementCards(tab.id, ["微信朋友圈", "腾讯营销电脑端（PC）"]);
    const requiredPlacements = ["微信公众号与小程序", "腾讯平台与内容媒体", "腾讯营销联盟"];
    await selectPlacementCards(tab.id, requiredPlacements);
    const placements = await evaluate(tab.id, { type:"checkLabels", labels:requiredPlacements });
    if (!placements?.ok) throw new Error("指定三类版位未全部选中，请在页面核对后重新运行。 ");
  });
  await runStep("配置转化", async () => {
    await configureOptimizationGoalAndConversion(tab.id, job.accountIds.length > 1);
  });
  await runStep("配置出价与预算", async () => {
    await click(tab.id, ["随机出价"]);
    await fill(tab.id, ["最低出价", "最小值"], String(job.bidMin));
    await fill(tab.id, ["最高出价", "最大值"], String(job.bidMax));
    await selectRadioInSection(tab.id, "一键起量", "开启");
    await fillInputInSection(tab.id, "起量预算", String(job.budget));
  });
  await runStep("配置广告设置", async () => {
    await selectRadio(tab.id, "长期投放");
    // “不限”和“开启”在其他模块也会重复出现；页面默认即为不限时段、开启状态，
    // 此处不使用跨模块的模糊文字点击，避免误改日预算或转化开关。
    await prependAdNameWithPlacements(tab.id);
    await saveAdSettings(tab.id);
  });
  await runStep("配置定向模板", async () => {
    await openTargetingTemplate(tab.id);
    await fill(tab.id, ["请输入定向模板名称"], job.targetingTemplate);
    await click(tab.id, ["查询"], undefined, TARGETING_RENDER_MIN_DELAY_MS, TARGETING_RENDER_TIMEOUT_MS);
    const selected = await waitForAction(tab.id, { type:"selectRowsByText", values:[job.targetingTemplate] }, TARGETING_RENDER_TIMEOUT_MS);
    if (!selected?.ok || selected.count !== 1) throw new Error("定向模板查询结果未能实际勾选，已停止。");
    await clickTargetingTemplateConfirm(tab.id);
    await waitFor(tab.id, ["定向模板已选：1"]);
  });
  await runStep("配置创意信息", async () => {
    await openCreativeInfoEditor(tab.id);
    // SOP 步骤 7：所有控件按所属区域定位，避免两个“自定义落地页”互相误点。
    await selectRadioInSection(tab.id, "品牌形象跳转", "自定义");
    await selectBrandImage(tab.id, job.brandKeyword);
    await selectRadioInSection(tab.id, "跳转类型", "自定义落地页");
    await selectRadioInSection(tab.id, "跳转落地页", "自定义落地页");
    await selectCreativeButtonCopy(tab.id);
    await selectRadioInSection(tab.id, "相似素材智能处理", "关闭");
    await selectRadioInSection(tab.id, "创意默认状态", "开启");
    await saveCreativeInfo(tab.id);
  });
  await runStep("配置图片素材", async () => {
    // SOP 步骤 8：先从父板块“创意素材”的“选择素材”入口进入；
    // 不能误点后续文案板块的“添加”，也不能直接假设已打开图片选择器。
    await clickSectionAction(tab.id, "创意素材", "选择素材");
    const ready = await waitForAction(tab.id, { type:"materialPanelReady" }, PRODUCT_RENDER_TIMEOUT_MS);
    if (!ready?.ok) throw new Error("素材配置页未完成渲染。");
    await selectRadioInSection(tab.id, "多账户分配规则", "平均分配");
    await selectRadioInSection(tab.id, "创意组分配规则", "平均分配");
    await fillInputInSection(tab.id, "创意组素材上限", "1");
    await openGlobalImageMaterialPicker(tab.id);
    const picker = await waitForAction(tab.id, { type:"materialPickerReady" }, PRODUCT_RENDER_TIMEOUT_MS);
    if (!picker?.ok) throw new Error("图片素材选择页未完成渲染。");
    await selectMaterialDirectory(tab.id, job.materialFolder);
    await configureMaterialDataTime(tab.id, { start:job.materialDateStart, end:job.materialDateEnd });
    // SOP：素材目录、数据时间完成后，先用列表表头的筛选器限制花费与目标转化量，最后才勾选素材。
    await configureMaterialColumnFilters(tab.id, job.materialConditions);
    const filtered = await waitForAction(tab.id, { type:"configureMaterialFilters", folder:job.materialFolder }, TARGETING_RENDER_TIMEOUT_MS);
    if (!filtered?.ok) throw new Error(filtered?.error || "素材目录或筛选条件未能完成设置。");
    await configureMaterialPageSize(tab.id);
    const selectionTriggered = await waitForAction(tab.id, { type:"triggerSelectAllMaterialRows" }, TARGETING_RENDER_TIMEOUT_MS);
    if (!selectionTriggered?.ok) throw new Error(selectionTriggered?.error || "素材列表表头全选控件未找到。");
    await pause(500);
    let selected = await waitForAction(tab.id, { type:"verifyAllMaterialRows" }, 1600);
    if ((!selected?.ok || selected.count < 1) && selectionTriggered.point) {
      await clickPagePoint(tab.id, selectionTriggered.point);
      await pause(550);
      selected = await waitForAction(tab.id, { type:"verifyAllMaterialRows" }, TARGETING_RENDER_TIMEOUT_MS);
    }
    if (!selected?.ok || selected.count < 1) throw new Error("素材筛选结果未能全选，已停止。");
    // SOP：确认已筛选并选中素材后，点击素材库自身的"提交"；不是外层"确定"。
    await submitMaterialPicker(tab.id);
    // 素材库弹窗关闭后，必须再点击外层素材配置面板的"确定"，确认素材写入创意组，
    // 否则流程会带着未确认的素材面板直接跳到"创意文案"步骤。
    await confirmMaterialSettings(tab.id);
    const panelClosed = await waitForAction(tab.id, { type:"materialPanelClosed" }, TARGETING_RENDER_TIMEOUT_MS);
    if (!panelClosed?.ok) throw new Error("素材配置面板点击确定后仍未关闭，已停止。");
  });
  await runStep("配置广告文案", async () => {
    await clickSectionAction(tab.id, "创意文案", "添加");
    const ready = await waitForAction(tab.id, { type:"copyPanelReady" }, PRODUCT_RENDER_TIMEOUT_MS);
    if (!ready?.ok) throw new Error("创意文案配置页未完成渲染。");
    const enabled = await waitForAction(tab.id, { type:"enableMultiCopyTest" }, TARGETING_RENDER_TIMEOUT_MS);
    if (!enabled?.ok) throw new Error(enabled?.error || "未能开启多文案测试。");
    await notify("已开启：多文案测试");
    await stabilize(tab.id);
    await fillInputInSection(tab.id, "创意文案上限", "2");
    const copyKeywords = [job.copyOne, job.copyTwo].filter(Boolean);
    if (copyKeywords.length < 1) throw new Error("缺少创意文案关键词。");
    for (let i = 0; i < copyKeywords.length; i++) {
      const keyword = copyKeywords[i];
      if (i > 0) {
        await clearCopySearch(tab.id);
        await pressEnterInCopyPanel(tab.id);
        await stabilize(tab.id);
      }
      await fillCopyPanelInput(tab.id, ["请输入文案关键词"], keyword);
      await pressEnterInCopyPanel(tab.id);
      await stabilize(tab.id, TARGETING_RENDER_MIN_DELAY_MS, TARGETING_RENDER_TIMEOUT_MS);
      const selected = await waitForAction(tab.id, { type:"selectCopyRowsByKeyword", keyword, maxCount:1 }, TARGETING_RENDER_TIMEOUT_MS);
      if (!selected?.ok || selected.count < 1) throw new Error(`文案搜索结果未能选择至少 1 条：${keyword}`);
    }
    const verified = await waitForAction(tab.id, { type:"copySelectionsReady", keywords:copyKeywords }, TARGETING_RENDER_TIMEOUT_MS);
    if (!verified?.ok) throw new Error(`已选文案区域未出现目标文案：${verified?.missing?.join(" / ") || "未知"}`);
    await notify("已确认：已选文案区域包含目标文案。");
    await confirmCopySettings(tab.id);
    const panelClosed = await waitForAction(tab.id, { type:"copyPanelClosed" }, PRODUCT_RENDER_TIMEOUT_MS);
    if (!panelClosed?.ok) throw new Error("创意文案面板点击确定后仍未关闭，已停止。");
  });
  await runStep("配置落地页", async () => {
    const uniquePages = [...new Set(job.landingPages.map((item) => item.name))];
    const isUnified = uniquePages.length === 1;
    await clickSectionAction(tab.id, "落地页", "添加");
    await selectRadioInSection(tab.id, "落地页分配规则", isUnified ? "统一配置" : "按账户分配");
    if (isUnified) {
      await fill(tab.id, ["请输入关键词"], uniquePages[0]);
      const searched = await evaluate(tab.id, { type:"clickLandingPageSearch" });
      if (!searched?.ok) throw new Error(searched?.error || "落地页搜索按钮未点击。");
      await waitFor(tab.id, [uniquePages[0]]);
      await stabilize(tab.id, TARGETING_RENDER_MIN_DELAY_MS, TARGETING_RENDER_TIMEOUT_MS);
      const selected = await evaluate(tab.id, { type:"selectLandingPageRow", name:uniquePages[0] });
      if (!selected?.ok || selected.count !== 1) throw new Error("落地页搜索结果未能实际勾选，已停止。");
    } else {
      for (const { accountId, name } of job.landingPages) {
        const accountSelected = await evaluate(tab.id, { type:"selectLandingPageAccount", accountId });
        if (!accountSelected?.ok) throw new Error(accountSelected?.error || `未找到账户 ${accountId}`);
        await notify(`已选择账户：${accountId}`);
        await stabilize(tab.id);
        await fill(tab.id, ["请输入关键词"], name);
        const searched = await evaluate(tab.id, { type:"clickLandingPageSearch" });
        if (!searched?.ok) throw new Error(searched?.error || "落地页搜索按钮未点击。");
        await waitFor(tab.id, [name]);
        await stabilize(tab.id, TARGETING_RENDER_MIN_DELAY_MS, TARGETING_RENDER_TIMEOUT_MS);
        const selected = await evaluate(tab.id, { type:"selectLandingPageRow", name });
        if (!selected?.ok || selected.count !== 1) throw new Error(selected?.error || `账户 ${accountId} 的落地页「${name}」未能勾选。`);
        await notify(`账户 ${accountId} 已勾选落地页：${name}`);
      }
    }
    await click(tab.id, ["确 定", "确定"]);
  });
  await runStep("生成广告预览", async () => {
    await click(tab.id, ["生成预览广告", "生成预览"]);
    await waitFor(tab.id, ["预览", "广告预览"], 15000);
  });
  await status("done", "预览已生成", `已执行至预览：${job.accountIds.length} 个账户。请在创量页面逐项核对后由操作人手动提交。`);
  await notify("预览生成完成。执行器已按安全边界停止，不会点击“提交审核”。");
  await sendDingTalkNotification(activeDingTalkWebhook, "广点通预览完成", `预览已生成，账户数：${job.accountIds.length}。执行器已停止，请人工核对后提交审核。`);
}

function pageAgent(input) {
  const visible = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0; };
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const wanted = (el, labels) => { const text = clean(el.innerText || el.textContent || el.getAttribute("aria-label")); return labels.find((label) => text === label || text.includes(label)); };
  const dispatch = (el, type) => el.dispatchEvent(new Event(type, { bubbles:true }));
  const interactive = () => [...document.querySelectorAll("button,[role=button],a,label,input,textarea,select,.el-button,.el-radio,.el-checkbox")].filter(visible);
  const clickText = (labels) => { for (const el of interactive()) { const label = wanted(el, labels); if (label) { el.click(); return { ok:true, label }; } } return { ok:false }; };
  const findInput = (placeholders) => [...document.querySelectorAll("input,textarea")].filter(visible).find((el) => placeholders.some((item) => clean(el.placeholder).includes(item) || clean(el.getAttribute("aria-label")).includes(item)));
  const titledPanel = (title) => {
    const candidates = [];
    for (const marker of [...document.querySelectorAll("h1,h2,h3,h4,div,span,p")]) {
      if (!visible(marker) || clean(marker.innerText) !== title) continue;
      let parent = marker.parentElement;
      while (parent && parent !== document.body) {
        const buttons = [...parent.querySelectorAll("button")].filter(visible);
        if (buttons.length && clean(parent.innerText).includes(title)) candidates.push({ node:parent, size:clean(parent.innerText).length });
        parent = parent.parentElement;
      }
    }
    if (!candidates.length) return null;
    const smallest = Math.min(...candidates.map((item) => item.size));
    const scopes = candidates.filter((item) => item.size === smallest).map((item) => item.node);
    return scopes.length === 1 ? scopes[0] : null;
  };
  // 页面同时存在外层广告抽屉和内层“选择转化”抽屉；不能按 DOM 顺序取第一个。
  // 内层窗口的标题是 .header-title，利用其最近的 .cl-drawer 锁定实际操作范围。
  const findConversionPanel = () => {
    const title = [...document.querySelectorAll(".header-title")]
      .find((node) => visible(node) && clean(node.innerText) === "选择转化");
    if (title) {
      const drawer = title.closest(".cl-drawer");
      if (drawer && visible(drawer)) return drawer;
    }
    return [...document.querySelectorAll(".cl-drawer")]
      .find((node) => visible(node) && [...node.querySelectorAll(".header-title")]
        .some((titleNode) => clean(titleNode.innerText) === "选择转化")) || null;
  };
  const copyPanel = () => {
    const markers = [...document.querySelectorAll("div,section,form,td")]
      .filter((node) => visible(node) && clean(node.innerText).includes("多文案测试") && clean(node.innerText).includes("请输入文案关键词"));
    if (!markers.length) {
      const fallback = [...document.querySelectorAll("div,section,form,td")]
        .filter((node) => visible(node) && clean(node.innerText).includes("多文案测试"));
      if (!fallback.length) return null;
      const smallest = Math.min(...fallback.map((node) => clean(node.innerText).length));
      const candidates = fallback.filter((node) => clean(node.innerText).length === smallest);
      return candidates.length === 1 ? candidates[0] : null;
    }
    const smallest = Math.min(...markers.map((node) => clean(node.innerText).length));
    const candidates = markers.filter((node) => clean(node.innerText).length === smallest);
    return candidates.length === 1 ? candidates[0] : null;
  };
  if (input.type === "pageInfo") return { ok:document.body && document.body.innerText.length > 0, title:document.title };
  if (input.type === "renderState") {
    const loading = [...document.querySelectorAll(".el-loading-mask,.el-loading-spinner,[aria-busy=true]")].filter(visible).length;
    const signature = [
      [...document.querySelectorAll(".el-dialog,label.el-checkbox,label.el-radio,label.el-radio-button,tr")].filter(visible).length,
      document.querySelectorAll("button:not([disabled])").length,
      document.body.innerText.length
    ].join(":");
    return { ok:true, loading, signature };
  }
  if (input.type === "hasText") { const pageText = clean(document.body.innerText); const matches = input.labels.filter((label) => pageText.includes(label)); return { ok:matches.length > 0, matches }; }
  if (input.type === "dialogVisible") {
    const panels = [...document.querySelectorAll(".el-dialog,[role=dialog],[class*=dialog],[class*=modal]")].filter((node) => visible(node) && clean(node.innerText).includes(input.title));
    return { ok:panels.length > 0 };
  }
  if (input.type === "optimizationGoalSelected" || input.type === "optimizationGoalApplied") {
    if (input.type === "optimizationGoalSelected") {
      // 不同页面版本会把选中项写到 placeholder 或 value；两者都必须接受。
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label="优化目标"]')].filter(visible);
      if (dialogs.length !== 1) return { ok:false };
      const field = [...dialogs[0].querySelectorAll("input")].filter(visible)[0];
      return { ok:Boolean(field && (clean(field.placeholder) === input.goal || clean(field.value) === input.goal)) };
    }
    // 子窗口关闭后，外层会将目标写入其标准选择框的 value。
    const fields = [...document.querySelectorAll("input")].filter((node) => visible(node) && clean(node.placeholder) === "请选择优化目标");
    return { ok:fields.length === 1 && clean(fields[0].value) === input.goal };
  }
  if (input.type === "optimizationGoalDialogClosed") {
    return { ok:[...document.querySelectorAll('[role="dialog"][aria-label="优化目标"]')].filter(visible).length === 0 };
  }
  if (input.type === "confirmOptimizationGoal") {
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label="优化目标"]')].filter(visible);
    if (dialogs.length !== 1) return { ok:false, error:`优化目标子窗口数量异常：${dialogs.length}。` };
    const enabled = (node) => !node.disabled && !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true" && !node.classList.contains("is-disabled");
    // 实测本窗口为 Element 按钮：只限定在 dialog 内，先按 primary 精确匹配，再按文本兜底。
    const allButtons = [...dialogs[0].querySelectorAll("button")].filter((node) => visible(node) && enabled(node));
    const primary = allButtons.filter((node) => node.classList.contains("el-button--primary") && clean(node.innerText).replace(/\s/g, "") === "确定");
    const fallback = allButtons.filter((node) => clean(node.innerText).replace(/\s/g, "") === "确定");
    const matches = primary.length === 1 ? primary : fallback;
    if (matches.length !== 1) {
      return { ok:false, error:`优化目标确认按钮匹配异常：主按钮 ${primary.length} 个、文字按钮 ${fallback.length} 个、可用按钮 ${allButtons.length} 个。` };
    }
    matches[0].click();
    return { ok:true, binding:"optimizationGoalDedicated" };
  }
  if (input.type === "confirmTargetingTemplate") {
    // 该面板在当前创量页面没有 el-dialog / role=dialog，不能复用标准弹窗逻辑。
    const enabled = (node) => !node.disabled && !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true" && !node.classList.contains("is-disabled");
    const buttons = [...document.querySelectorAll("button")]
      .filter((node) => visible(node) && enabled(node) && clean(node.innerText).replace(/\s/g, "") === "确定");
    if (buttons.length !== 1) return { ok:false, error:`定向模板确认按钮数量异常：${buttons.length}。` };
    buttons[0].click();
    return { ok:true, binding:"targetingTemplateDedicated" };
  }
  if (input.type === "confirmBrandImage") {
    const enabled = (node) => !node.disabled && !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true" && !node.classList.contains("is-disabled");
    const buttons = [...document.querySelectorAll("button")]
      .filter((node) => visible(node) && enabled(node) && clean(node.innerText).replace(/\s/g, "") === "确定");
    if (!buttons.length) return { ok:false, error:"品牌形象窗口确认按钮未启用。" };
    // 品牌选择层会在创意编辑层之后挂载；同屏有两个确认时，最后一个就是品牌选择层的确认。
    buttons[buttons.length - 1].click();
    return { ok:true, binding:"brandImageDedicated", candidates:buttons.length };
  }
  if (input.type === "openGlobalMaterialBatchMenu") {
    // 只匹配创意组上方的全局“批量添加”，避开单个创意组里的“添加素材”。
    const buttons = [...document.querySelectorAll("button")].filter((node) => visible(node) && clean(node.innerText) === "批量添加");
    if (buttons.length !== 1) return { ok:false, error:`全局“批量添加”按钮数量异常：${buttons.length}。` };
    buttons[0].click();
    return { ok:true };
  }
  if (input.type === "chooseGlobalAddImage") {
    // Element UI 下拉层在动画期间会被 getBoundingClientRect 判为 0；
    // 菜单节点出现即是可点击的，不能用通用 visible() 再次过滤。
    const options = [...document.querySelectorAll("li.el-dropdown-menu__item")]
      .filter((node) => clean(node.innerText) === "添加图片");
    if (options.length !== 1) return { ok:false, error:`全局“添加图片”菜单项数量异常：${options.length}。` };
    options[0].click();
    return { ok:true };
  }
  if (input.type === "materialPickerReady") {
    const dialogs = [...document.querySelectorAll('[role="dialog"],.el-dialog')]
      .filter((node) => visible(node) && clean(node.innerText).includes("素材目录") && clean(node.innerText).includes("已选素材"));
    return { ok:dialogs.length === 1 };
  }
  if (input.type === "materialPickerClosed") {
    const dialogs = [...document.querySelectorAll('[role="dialog"],.el-dialog')]
      .filter((node) => visible(node) && clean(node.innerText).includes("素材目录") && clean(node.innerText).includes("已选素材"));
    return { ok:dialogs.length === 0 };
  }
  if (input.type === "submitSelectedMaterials") {
    const dialogs = [...document.querySelectorAll('[role="dialog"],.el-dialog')]
      .filter((node) => visible(node) && clean(node.innerText).includes("素材目录") && clean(node.innerText).includes("已选素材"));
    if (dialogs.length !== 1) return { ok:false, error:"素材库窗口未打开或不唯一。" };
    const text = clean(dialogs[0].innerText);
    const selected = Number((text.match(/已选素材[：:]\s*(\d+)/) || [])[1] || 0);
    if (selected < 1) return { ok:false, error:"素材尚未选中，不能提交。" };
    const buttons = [...dialogs[0].querySelectorAll("button")]
      .filter((node) => visible(node) && clean(node.innerText) === "提交");
    if (buttons.length !== 1 || buttons[0].disabled || buttons[0].hasAttribute("disabled")) return { ok:false, error:"素材已选中，但“提交”按钮尚未启用。" };
    buttons[0].click();
    return { ok:true, count:selected };
  }
  const activeMaterialPicker = () => {
    const pickers = [...document.querySelectorAll('[role="dialog"],.el-dialog')]
      .filter((node) => visible(node) && (
        clean(node.innerText).includes("素材库") ||
        clean(node.innerText).includes("素材目录") ||
        clean(node.innerText).includes("绱犳潗鐩綍") ||
        node.querySelector('[role="tab"][aria-selected="true"],.el-tabs__item.is-active')
      ) && node.querySelector('table, [role="tabpanel"],button'));
    // 动画阶段 Element UI 可能短暂保留旧 dialog；不猜测哪个有效，等到唯一素材库窗口稳定后再继续。
    return pickers.length === 1 ? pickers[0] : null;
  };
  const materialMetricButtons = (picker) => {
    // 严格限定在唯一素材库窗口内，只接受真实且已启用的 button；不再退回全页面文本匹配。
    if (!picker) return [];
    return [...picker.querySelectorAll("button")]
      .filter((node) => visible(node) && !node.disabled && ["自定义指标与排序", "自定义指标与时间"].includes(clean(node.innerText)));
  };
  if (input.type === "openMaterialDirectory") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, error:"素材库窗口未打开。" };
    // 必须点击“素材目录：全部”控件内部实际承接事件的 directory-input，
    // 外层 select-area 只是布局容器，点击它不会稳定打开目录树。
    const inputs = [...picker.querySelectorAll(".directory-select .directory-input")].filter(visible);
    if (inputs.length !== 1) return { ok:false, error:`素材目录下拉框数量异常：${inputs.length}。` };
    inputs[0].click();
    return { ok:true };
  }
  if (input.type === "searchMaterialDirectory") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, error:"素材库窗口未打开。" };
    const search = [...document.querySelectorAll('input[placeholder="请输入搜索内容"]')].filter(visible);
    if (search.length !== 1) return { ok:false, error:`素材目录搜索框数量异常：${search.length}。` };
    search[0].focus(); search[0].value = input.folder; dispatch(search[0], "input"); dispatch(search[0], "change");
    return { ok:true };
  }
  if (input.type === "materialDirectorySearchReady") {
    const search = [...document.querySelectorAll('input[placeholder="请输入搜索内容"]')].filter(visible);
    return { ok:search.length === 1, error:search.length ? `素材目录搜索框数量异常：${search.length}。` : "素材目录搜索框尚未渲染。" };
  }
  if (input.type === "chooseMaterialDirectory") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, error:"素材库窗口未打开。" };
    const options = [...document.querySelectorAll('[role="radio"],label.el-checkbox')]
      .filter((node) => visible(node) && clean(node.innerText) === input.folder);
    if (options.length !== 1) return { ok:false, error:options.length ? `素材目录“${input.folder}”不唯一。` : `素材目录搜索结果尚未出现“${input.folder}”。` };
    const checkbox = options[0].querySelector('input[type="checkbox"]');
    if (!checkbox) return { ok:false, error:`素材目录“${input.folder}”缺少可勾选控件。` };
    // 搜索结果的生效条件是专辑名称后的复选框，不是点击文字行。
    if (!checkbox.checked) checkbox.click();
    return { ok:Boolean(checkbox.checked) };
  }
  if (input.type === "closeMaterialDirectory") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, error:"素材库窗口未打开。" };
    const openSearch = [...document.querySelectorAll('input[placeholder="请输入搜索内容"]')].filter(visible);
    if (!openSearch.length) return { ok:true };
    // 目录下拉框内可能有多个同类输入，重新点目录会因不唯一而失效；
    // 点击素材库当前 tab 能安全收起浮层，且不会改动任何筛选条件。
    const tabs = [...picker.querySelectorAll('[role="tab"],.el-tabs__item')]
      .filter((node) => visible(node) && clean(node.innerText) === "素材库");
    if (tabs.length !== 1) return { ok:false, error:`素材库标签数量异常：${tabs.length}。` };
    tabs[0].click();
    return { ok:true };
  }
  if (input.type === "materialDirectoryClosed") {
    return { ok:[...document.querySelectorAll('input[placeholder="请输入搜索内容"]')].filter(visible).length === 0 };
  }
  if (input.type === "openUploadTimeFilter") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, error:"素材库窗口未打开。" };
    const starts = [...picker.querySelectorAll('input[placeholder="开始日期"]')].filter(visible);
    const ends = [...picker.querySelectorAll('input[placeholder="结束日期"]')].filter(visible);
    if (starts.length !== 1 || ends.length !== 1) return { ok:false, error:"上传时间范围控件不唯一。" };
    starts[0].click();
    return { ok:true };
  }
  if (input.type === "uploadTimeClearReady") {
    const panels = [...document.querySelectorAll(".el-picker-panel,.el-date-range-picker")].filter(visible);
    const buttons = panels.flatMap((panel) => [...panel.querySelectorAll("button")].filter((node) => visible(node) && clean(node.innerText) === "清空"));
    return { ok:buttons.length === 1, error:buttons.length ? `上传时间清空按钮数量异常：${buttons.length}。` : "上传时间清空浮窗尚未出现。" };
  }
  if (input.type === "clearUploadTimePopup") {
    const panels = [...document.querySelectorAll(".el-picker-panel,.el-date-range-picker")].filter(visible);
    const buttons = panels.flatMap((panel) => [...panel.querySelectorAll("button")].filter((node) => visible(node) && clean(node.innerText) === "清空"));
    if (buttons.length !== 1) return { ok:false, error:"上传时间浮窗清空按钮未找到。" };
    buttons[0].click();
    return { ok:true };
  }
  if (input.type === "uploadTimePopupClosed") {
    return { ok:[...document.querySelectorAll(".el-picker-panel,.el-date-range-picker")].filter(visible).length === 0 };
  }
  if (input.type === "openMaterialCustomMetrics") {
    const picker = activeMaterialPicker();
    // 当前素材库将该入口渲染为 BUTTON，内部还嵌套图标、DIV 与 SPAN；
    // 仅统计实际可点击按钮，避免把同一入口的内部节点重复计数。
    const targets = materialMetricButtons(picker);
    if (targets.length !== 1) return { ok:false, error:`自定义指标入口数量异常：${targets.length}。` };
    // 真实点击前先滚入可视区域。列表滚动与虚拟渲染会使旧坐标失效，
    // 必须在滚动完成后重新读取矩形位置。
    const button = targets[0];
    button.scrollIntoView({ block:"center", inline:"center", behavior:"instant" });
    const rect = button.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return { ok:false, error:"自定义指标入口未进入可点击视窗。" };
    const point = { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 };
    const topNode = document.elementFromPoint(point.x, point.y);
    if (!topNode || (!button.contains(topNode) && !topNode.contains(button))) return { ok:false, error:"自定义指标入口被其他浮层遮挡。" };
    // 原生调用不受 DevTools 取元素模式的鼠标拦截；失败时由后台使用返回坐标执行真实鼠标点击。
    try { HTMLElement.prototype.click.call(targets[0]); }
    catch { targets[0].dispatchEvent(new MouseEvent("click", { bubbles:true, cancelable:true, view:window })); }
    return { ok:true, point };
  }
  if (input.type === "materialCustomMetricsReady") {
    const picker = activeMaterialPicker();
    const targets = materialMetricButtons(picker);
    return { ok:targets.length === 1, error:targets.length ? `自定义指标入口数量异常：${targets.length}。` : "自定义指标入口尚未渲染。" };
  }
  if (input.type === "selectMaterialListView") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, error:"素材库窗口未打开。" };
    const listOptions = [...picker.querySelectorAll('[role="radio"],label.el-radio-button')]
      .filter((node) => visible(node) && clean(node.innerText).includes("列表"));
    if (listOptions.length !== 1) return { ok:false, error:`素材“列表”标签数量异常：${listOptions.length}。` };
    const radio = listOptions[0].querySelector('input[type="radio"]');
    if (!radio?.checked) listOptions[0].click();
    return { ok:Boolean(radio?.checked || listOptions[0].classList.contains("is-checked") || listOptions[0].classList.contains("is-active")) };
  }
  if (input.type === "selectMaterialCustomMetric") {
    // 列表模式的入口会直接展开“数据时间”面板，不再有“排序依据/自定义指标”单选步骤。
    const directTimePanel = [...document.querySelectorAll('[role="tooltip"],.el-popover,.el-picker-panel,.el-date-range-picker')]
      .filter((node) => visible(node) && (clean(node.innerText).includes("数据时间") || node.matches(".el-picker-panel,.el-date-range-picker")));
    if (directTimePanel.length === 1) return { ok:true };
    const popovers = [...document.querySelectorAll('[role="tooltip"],.el-popover')]
      .filter((node) => visible(node) && clean(node.innerText).includes("排序依据"));
    if (popovers.length !== 1) return { ok:false, error:`自定义指标弹层数量异常：${popovers.length}。` };
    const options = [...popovers[0].querySelectorAll('[role="radio"],label.el-radio-button')]
      .filter((node) => visible(node) && clean(node.innerText) === "自定义指标");
    if (options.length !== 1) return { ok:false, error:"自定义指标标签不唯一。" };
    const nativeRadio = options[0].querySelector('input[type="radio"]');
    if (!nativeRadio?.checked) options[0].click();
    return { ok:Boolean(nativeRadio?.checked || options[0].classList.contains("is-checked") || options[0].classList.contains("is-active")) };
  }
  if (input.type === "setMaterialCustomDays") {
    const tooltip = [...document.querySelectorAll('[role="tooltip"],.el-popover,.el-picker-panel,.el-date-range-picker')]
      .filter((node) => visible(node) && (clean(node.innerText).includes("数据时间") || node.matches(".el-picker-panel,.el-date-range-picker")))[0];
    if (!tooltip) return { ok:false, error:"自定义指标面板尚未渲染。" };
    const custom = [...tooltip.querySelectorAll('[role="radio"],label.el-radio-button')]
      .filter((node) => visible(node) && clean(node.innerText) === "自定义指标");
    if (custom.length > 1) return { ok:false, error:"“自定义指标”选项不唯一。" };
    // 网格模式需显式选中“自定义指标”；列表模式已直接进入数据时间面板。
    if (custom.length === 1) {
      const radio = custom[0].querySelector('input[type="radio"]');
      if (radio && !radio.checked) custom[0].click();
    }
    const starts = [...tooltip.querySelectorAll('input[placeholder="开始日期"]')].filter(visible);
    const ends = [...tooltip.querySelectorAll('input[placeholder="结束日期"]')].filter(visible);
    if (starts.length !== 1 || ends.length !== 1) return { ok:false, error:"自定义指标的数据时间控件尚未渲染。" };
    const start = clean(input.start); const end = clean(input.end);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return { ok:false, error:"素材数据时间区间无效。" };
    starts[0].value = start; ends[0].value = end;
    dispatch(starts[0], "input"); dispatch(starts[0], "change"); dispatch(ends[0], "input"); dispatch(ends[0], "change");
    return { ok:clean(starts[0].value) === start && clean(ends[0].value) === end };
  }
  if (input.type === "closeMaterialCustomTimePanel") {
    const panels = [...document.querySelectorAll('[role="tooltip"],.el-popover,.el-picker-panel,.el-date-range-picker')]
      .filter((node) => visible(node) && (clean(node.innerText).includes("数据时间") || node.matches(".el-picker-panel,.el-date-range-picker")));
    if (!panels.length) return { ok:true, point:null };
    const triggers = materialMetricButtons(activeMaterialPicker());
    if (triggers.length !== 1) return { ok:false, error:`数据时间浮窗已打开，但关闭触发器数量异常：${triggers.length}。` };
    const button = triggers[0];
    button.scrollIntoView({ block:"center", inline:"center", behavior:"instant" });
    const rect = button.getBoundingClientRect();
    try { HTMLElement.prototype.click.call(triggers[0]); }
    catch { triggers[0].dispatchEvent(new MouseEvent("click", { bubbles:true, cancelable:true, view:window })); }
    return { ok:true, point:{ x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 } };
  }
  if (input.type === "materialCustomTimePanelClosed") {
    const panels = [...document.querySelectorAll('[role="tooltip"],.el-popover,.el-picker-panel,.el-date-range-picker')]
      .filter((node) => visible(node) && (clean(node.innerText).includes("数据时间") || node.matches(".el-picker-panel,.el-date-range-picker")));
    return { ok:panels.length === 0, error:"数据时间浮窗仍在打开。" };
  }
  if (input.type === "materialPickerRowsReady") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, error:"素材库窗口未打开。" };
    const rows = [...picker.querySelectorAll("tr")].filter((row) => visible(row) && row.querySelector("td") && row.querySelector('input[type="checkbox"]'));
    return { ok:rows.length > 0, error:"素材库筛选结果尚未渲染。" };
  }
  const brandImagePanel = () => {
    const inputs = [...document.querySelectorAll('input[placeholder="请输入关键词"]')].filter(visible);
    // 品牌面板不是标准 dialog，且表格并非搜索框父节点；页面特有提示是最稳定锚点。
    if (!clean(document.body.innerText).includes("找不到品牌形象") || !inputs.length) return null;
    // 创意编辑页也有一个同名输入框，品牌面板在 DOM 中后出现，取最后一个可见输入框。
    return { field:inputs[inputs.length - 1] };
  };
  if (input.type === "brandImagePanelReady") {
    return { ok:Boolean(brandImagePanel()) };
  }
  if (input.type === "searchBrandImage") {
    const panel = brandImagePanel();
    if (!panel) return { ok:false, error:"品牌形象选择面板未就绪。" };
    const field = panel.field;
    if (!field) return { ok:false, error:"品牌形象搜索输入框未找到。" };
    field.focus(); field.value = input.keyword; dispatch(field, "input"); dispatch(field, "change");
    const rect = field.getBoundingClientRect();
    const candidates = [...document.querySelectorAll("button")].filter((button) => {
      if (!visible(button) || button.disabled) return false;
      const r = button.getBoundingClientRect();
      return r.left >= rect.right - 2 && Math.abs((r.top + r.height / 2) - (rect.top + rect.height / 2)) < Math.max(rect.height, r.height);
    }).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    if (!candidates.length) return { ok:false, error:"品牌形象搜索框右侧未找到搜索按钮。" };
    candidates[0].click();
    return { ok:true };
  }
  if (input.type === "selectFirstBrandImage") {
    const panel = brandImagePanel();
    if (!panel) return { ok:false, count:0, error:"品牌形象选择面板未就绪。" };
    const fieldRect = panel.field.getBoundingClientRect();
    const rows = [...document.querySelectorAll("tr")].filter((row) => {
      // 表头同样有复选框；只能把含 td 的首个数据行作为“第一个品牌形象”。
      if (!visible(row) || !row.querySelector("td") || row.querySelector("th") || !row.querySelector('input[type="checkbox"]') || !clean(row.innerText)) return false;
      const rect = row.getBoundingClientRect();
      return rect.top >= fieldRect.bottom && rect.top - fieldRect.bottom < 900;
    }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (!rows.length) return { ok:false, count:0, error:"品牌形象搜索结果尚未渲染。" };
    const checkbox = rows[0].querySelector('input[type="checkbox"]');
    if (!checkbox.checked) checkbox.click();
    return { ok:Boolean(checkbox.checked), count:checkbox.checked ? 1 : 0 };
  }
  if (input.type === "searchOptimizationGoal") {
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label="优化目标"]')].filter(visible);
    if (dialogs.length !== 1) return { ok:false, error:"优化目标子窗口未打开。" };
    const dialog = dialogs[0];
    const field = [...dialog.querySelectorAll("input")].filter(visible)[0];
    if (!field) return { ok:false, error:"优化目标下拉输入框未找到。" };
    // 搜索只触发一次；不能在轮询中反复 click 输入框，否则会叠加/重开下拉层。
    field.focus(); field.value = input.goal; dispatch(field, "input"); dispatch(field, "change");
    return { ok:true };
  }
  if (input.type === "selectOptimizationGoalOption") {
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label="优化目标"]')].filter(visible);
    if (dialogs.length !== 1) return { ok:false, error:"优化目标子窗口未打开。" };
    const dialog = dialogs[0];
    // 选项列表位于该子窗口内，不能扫描整个 document，否则会命中外层转化表格的同名文字。
    const choices = [...dialog.querySelectorAll("li,div,span,[role=option],.el-select-dropdown__item")]
      .filter((node) => visible(node) && !node.classList.contains("is-disabled") && clean(node.innerText) === input.goal)
      .filter((node) => ![...node.children].some((child) => clean(child.innerText) === input.goal));
    if (choices.length !== 1) return { ok:false, error:choices.length ? `优化目标搜索结果“${input.goal}”不唯一。` : `优化目标搜索结果尚未显示“${input.goal}”。` };
    const field = [...dialog.querySelectorAll("input")].filter(visible)[0];
    choices[0].click();
    return { ok:clean(field.placeholder) === input.goal || clean(field.value) === input.goal };
  }
  if (input.type === "clickText") return clickText(input.labels);
  if (input.type === "fill") { const el = findInput(input.placeholders); if (!el) return { ok:false }; el.focus(); el.value = input.value; dispatch(el, "input"); dispatch(el, "change"); el.blur(); return { ok:true, label:el.placeholder || el.getAttribute("aria-label") || "输入框" }; }
  if (input.type === "fillInputByIndex") {
    const fields = [...document.querySelectorAll("input,textarea")].filter((el) => visible(el) && input.placeholders.some((item) => clean(el.placeholder).includes(item) || clean(el.getAttribute("aria-label")).includes(item)));
    const field = fields[input.index];
    if (!field) return { ok:false };
    field.focus(); field.value = input.value; dispatch(field, "input"); dispatch(field, "change"); field.blur();
    return { ok:clean(field.value) === input.value };
  }
  if (input.type === "focus") { const el = findInput(input.placeholders); if (!el) return { ok:false }; el.focus(); return { ok:true }; }
  if (input.type === "clickSearchButton") {
    const buttons = [...document.querySelectorAll('button[title="搜索"].cl-search-input__submit,button.cl-search-input__submit[title="搜索"]')].filter(visible);
    if (buttons.length !== 1) return { ok:false, error:buttons.length ? `搜索按钮不唯一：${buttons.length} 个。` : "未找到搜索按钮。" };
    buttons[0].click(); return { ok:true };
  }
  // 账户批量搜索：弹窗标题为“请输入账户ID（1/1000）”，每行一个 input，回车换行。
  const findAccountBatchPopover = () => [...document.querySelectorAll(".el-popover.el-popper")].find((el) => visible(el) && clean(el.innerText).includes("请输入账户ID"));
  if (input.type === "openAccountBatchSearch") {
    // 批量搜索图标位于“选择媒体账户”弹窗内 .cl-search-input__batch 下，触发元素为 .el-popover__reference。
    const dialog = [...document.querySelectorAll(".el-dialog,[role=dialog]")].find((el) => visible(el) && clean(el.innerText).includes("选择媒体账户")) || document;
    const ref = dialog.querySelector(".cl-search-input__batch .el-popover__reference") || dialog.querySelector(".cl-search-input__batch");
    if (!ref) return { ok:false, error:"未找到批量搜索图标。" };
    if (!findAccountBatchPopover()) ref.click();
    return new Promise((resolve) => {
      const deadline = Date.now() + 3000;
      const tick = () => {
        if (findAccountBatchPopover()) resolve({ ok:true });
        else if (Date.now() > deadline) resolve({ ok:false, error:"批量搜索弹窗未打开。" });
        else setTimeout(tick, 100);
      };
      tick();
    });
  }
  if (input.type === "fillAccountBatchLine") {
    const popover = findAccountBatchPopover();
    if (!popover) return { ok:false, error:"批量搜索弹窗未打开。" };
    const lineInputs = () => [...popover.querySelectorAll("input.el-input__inner")].filter(visible);
    const target = lineInputs()[lineInputs().length - 1];
    if (!target) return { ok:false, error:"未找到批量搜索输入行。" };
    target.focus();
    target.value = input.id;
    dispatch(target, "input");
    dispatch(target, "change");
    if (input.isLast) return { ok:true, lines:lineInputs().length };
    // 非最后一行：回车触发新增行（placeholder 提示“回车可换行”），并等待新 input 出现。
    const before = lineInputs().length;
    target.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true }));
    target.dispatchEvent(new KeyboardEvent("keypress", { key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true }));
    return new Promise((resolve) => {
      const deadline = Date.now() + 3000;
      const tick = () => {
        const after = lineInputs().length;
        if (after > before) resolve({ ok:true, lines:after });
        else if (Date.now() > deadline) resolve({ ok:false, error:"回车未触发新增行。", lines:after });
        else setTimeout(tick, 100);
      };
      tick();
    });
  }
  if (input.type === "clickAccountBatchSearch") {
    const popover = findAccountBatchPopover();
    if (!popover) return { ok:false, error:"批量搜索弹窗未打开。" };
    const footer = popover.querySelector("footer") || popover;
    const btn = [...footer.querySelectorAll("button")].find((b) => visible(b) && !b.disabled && clean(b.innerText) === "搜索");
    if (!btn) return { ok:false, error:"未找到批量搜索的搜索按钮。" };
    btn.click();
    return { ok:true };
  }
  if (input.type === "selectAllAccountRows") {
    const dialog = [...document.querySelectorAll(".el-dialog,[role=dialog]")].find((el) => visible(el) && clean(el.innerText).includes("选择媒体账户"));
    if (!dialog) return { ok:false, error:"未打开选择媒体账户弹窗。" };
    // 全选复选框位于表头 th（.el-table-column--selection）内的 label.el-checkbox；
    // 点击它一次即可勾选全部数据行，比逐行点击更稳定。
    const headerLabel = [...dialog.querySelectorAll("th.el-table-column--selection label.el-checkbox, thead label.el-checkbox")].find(visible);
    if (!headerLabel) return { ok:false, error:"未找到表头全选复选框。" };
    const headerInput = headerLabel.querySelector("input[type=checkbox]");
    const headerChecked = () => headerInput?.checked || headerLabel.classList.contains("is-checked") || headerLabel.querySelector(".is-checked");
    const countSelected = () => {
      const rows = [...dialog.querySelectorAll(".el-table__body-wrapper tr.el-table__row, tbody tr.el-table__row")].filter(visible);
      let count = 0, total = 0;
      for (const row of rows) {
        const label = row.querySelector("label.el-checkbox");
        const nativeInput = label?.querySelector("input[type=checkbox]");
        if (!label || !nativeInput) continue;
        total++;
        if (nativeInput.checked || label.classList.contains("is-checked")) count++;
      }
      return { count, total };
    };
    // 表头未全选时点击触发全选；已全选则不重复点击（避免反选）。
    if (!headerChecked()) headerLabel.click();
    // 点击后 Vue 异步更新各行状态，等一帧再统计，避免误判未选中。
    return new Promise((resolve) => {
      setTimeout(() => {
        const { count, total } = countSelected();
        resolve({ ok:count > 0 && count === total, count, total });
      }, 300);
    });
  }
  const findLandingPageDialog = () => {
    const standard = [...document.querySelectorAll(".el-dialog,[role=dialog]")].filter((node) => visible(node) && (clean(node.innerText).includes("选择落地页") || clean(node.innerText).includes("请选择落地页")))[0];
    if (standard) return standard;
    const title = [...document.querySelectorAll("*")].find((el) => visible(el) && (clean(el.innerText) === "请选择落地页" || clean(el.innerText) === "选择落地页"));
    if (!title) return null;
    let node = title.parentElement;
    while (node && node !== document.body) {
      if (visible(node) && (node.querySelector(".account-list-wrapper") || node.querySelector("input[placeholder='请输入关键词']"))) return node;
      node = node.parentElement;
    }
    return null;
  };
  if (input.type === "clickLandingPageSearch") {
    const dialog = findLandingPageDialog();
    if (!dialog) return { ok:false, error:"未打开选择落地页弹窗。" };
    // 广点通的搜索按钮文案会变：旧版本叫"搜索"，新版本叫"查询"；还有一种放大镜图标按钮（class 为 cl-search-input__submit，title="搜索"，innerText 为空）。
    // 优先取紧贴"请输入关键词"输入框右侧的可见按钮，容错率最高。
    const keywordInput = [...dialog.querySelectorAll("input,textarea")].filter(visible).find((el) => clean(el.placeholder).includes("请输入关键词"));
    const candidates = [...dialog.querySelectorAll("button")]
      .filter((btn) => visible(btn) && !btn.disabled)
      .filter((btn) => {
        const text = clean(btn.innerText) || clean(btn.getAttribute("title") || "");
        return ["搜索", "查询", "搜 索", "查 询"].includes(text) || /搜索/.test(text) || /查\s*询/.test(text) || btn.classList.contains("cl-search-input__submit");
      });
    let target = null;
    if (keywordInput) {
      const rect = keywordInput.getBoundingClientRect();
      target = candidates.filter((btn) => {
        const bRect = btn.getBoundingClientRect();
        // 在输入框右侧且垂直方向接近（±80px 以内视为同行）
        return bRect.left >= rect.left + rect.width - 20 && Math.abs(bRect.top - rect.top) < 80;
      }).sort((a, b) => {
        const aDist = Math.abs(a.getBoundingClientRect().top - rect.top) + Math.abs(a.getBoundingClientRect().left - rect.right);
        const bDist = Math.abs(b.getBoundingClientRect().top - rect.top) + Math.abs(b.getBoundingClientRect().left - rect.right);
        return aDist - bDist;
      })[0];
    }
    if (!target) target = candidates[0];
    if (!target) return { ok:false, error:"未找到落地页搜索按钮（已尝试图标/搜索/查询）。" };
    target.click();
    return { ok:true };
  }
  if (input.type === "selectLandingPageAccount") {
    const dialog = findLandingPageDialog();
    if (!dialog) return { ok:false, error:"未打开选择落地页弹窗。" };
    const accountEl = [...dialog.querySelectorAll(".account-list-wrapper .account-name")].find((el) => visible(el) && (el.title === input.accountId || clean(el.textContent) === input.accountId));
    if (!accountEl) return { ok:false, error:`未找到账户 ${input.accountId}。` };
    const wrapper = accountEl.closest(".account-content-wrapper");
    if (!wrapper) return { ok:false, error:`账户 ${input.accountId} 结构异常。` };
    if (!wrapper.classList.contains("checked")) wrapper.click();
    return { ok:true, accountId:input.accountId };
  }
  if (input.type === "selectLandingPageRow") {
    const dialog = findLandingPageDialog();
    if (!dialog) return { ok:false, error:"未打开选择落地页弹窗。" };
    const labelMatches = (label) => {
      const text = clean(label.innerText);
      if (text.includes(input.name)) return true;
      return [...label.querySelectorAll("[title],[aria-label]")].some((node) => {
        const attr = node.getAttribute("title") || node.getAttribute("aria-label") || "";
        return attr.includes(input.name);
      });
    };
    // 实际结构：.table-body > .el-checkbox-group > label.el-checkbox（一行即一个 label）
    let labels = [...dialog.querySelectorAll("label.el-checkbox")].filter(visible).filter(labelMatches);
    if (!labels.length) {
      // 兜底旧版表格结构
      const rows = [...dialog.querySelectorAll("tr,[role=row],.el-table__row")].filter(visible).filter((el) => clean(el.innerText).includes(input.name));
      labels = rows.map((row) => row.querySelector("label.el-checkbox")).filter(Boolean);
    }
    if (!labels.length) return { ok:false, error:`未找到落地页行：${input.name}` };
    const label = labels[0];
    const nativeInput = label.querySelector("input[type=checkbox]");
    if (nativeInput && !nativeInput.checked) {
      label.click();
    } else if (!nativeInput) {
      label.click();
    }
    // 等待勾选状态生效
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const checked = nativeInput?.checked || label.classList.contains("is-checked") || label.querySelector(".is-checked");
      if (checked) break;
    }
    const checked = nativeInput?.checked || label.classList.contains("is-checked") || label.querySelector(".is-checked");
    return { ok:checked, count:checked ? 1 : 0 };
  }
  if (input.type === "clickDialogConfirm") {
    // 按窗口绑定确认策略；不要把任意“确定”当作可点击目标。
    const bindings = {
      "选择媒体账户":"elementFooter",
      "选择推广产品":"elementFooter",
      "定向模板":"elementFooter",
      "选择转化":"titledWindow",
      "优化目标":"titledWindow",
      "当前转化归因未配置完成":"titledWindow",
      "品牌形象":"titledWindow",
      "选择落地页":"titledWindow",
      "添加图片":"titledWindow",
      "多文案测试":"titledWindow",
      "创意基本信息":"titledWindow"
    };
    const strategy = bindings[input.dialogTitle];
    if (!strategy) return { ok:false, error:`未配置“${input.dialogTitle}”窗口的确认按钮绑定。` };
    const enabled = (node) => !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true" && !node.classList.contains("is-disabled") && !node.closest("[disabled],[aria-disabled=true],.is-disabled,.disabled");
    if (input.dialogTitle === "优化目标") {
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label="优化目标"]')].filter(visible);
      // 此窗口的 footer 在不同投放页版本中 class 不稳定；只在该 dialog 内找叶子“确定”，
      // 再优先主按钮，不能再依赖 .el-dialog__footer / 固定 class。
      const buttons = dialogs.length === 1
        ? [...dialogs[0].querySelectorAll("button,[role=button]")]
          .filter((node) => visible(node) && enabled(node) && clean(node.innerText).replace(/\s/g, "") === "确定")
          .filter((node) => ![...node.children].some((child) => clean(child.innerText).replace(/\s/g, "") === "确定"))
          .sort((a, b) => Number(b.classList.contains("el-button--primary")) - Number(a.classList.contains("el-button--primary")))
        : [];
      if (buttons.length !== 1) return { ok:false, error:"优化目标子窗口确认按钮未启用或不唯一。" };
      buttons[0].click(); return { ok:true, binding:"optimizationGoalDialog" };
    }
    if (strategy === "headerFooter") {
      const dialogs = [...document.querySelectorAll(".el-dialog,[role=dialog],[class*=dialog]")].filter((node) => {
        if (!visible(node)) return false;
        const headers = [...node.querySelectorAll(".el-dialog__header,[class*=header],[class*=title],h1,h2,h3,h4")].filter(visible);
        return headers.some((header) => clean(header.innerText) === input.dialogTitle);
      });
      if (dialogs.length !== 1) return { ok:false, error:`未能唯一定位标题为“${input.dialogTitle}”的子窗口。` };
      const buttons = [...dialogs[0].querySelectorAll("button,[role=button],a,div,span")]
        .filter((node) => visible(node) && enabled(node) && clean(node.innerText).replace(/\s/g, "") === "确定")
        .filter((node) => ![...node.children].some((child) => clean(child.innerText).replace(/\s/g, "") === "确定"));
      if (buttons.length !== 1) return { ok:false, error:`“${input.dialogTitle}”子窗口确认按钮未启用或不唯一。` };
      buttons[0].click(); return { ok:true, binding:strategy };
    }
    if (strategy === "elementFooter") {
      const dialogs = [...document.querySelectorAll(".el-dialog,[role=dialog]")].filter((node) => visible(node) && clean(node.innerText).includes(input.dialogTitle));
      if (dialogs.length !== 1) return { ok:false, error:`“${input.dialogTitle}”标准弹窗不唯一或未打开。` };
      const footerButtons = [...dialogs[0].querySelectorAll(".el-dialog__footer button,.el-dialog__footer [role=button]")]
        .filter((node) => visible(node) && enabled(node) && clean(node.innerText).replace(/\s/g, "") === "确定");
      if (footerButtons.length !== 1) return { ok:false, error:`“${input.dialogTitle}”底部确认按钮未启用或不唯一。` };
      footerButtons[0].click(); return { ok:true, binding:strategy };
    }
    // 自定义窗口：从可见文字“确定”反向找到标题容器，优先最上层且最小的窗口范围。
    const candidates = [...document.querySelectorAll("button,[role=button],a,div,span")]
      .filter((node) => visible(node) && enabled(node) && clean(node.innerText).replace(/\s/g, "") === "确定")
      .filter((node) => ![...node.children].some((child) => clean(child.innerText).replace(/\s/g, "") === "确定"));
    const matches = [];
    for (const control of candidates) {
      let parent = control.parentElement;
      while (parent && parent !== document.body) {
        if (visible(parent) && clean(parent.innerText).includes(input.dialogTitle)) {
          const z = Number.parseInt(getComputedStyle(parent).zIndex, 10) || 0;
          matches.push({ control, z, size:clean(parent.innerText).length });
          break;
        }
        parent = parent.parentElement;
      }
    }
    if (!matches.length) return { ok:false, error:"当前窗口中未找到可用的确认按钮。" };
    const topZ = Math.max(...matches.map((item) => item.z));
    const onTop = matches.filter((item) => item.z === topZ);
    const smallest = Math.min(...onTop.map((item) => item.size));
    const controls = [...new Set(onTop.filter((item) => item.size === smallest).map((item) => item.control))];
    if (controls.length !== 1) return { ok:false, error:`当前窗口确认按钮不唯一：${controls.length} 个。` };
    controls[0].click(); return { ok:true, binding:strategy };
  }
  if (input.type === "clickSectionAction") {
    const scopes = [...document.querySelectorAll("td,section,div")].filter((node) => visible(node) && clean(node.innerText).includes(input.sectionTitle)).map((node) => ({ node, size:clean(node.innerText).length }));
    const matches = [];
    for (const item of scopes) {
      const buttons = [...item.node.querySelectorAll("button,[role=button],.el-button")].filter((button) => visible(button) && clean(button.innerText).includes(input.actionLabel));
      for (const button of buttons) matches.push({ button, size:item.size });
    }
    if (!matches.length) return { ok:false, error:`未找到“${input.sectionTitle}”中的“${input.actionLabel}”。` };
    const smallest = Math.min(...matches.map((item) => item.size));
    const buttons = [...new Set(matches.filter((item) => item.size === smallest).map((item) => item.button))];
    if (buttons.length !== 1) return { ok:false, error:`“${input.sectionTitle}”中的“${input.actionLabel}”不唯一。` };
    buttons[0].click(); return { ok:true };
  }
  if (input.type === "resourcePanelReady") {
    const panel = titledPanel(input.title);
    const hasInput = panel && [...panel.querySelectorAll("input")].some(visible);
    return { ok:Boolean(panel && hasInput) };
  }
  if (input.type === "materialPanelReady") {
    const pageText = clean(document.body.innerText);
    return { ok:pageText.includes("手动选取素材") && pageText.includes("创意组素材上限") };
  }
  if (input.type === "confirmMaterialPanel") {
    // 外层素材配置面板不是标准 dialog；在包含"手动选取素材"和"创意组素材上限"的容器里找确定按钮。
    const enabled = (node) => !node.disabled && !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true" && !node.classList.contains("is-disabled");
    const markers = [...document.querySelectorAll("div,section,td")].filter((node) => visible(node) && clean(node.innerText).includes("手动选取素材") && clean(node.innerText).includes("创意组素材上限"));
    const matches = [];
    for (const marker of markers) {
      let parent = marker.parentElement;
      while (parent && parent !== document.body) {
        if (visible(parent) && clean(parent.innerText).includes("手动选取素材") && clean(parent.innerText).includes("创意组素材上限")) {
          const buttons = [...parent.querySelectorAll("button")].filter((node) => visible(node) && enabled(node) && clean(node.innerText).replace(/\s/g, "") === "确定");
          for (const button of buttons) matches.push({ button, size:clean(parent.innerText).length });
        }
        parent = parent.parentElement;
      }
    }
    if (!matches.length) return { ok:false, error:"素材配置面板未找到或确认按钮未启用。" };
    const smallest = Math.min(...matches.map((item) => item.size));
    const buttons = [...new Set(matches.filter((item) => item.size === smallest).map((item) => item.button))];
    if (buttons.length !== 1) return { ok:false, error:`素材配置面板确认按钮不唯一：${buttons.length} 个。` };
    buttons[0].click();
    return { ok:true };
  }
  if (input.type === "materialPanelClosed") {
    const pageText = clean(document.body.innerText);
    return { ok:!pageText.includes("手动选取素材") && !pageText.includes("创意组素材上限") };
  }
  if (input.type === "copyPanelReady") {
    const panel = copyPanel();
    if (!panel) return { ok:false, error:"未找到包含多文案测试的创意文案面板。" };
    const hasOpen = [...panel.querySelectorAll("label.el-radio-button,label.el-radio")].some((node) => visible(node) && clean(node.innerText) === "开启");
    return { ok:hasOpen, error:"创意文案面板未渲染出多文案测试开关。" };
  }
  if (input.type === "enableMultiCopyTest") {
    const panel = copyPanel();
    if (!panel) return { ok:false, error:"未找到创意文案面板。" };
    const controls = [...panel.querySelectorAll("label.el-radio-button,label.el-radio")].filter((node) => visible(node) && clean(node.innerText) === "开启");
    if (controls.length !== 1) return { ok:false, error:`多文案测试"开启"控件数量异常：${controls.length}。` };
    const nativeInput = controls[0].querySelector("input[type=radio]");
    if (!nativeInput) return { ok:false, error:"多文案测试开启选项缺少单选控件。" };
    if (!nativeInput.checked) controls[0].click();
    return { ok:nativeInput.checked };
  }
  if (input.type === "configureMaterialFilters") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, error:"素材库窗口未打开。" };
    const listRadio = [...picker.querySelectorAll('[role="radio"],label.el-radio-button')]
      .find((node) => visible(node) && clean(node.innerText).includes("列表"));
    const listOk = Boolean(listRadio?.querySelector('input[type="radio"]')?.checked || listRadio?.classList.contains("is-checked"));
    const resultTable = [...picker.querySelectorAll("table")].some(visible);
    // 目录选择已在前置步骤通过目录树复选框 checked 状态验证。控件仅显示目录摘要，
    // 不会稳定回显叶子目录名称，因此这里不能用文字再次判定，避免误报和重复筛选。
    return { ok:listOk && resultTable, error:!listOk ? "素材库尚未切换到列表视图。" : !resultTable ? "素材筛选结果尚未渲染。" : undefined };
  }
  if (input.type === "openMaterialColumnFilter") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, error:"素材库窗口未打开。" };
    const headers = [...picker.querySelectorAll("th")]
      .filter((node) => visible(node) && clean(node.innerText).startsWith(input.label));
    if (headers.length !== 1) return { ok:false, error:`“${input.label}”表头数量异常：${headers.length}。` };
    const trigger = [...headers[0].querySelectorAll(".custom-filter-icon")].filter(visible)[0]
      || [...headers[0].querySelectorAll("[class*=filter-icon]")].filter(visible)[0];
    if (!trigger) return { ok:false, error:`“${input.label}”表头旁未找到筛选按钮。` };
    trigger.scrollIntoView({ block:"center", inline:"center" });
    const rect = trigger.getBoundingClientRect();
    HTMLElement.prototype.click.call(trigger);
    return { ok:true, point:{ x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 } };
  }
  if (["materialColumnFilterReady", "materialColumnFilterRowsReady", "addMaterialColumnFilterCondition", "openMaterialFilterMetric", "materialFilterMetricOptionReady", "materialFilterMetricSelected", "fillMaterialColumnFilterCondition", "materialFilterValueReady", "materialFilterValueSet", "confirmMaterialColumnFilters", "materialColumnFilterClosed"].includes(input.type)) {
    // 选项尚未写回第二行前，浮窗中仍是默认“花费”，不能用目标指标反向筛选浮窗。
    const needsSelectedLabel = ["materialColumnFilterReady", "materialFilterMetricSelected", "fillMaterialColumnFilterCondition", "materialFilterValueReady", "materialFilterValueSet"].includes(input.type);
    const activeLabel = needsSelectedLabel ? (input.label || input.condition?.label) : undefined;
    const panels = [...document.querySelectorAll("[role=tooltip],.el-popover")]
      .filter((node) => visible(node) && clean(node.innerText).includes("设置筛选条件")
        && (!activeLabel || [...node.querySelectorAll("input")].some((field) => visible(field) && clean(field.value) === activeLabel)));
    if (input.type === "materialColumnFilterClosed") return { ok:panels.length === 0, error:"素材筛选浮窗仍处于打开状态。" };
    if (panels.length !== 1) return { ok:false, error:panels.length ? "素材筛选浮窗不唯一。" : "素材筛选浮窗尚未渲染。" };
    if (input.type === "materialColumnFilterReady") return { ok:true };
    const panel = panels[0];
    const rows = [...panel.querySelectorAll(".table-filter-list-item")].filter(visible);
    if (input.type === "materialColumnFilterRowsReady") return { ok:rows.length === input.count, error:`素材筛选条件行尚未渲染到 ${input.count} 条。` };
    if (input.type === "addMaterialColumnFilterCondition") {
      if (rows.length > input.expectedRows) return { ok:true };
      if (rows.length !== input.expectedRows) return { ok:false, error:`素材筛选条件行数量异常：${rows.length}。` };
      const addCondition = [...panel.querySelectorAll("a")].find((node) => visible(node) && clean(node.innerText) === "添加条件");
      if (!addCondition) return { ok:false, error:"素材筛选浮窗缺少“添加条件”入口。" };
      addCondition.click(); return { ok:true };
    }
    if (input.type === "openMaterialFilterMetric") {
      const row = rows[input.index];
      const metric = row && [...row.querySelectorAll("input[readonly]")].filter(visible)[0];
      if (!metric) return { ok:false, error:`第 ${input.index + 1} 条条件的指标框未渲染。` };
      metric.scrollIntoView({ block:"center", inline:"center", behavior:"instant" });
      const rect = metric.getBoundingClientRect();
      HTMLElement.prototype.click.call(metric);
      return { ok:true, point:{ x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 } };
    }
    if (input.type === "materialFilterMetricOptionReady") {
      const options = [...document.querySelectorAll("li.el-select-dropdown__item")]
        .filter((node) => visible(node) && clean(node.innerText) === input.label);
      if (options.length !== 1) return { ok:false, error:options.length ? `指标“${input.label}”选项不唯一。` : `指标“${input.label}”下拉选项尚未出现。` };
      const rect = options[0].getBoundingClientRect();
      return { ok:true, point:{ x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 } };
    }
    if (input.type === "materialFilterMetricSelected") {
      const row = rows[input.index];
      const metric = row && [...row.querySelectorAll("input[readonly]")].filter(visible)[0];
      return { ok:clean(metric?.value) === input.label, error:`第 ${input.index + 1} 条条件指标未更新为“${input.label}”。` };
    }
    if (input.type === "fillMaterialColumnFilterCondition") {
      const row = rows[input.index], condition = input.condition;
      if (!row) return { ok:false, error:`第 ${input.index + 1} 条素材筛选条件尚未渲染。` };
      const selects = [...row.querySelectorAll("input[readonly]")].filter(visible);
      if (selects.length !== 2) return { ok:false, error:`第 ${input.index + 1} 条素材条件选择框数量异常。` };
      const metric = selects[0];
      if (clean(metric.value) !== condition.label) return { ok:false, error:`第 ${input.index + 1} 条条件指标尚未选中“${condition.label}”。` };
      if (clean(selects[1].value) !== "大于等于") return { ok:false, error:`第 ${input.index + 1} 条条件比较符不是“大于等于”。` };
      const valueInput = [...row.querySelectorAll("input")].find((node) => visible(node) && clean(node.placeholder).includes("请输入"));
      if (!valueInput) return { ok:false, error:`第 ${input.index + 1} 条条件值输入框未渲染。` };
      return { ok:true };
    }
    if (input.type === "materialFilterValueReady") {
      const row = rows[input.index];
      const valueInput = row && [...row.querySelectorAll("input")].find((node) => visible(node) && clean(node.placeholder).includes("请输入"));
      if (!valueInput) return { ok:false, error:`第 ${input.index + 1} 条条件值输入框未渲染。` };
      valueInput.scrollIntoView({ block:"center", inline:"center", behavior:"instant" });
      const rect = valueInput.getBoundingClientRect();
      return { ok:true, point:{ x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 } };
    }
    if (input.type === "materialFilterValueSet") {
      const row = rows[input.index];
      const valueInput = row && [...row.querySelectorAll("input")].find((node) => visible(node) && clean(node.placeholder).includes("请输入"));
      return { ok:clean(valueInput?.value) === String(input.value), error:`第 ${input.index + 1} 条条件数值未更新为 ${input.value}。` };
    }
    const confirm = [...panel.querySelectorAll("button")].find((node) => visible(node) && clean(node.innerText) === "确定" && !node.disabled);
    if (!confirm) return { ok:false, error:"素材筛选确认按钮未启用。" };
    confirm.scrollIntoView({ block:"center", inline:"center", behavior:"instant" });
    const rect = confirm.getBoundingClientRect();
    HTMLElement.prototype.click.call(confirm);
    return { ok:true, point:{ x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 } };
  }
  if (input.type === "clickMaterialLibraryTab") {
    const tab = [...document.querySelectorAll('[role="tab"],.el-tabs__item')]
      .find((node) => visible(node) && clean(node.innerText) === "素材库");
    if (!tab) return { ok:false, error:"素材库标签未找到。" };
    tab.click();
    return { ok:true };
  }
  if (input.type === "openMaterialPageSize" || input.type === "selectMaterialPageSize" || input.type === "materialPageSizeReady") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, error:"素材库窗口未打开。" };
    const sizeInput = [...picker.querySelectorAll('input[readonly]')].filter(visible)
      .find((node) => /条\/页|20|50|100/.test(clean(node.value) + clean(node.getAttribute("aria-label"))));
    const sizeNode = sizeInput || [...picker.querySelectorAll(".el-pagination .el-select, .el-pagination .el-input")].find(visible);
    if (!sizeNode) return { ok:false, error:"素材分页控件未找到。" };
    if (input.type === "materialPageSizeReady") {
      const text = clean(sizeNode.value || sizeNode.innerText || sizeNode.textContent);
      return { ok:text.includes("100"), error:`素材当前分页不是100条/页（当前：${text || "未知"}）。` };
    }
    sizeNode.scrollIntoView({ block:"center", inline:"center", behavior:"instant" });
    const rect = sizeNode.getBoundingClientRect();
    sizeNode.click();
    if (input.type === "openMaterialPageSize") return { ok:true, point:{x:rect.left + rect.width / 2, y:rect.top + rect.height / 2} };
    const options = [...document.querySelectorAll("li,div,span")].filter((node) => visible(node) && /100\s*条\/页/.test(clean(node.innerText)));
    const option = options.find((node) => ![...node.children].some((child) => /100\s*条\/页/.test(clean(child.innerText)))) || options[0];
    if (!option) return { ok:false, error:"分页下拉选项中未找到100条/页。" };
    option.click();
    return { ok:true };
  }
  if (input.type === "triggerSelectAllMaterialRows" || input.type === "verifyAllMaterialRows") {
    const picker = activeMaterialPicker();
    if (!picker) return { ok:false, count:0, error:"素材库窗口未打开。" };
    // 当前列表版没有“全选”文字；控件位于表头的 checkbox，且固定列会复制表头。
    // 只从 thead 定位，避免误点“仅显示可投放素材”等筛选复选框。
    // 只使用表头最左侧的 selection 列。该列的原生 input 可能是透明的，不能用可见性过滤它。
    const selectionHeaders = [...picker.querySelectorAll('thead th.el-table-column--selection')].filter(visible);
    if (!selectionHeaders.length) return { ok:false, count:0, error:"素材列表最左侧表头全选列未找到。" };
    const headerInputs = selectionHeaders.flatMap((header) => [...header.querySelectorAll('input[type="checkbox"]')]);
    if (!headerInputs.length) return { ok:false, count:0, error:"素材列表最左侧表头复选框未找到。" };
    const nativeInput = headerInputs.find((node) => !node.checked) || headerInputs[0];
    const selected = Number((clean(picker.innerText).match(/已选素材[：:]\s*(\d+)/) || [])[1] || 0);
    const dataRows = [...picker.querySelectorAll("tbody tr")].filter((row) => visible(row) && row.querySelector("td") && row.querySelector('input[type="checkbox"]'));
    const checkedRows = dataRows.filter((row) => row.querySelector('input[type="checkbox"]')?.checked).length;
    if (input.type === "verifyAllMaterialRows") {
      const headerChecked = headerInputs.some((node) => node.checked || node.closest(".el-checkbox")?.classList.contains("is-checked"));
      const allRowsChecked = dataRows.length > 0 && checkedRows === dataRows.length;
      return { ok:headerChecked && allRowsChecked, count:selected || checkedRows, error:"素材列表全选状态尚未生效。" };
    }
    const control = nativeInput.closest("label,.el-checkbox") || selectionHeaders.find((header) => header.contains(nativeInput))?.querySelector(".el-checkbox,.el-checkbox__inner") || nativeInput.parentElement || nativeInput;
    control.scrollIntoView({ block:"center", inline:"center", behavior:"instant" });
    const rect = control.getBoundingClientRect();
    control.click();
    return { ok:true, count:0, point:{ x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 } };
  }
  if (input.type === "fillCopyPanelInput") {
    const panel = copyPanel();
    let field = panel && [...panel.querySelectorAll("input,textarea")].filter(visible).find((el) => input.placeholders.some((item) => clean(el.placeholder).includes(item) || clean(el.getAttribute("aria-label")).includes(item)));
    if (!field) {
      field = [...document.querySelectorAll("input,textarea")].filter(visible).find((el) => input.placeholders.some((item) => clean(el.placeholder).includes(item) || clean(el.getAttribute("aria-label")).includes(item)));
    }
    if (!field) return { ok:false, error:`未找到创意文案面板输入框：${input.placeholders.join(" / ")}` };
    field.focus(); field.value = input.value; dispatch(field, "input"); dispatch(field, "change"); field.blur();
    return { ok:clean(field.value) === String(input.value), label:field.placeholder || field.getAttribute("aria-label") || "输入框" };
  }
  if (input.type === "focusCopyPanelInput") {
    const panel = copyPanel();
    let field = panel && [...panel.querySelectorAll("input,textarea")].filter(visible).find((el) => input.placeholders.some((item) => clean(el.placeholder).includes(item) || clean(el.getAttribute("aria-label")).includes(item)));
    if (!field) {
      field = [...document.querySelectorAll("input,textarea")].filter(visible).find((el) => input.placeholders.some((item) => clean(el.placeholder).includes(item) || clean(el.getAttribute("aria-label")).includes(item)));
    }
    if (!field) return { ok:false, error:`未找到创意文案面板输入框：${input.placeholders.join(" / ")}` };
    field.focus();
    return { ok:true };
  }
  if (input.type === "clearCopySearch") {
    let field = [...document.querySelectorAll("input")].filter(visible).find((el) => clean(el.placeholder).includes("请输入文案关键词"));
    if (!field) return { ok:false, error:"未找到文案搜索框。" };
    const wrapper = field.closest(".el-input--suffix");
    if (wrapper) {
      const clearIcon = [...wrapper.querySelectorAll("i,span")].find((node) => visible(node) && (node.classList.contains("el-icon-circle-close") || clean(node.className).includes("close")));
      if (clearIcon) { clearIcon.click(); return { ok:true }; }
    }
    field.focus(); field.value = ""; dispatch(field, "input"); dispatch(field, "change"); field.blur();
    return { ok:true };
  }
  if (input.type === "selectCopyRowsByKeyword") {
    const panel = copyPanel();
    let rows = [];
    if (panel) rows = [...panel.querySelectorAll("tbody tr")].filter((row) => visible(row) && row.querySelector("td") && row.querySelector('input[type="checkbox"]'));
    if (!rows.length) {
      rows = [...document.querySelectorAll("tbody tr")].filter((row) => visible(row) && row.querySelector("td") && row.querySelector('input[type="checkbox"]') && clean(row.innerText).includes(input.keyword));
    }
    if (!rows.length) return { ok:false, count:0, error:`文案搜索结果中未找到与「${input.keyword}」匹配的行。` };
    // 提取每行「文案」列的真实文本：跳过复选框 cell 与只读统计 cell（数字/百分比/日期/创作者），
    // 取第一个有可见文字的 cell 作为文案原文，避免用整行 innerText 排序时把统计列字数算进去。
    const extractCopyText = (row) => {
      const cells = [...row.querySelectorAll("td")];
      for (const cell of cells) {
        const text = clean(cell.innerText);
        if (!text) continue;
        if (/^[\d.,%¥\-\s]+$/.test(text)) continue;
        if (/^\d{4}-\d{2}-\d{2}/.test(text)) continue;
        if (text.length < 2) continue;
        return text;
      }
      return clean(row.innerText);
    };
    // 打分：完全相等 > 关键词+常见分隔符（#/，/空格）> 前缀 > 包含
    const scoreMatch = (copyText) => {
      if (copyText === input.keyword) return 100;
      if (copyText.startsWith(input.keyword + "#")) return 80;
      if (copyText.startsWith(input.keyword + ",")) return 75;
      if (copyText.startsWith(input.keyword + " ")) return 70;
      if (copyText.startsWith(input.keyword)) return 60;
      if (copyText.includes(input.keyword)) return 40;
      return -1;
    };
    const matches = rows
      .map((row) => ({ row, copyText: extractCopyText(row) }))
      .map((item) => ({ ...item, score: scoreMatch(item.copyText) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || a.copyText.length - b.copyText.length)
      .slice(0, input.maxCount || 1);
    if (!matches.length) return { ok:false, count:0, error:`文案搜索结果中未找到与「${input.keyword}」匹配的行。` };
    let count = 0;
    for (const { row } of matches) {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox) continue;
      if (!checkbox.checked) {
        const label = checkbox.closest("label.el-checkbox") || checkbox.parentElement;
        if (label) label.click(); else checkbox.click();
      }
      if (checkbox.checked || row.classList.contains("is-selected") || row.querySelector(".is-checked")) count++;
    }
    return { ok:count > 0, count, matched: matches.map((m) => m.copyText) };
  }
  if (input.type === "copySelectionsReady") {
    // 已选文案区域是 .select-wrapper-card，.card-header 只包含"已选：N/N 清空"标题，
    // 真正的已选文案在它下面的列表里，所以要取整个卡片（含标题 + 列表项）。
    const container = [...document.querySelectorAll(".select-wrapper-card")].find((node) => visible(node) && clean(node.innerText).includes("已选"));
    if (!container) return { ok:false, error:"未找到已选文案区域。" };
    const text = clean(container.innerText);
    const missing = input.keywords.filter((keyword) => !text.includes(keyword));
    return { ok:missing.length === 0, missing };
  }
  if (input.type === "confirmCopyPanel") {
    const enabled = (node) => !node.disabled && !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true" && !node.classList.contains("is-disabled");
    let buttons = [];
    const panel = copyPanel();
    if (panel) buttons = [...panel.querySelectorAll("button")].filter((node) => visible(node) && enabled(node) && clean(node.innerText).replace(/\s/g, "") === "确定");
    if (buttons.length !== 1) {
      const allButtons = [...document.querySelectorAll("button")].filter((node) => visible(node) && enabled(node) && clean(node.innerText).replace(/\s/g, "") === "确定");
      if (!allButtons.length) return { ok:false, error:"未找到确定按钮。" };
      buttons = [allButtons[allButtons.length - 1]];
    }
    buttons[0].click();
    return { ok:true };
  }
  if (input.type === "copyPanelClosed") {
    return { ok:!copyPanel() };
  }
  if (input.type === "panelClosed") return { ok:!titledPanel(input.title) };
  if (input.type === "searchAndSelectFirstResource") {
    const panel = titledPanel(input.title);
    if (!panel) return { ok:false, count:0, error:`未打开“${input.title}”选择页。` };
    const field = [...panel.querySelectorAll("input")].filter(visible).find((node) => /关键词|搜索/.test(clean(node.placeholder) + clean(node.getAttribute("aria-label")))) || [...panel.querySelectorAll("input")].filter(visible)[0];
    if (!field) return { ok:false, count:0, error:"选择页缺少搜索输入框。" };
    field.focus(); field.value = input.keyword; dispatch(field, "input"); dispatch(field, "change");
    const button = [...panel.querySelectorAll("button")].filter(visible).find((node) => /搜索/.test(clean(node.title) + clean(node.getAttribute("aria-label")) + clean(node.innerText))) || [...field.parentElement.querySelectorAll("button")].filter(visible)[0];
    if (button) button.click(); else { field.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", code:"Enter", bubbles:true })); field.dispatchEvent(new KeyboardEvent("keyup", { key:"Enter", code:"Enter", bubbles:true })); }
    const choices = [...panel.querySelectorAll("label.el-checkbox")].filter(visible);
    const first = choices.find((node) => !node.querySelector("input")?.checked) || choices[0];
    const nativeInput = first?.querySelector("input[type=checkbox]");
    if (!first || !nativeInput) return { ok:false, count:0, error:"品牌形象搜索结果尚未渲染。" };
    if (!nativeInput.checked) first.click();
    return { ok:Boolean(nativeInput.checked || first.classList.contains("is-checked")), count:1 };
  }
  if (input.type === "selectDropdownInSection") {
    const markers = [...document.querySelectorAll("div,span,p,label")].filter((node) => visible(node) && clean(node.innerText) === input.sectionTitle);
    const candidates = [];
    for (const marker of markers) {
      let parent = marker.parentElement;
      while (parent && parent !== document.body) {
        const field = [...parent.querySelectorAll("input")].filter(visible)[0];
        if (field) { candidates.push({ field, size:clean(parent.innerText).length }); break; }
        parent = parent.parentElement;
      }
    }
    const smallest = Math.min(...candidates.map((item) => item.size));
    const fields = candidates.filter((item) => item.size === smallest).map((item) => item.field);
    if (fields.length !== 1) return { ok:false, error:"按钮文案下拉框不唯一。" };
    fields[0].click();
    const options = [...document.querySelectorAll("li,div,span")].filter((node) => visible(node) && clean(node.innerText) === input.label && !node.querySelector("input"));
    const leaf = options.filter((node) => ![...node.children].some((child) => clean(child.innerText) === input.label));
    if (leaf.length !== 1) return { ok:false, error:`按钮文案选项“${input.label}”未出现或不唯一。` };
    leaf[0].click(); return { ok:true };
  }
  if (input.type === "clickNewAdCard") {
    const cards = [...document.querySelectorAll(".ad-config .ad-config-item")].filter((card) => visible(card) && clean(card.innerText) === "新建广告");
    if (cards.length !== 1) return { ok:false, error:cards.length ? `“新建广告”卡片不唯一：${cards.length} 个。` : "未显示“新建广告”卡片。" };
    cards[0].click(); return { ok:true };
  }
  if (input.type === "openInput" || input.type === "inputValue") {
    const scope = input.dialogTitle ? [...document.querySelectorAll(".el-dialog,[role=dialog]")].filter((dialog) => visible(dialog) && clean(dialog.innerText).includes(input.dialogTitle))[0] : document;
    const field = scope && [...scope.querySelectorAll("input")].filter((el) => visible(el) && clean(el.placeholder) === input.placeholder)[0];
    if (!field) return { ok:false, error:`未找到输入框：${input.placeholder}` };
    if (input.type === "openInput") { field.click(); return { ok:true }; }
    return { ok:clean(field.value).includes(input.value) };
  }
  if (input.type === "clickExactText") {
    const scope = input.dialogTitle ? [...document.querySelectorAll(".el-dialog,[role=dialog]")].filter((dialog) => visible(dialog) && clean(dialog.innerText).includes(input.dialogTitle))[0] : document;
    if (!scope) return { ok:false, error:`未打开“${input.dialogTitle}”弹窗。` };
    const candidates = [...scope.querySelectorAll("a,button,span,div,p,li")].filter((el) => visible(el) && clean(el.innerText) === input.label);
    const leaf = candidates.filter((el) => ![...el.children].some((child) => clean(child.innerText) === input.label));
    if (leaf.length !== 1) return { ok:false, error:leaf.length ? `“${input.label}”不唯一：${leaf.length} 个。` : `未找到“${input.label}”。` };
    leaf[0].click(); return { ok:true };
  }
  if (input.type === "selectCheckboxLabels") {
    const scope = input.dialogTitle ? [...document.querySelectorAll(".el-dialog,[role=dialog]")].filter((dialog) => visible(dialog) && clean(dialog.innerText).includes(input.dialogTitle))[0] : document;
    if (!scope) return { ok:false, count:0, error:"未打开目标弹窗。" };
    let count = 0;
    for (const labelText of input.labels) {
      const labels = [...scope.querySelectorAll("label.el-checkbox")].filter((label) => visible(label) && (input.exact ? clean(label.innerText).split("查看详情")[0].trim() === labelText : clean(label.innerText).includes(labelText)));
      if (labels.length !== 1) continue;
      const label = labels[0]; const nativeInput = label.querySelector("input[type=checkbox]");
      if (!nativeInput) continue;
      // Element UI 的 label 点击在此抽屉内可能只触发外层事件，原生 input 状态不变；
      // 直接点击真实 checkbox，随后以原生 checked 和组件 is-checked 双重确认。
      if (!nativeInput.checked) nativeInput.click();
      if (nativeInput.checked || label.classList.contains("is-checked")) count++;
    }
    return { ok:count === input.labels.length, count };
  }
  if (input.type === "goToLastProductPage") {
    const dialog = [...document.querySelectorAll(".el-dialog,[role=dialog]")].filter((node) => visible(node) && clean(node.innerText).includes("选择推广产品"))[0];
    if (!dialog) return { ok:false, error:"未打开选择推广产品弹窗。" };
    const pages = [...dialog.querySelectorAll("li")].filter(visible).map((node) => ({ node, value:Number(clean(node.innerText)) })).filter((item) => Number.isInteger(item.value));
    if (!pages.length) return { ok:false, error:"未找到产品分页控件。" };
    const last = pages.reduce((current, item) => item.value > current.value ? item : current);
    last.node.click();
    return { ok:true, page:last.value };
  }
  if (input.type === "productPageReady") {
    const dialog = [...document.querySelectorAll(".el-dialog,[role=dialog]")].filter((node) => visible(node) && clean(node.innerText).includes("选择推广产品"))[0];
    if (!dialog) return { ok:false };
    const pageInput = [...dialog.querySelectorAll("input")].find((node) => visible(node) && (node.type === "number" || node.getAttribute("role") === "spinbutton"));
    const currentPage = Number(pageInput?.value);
    const products = [...dialog.querySelectorAll("label.el-checkbox")].filter(visible);
    return { ok:currentPage === input.page && products.length > 0, currentPage, rowCount:products.length };
  }
  if (input.type === "selectProductFromEnd") {
    const dialog = [...document.querySelectorAll(".el-dialog,[role=dialog]")].filter((node) => visible(node) && clean(node.innerText).includes("选择推广产品"))[0];
    if (!dialog) return { ok:false, count:0, error:"未打开选择推广产品弹窗。" };
    const products = [...dialog.querySelectorAll("label.el-checkbox")].filter(visible).reverse();
    const control = products.find((label) => clean(label.innerText).replace(/\s*查看详情\s*$/, "") === input.keyword);
    if (!control) return { ok:false, count:0, error:"最后一页没有精确匹配的产品。" };
    const nativeInput = control.querySelector("input[type=checkbox]");
    if (!nativeInput) return { ok:false, count:0, error:"产品行缺少复选框。" };
    if (!nativeInput.checked) control.click();
    return { ok:Boolean(nativeInput.checked || control.classList.contains("is-checked")), count:1 };
  }
  if (input.type === "confirmUnifiedProductRule") {
    // 前置提示可能是 el-message-box 或 el-dialog；按 z-index 与容器大小取最上层最内层弹窗。
    const candidates = [...document.querySelectorAll(".el-message-box,.el-dialog,[role=dialog]")]
      .filter((node) => visible(node) && /全部相同分配规则|业务单元/.test(clean(node.innerText)))
      .map((node) => ({ node, z:Number.parseInt(getComputedStyle(node).zIndex, 10) || 0, size:clean(node.innerText).length }))
      .sort((a, b) => (b.z - a.z) || (a.size - b.size));
    if (candidates.length === 0) return { ok:false, error:"未找到业务单元提示弹窗。" };
    const box = candidates[0].node;
    const enabled = (node) => !node.disabled && !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true" && !node.classList.contains("is-disabled");
    let buttons = [...box.querySelectorAll("button,[role=button]")]
      .filter((node) => visible(node) && enabled(node) && node.classList.contains("el-button--primary") && clean(node.innerText).replace(/\s/g, "") === "确定");
    if (buttons.length === 0) {
      buttons = [...box.querySelectorAll("button,[role=button]")]
        .filter((node) => visible(node) && enabled(node) && clean(node.innerText).replace(/\s/g, "") === "确定");
    }
    if (buttons.length === 0) return { ok:false, error:"业务单元提示弹窗未找到可用的确认按钮。" };
    if (buttons.length > 1) return { ok:false, error:`业务单元提示弹窗确认按钮不唯一：${buttons.length} 个。` };
    buttons[0].click();
    return { ok:true };
  }
  if (input.type === "selectPlacementRadio") {
    const controls = [...document.querySelectorAll("label.el-radio-button")].filter((label) => visible(label) && clean(label.innerText) === input.label);
    if (controls.length !== 1) return { ok:false, error:controls.length ? `“${input.label}”单选控件不唯一。` : `未找到“${input.label}”单选控件。` };
    const nativeInput = controls[0].querySelector("input[type=radio]");
    if (!nativeInput) return { ok:false, error:`“${input.label}”缺少单选输入控件。` };
    if (!nativeInput.checked) controls[0].click();
    return { ok:nativeInput.checked };
  }
  if (input.type === "selectRadioLabel") {
    const scope = input.dialogTitle ? [...document.querySelectorAll(".el-dialog,[role=dialog]")].filter((dialog) => visible(dialog) && clean(dialog.innerText).includes(input.dialogTitle))[0] : document;
    if (!scope) return { ok:false, error:"未打开目标弹窗。" };
    const controls = [...scope.querySelectorAll("label.el-radio,label.el-radio-button")].filter((label) => visible(label) && clean(label.innerText) === input.label);
    if (controls.length !== 1) return { ok:false, error:controls.length ? `“${input.label}”单选控件不唯一。` : `未找到“${input.label}”单选控件。` };
    const nativeInput = controls[0].querySelector("input[type=radio]");
    if (!nativeInput) return { ok:false, error:`“${input.label}”缺少单选输入控件。` };
    if (!nativeInput.checked) controls[0].click();
    return { ok:nativeInput.checked };
  }
  if (input.type === "selectRadioInSection") {
    const matches = [];
    for (const control of [...document.querySelectorAll("label.el-radio,label.el-radio-button")]) {
      if (!visible(control) || clean(control.innerText) !== input.label) continue;
      let parent = control.parentElement;
      while (parent && parent !== document.body) {
        if (visible(parent) && clean(parent.innerText).includes(input.sectionTitle)) { matches.push({ control, size:clean(parent.innerText).length }); break; }
        parent = parent.parentElement;
      }
    }
    const smallest = Math.min(...matches.map((item) => item.size));
    const closest = matches.filter((item) => item.size === smallest);
    if (closest.length !== 1) return { ok:false, error:matches.length ? `“${input.sectionTitle}”内的“${input.label}”不唯一。` : `未找到“${input.sectionTitle}”内的“${input.label}”。` };
    const nativeInput = closest[0].control.querySelector("input[type=radio]");
    if (!nativeInput) return { ok:false, error:"一键起量选项缺少单选输入控件。" };
    if (!nativeInput.checked) closest[0].control.click();
    return { ok:nativeInput.checked };
  }
  if (input.type === "fillInputInSection") {
    const options = [];
    for (const marker of [...document.querySelectorAll("div,span,p,label")]) {
      if (!visible(marker) || clean(marker.innerText) !== input.sectionTitle) continue;
      let parent = marker.parentElement;
      while (parent && parent !== document.body) {
        const field = [...parent.querySelectorAll("input:not([type=radio]):not([type=checkbox]),textarea")].find(visible);
        if (field && clean(parent.innerText).includes(input.sectionTitle)) { options.push({ field, size:clean(parent.innerText).length }); break; }
        parent = parent.parentElement;
      }
    }
    const smallest = Math.min(...options.map((item) => item.size));
    const closest = options.filter((item) => item.size === smallest);
    if (closest.length !== 1) return { ok:false, error:options.length ? `“${input.sectionTitle}”的输入框不唯一。` : `未找到“${input.sectionTitle}”的输入框。` };
    const field = closest[0].field;
    field.focus(); field.value = input.value; dispatch(field, "input"); dispatch(field, "change"); field.blur();
    return { ok:clean(field.value) === String(input.value) };
  }
  if (input.type === "prependAdNameWithPlacements") {
    const selected = (label) => [...document.querySelectorAll("label.el-checkbox")].some((node) => visible(node) && clean(node.innerText).includes(label) && (node.querySelector("input")?.checked || node.classList.contains("is-checked")));
    const parts = [];
    if (selected("微信公众号与小程序")) parts.push("公众号");
    if (selected("腾讯平台与内容媒体")) parts.push("平台");
    if (selected("腾讯营销联盟")) parts.push("联盟");
    if (parts.length === 0) return { ok:false, error:"未识别到已选广告版位。" };
    const smart = [...document.querySelectorAll("label.el-radio,label.el-radio-button")].some((node) => visible(node) && clean(node.innerText) === "智能版位" && node.querySelector("input")?.checked);
    const prefix = `${smart ? "智版" : "手版"}-${parts.join("+")}`;
    const field = [...document.querySelectorAll("input,textarea")].find((node) => visible(node) && clean(node.placeholder) === "请输入广告名称");
    if (!field) return { ok:false, error:"未找到广告名称输入框。" };
    if (!clean(field.value).startsWith(prefix)) {
      field.focus(); field.value = `${prefix}${field.value || ""}`; dispatch(field, "input"); dispatch(field, "change"); field.blur();
    }
    return { ok:clean(field.value).startsWith(prefix), prefix };
  }
  if (input.type === "clickExactVisibleButton") {
    const buttons = [...document.querySelectorAll("button:not([disabled])")].filter((button) => visible(button) && clean(button.innerText).replace(/\s/g, "") === input.label);
    if (buttons.length !== 1) return { ok:false, error:buttons.length ? `“${input.label}”按钮不唯一。` : `未找到“${input.label}”按钮。` };
    buttons[0].click(); return { ok:true };
  }
  if (input.type === "clickTargetingTemplateAdd") {
    const cells = [...document.querySelectorAll("td")].filter((cell) => visible(cell) && clean(cell.innerText).startsWith("定向模板"));
    if (cells.length !== 1) return { ok:false, error:"定向模板区域不唯一。" };
    const buttons = [...cells[0].querySelectorAll("button:not([disabled])")].filter((button) => visible(button) && clean(button.innerText).includes("添加"));
    if (buttons.length !== 1) return { ok:false, error:"定向模板添加按钮不可用。" };
    buttons[0].click(); return { ok:true };
  }
  if (input.type === "clickCreativeInfoEdit") {
    const cells = [...document.querySelectorAll("td")].filter((cell) => visible(cell) && clean(cell.innerText).startsWith("创意信息"));
    if (cells.length !== 1) return { ok:false, error:"创意信息区域不唯一。" };
    const buttons = [...cells[0].querySelectorAll("button:not([disabled])")].filter((button) => visible(button) && clean(button.innerText).includes("编辑"));
    if (buttons.length !== 1) return { ok:false, error:"创意信息编辑按钮不可用。" };
    buttons[0].click(); return { ok:true };
  }
  if (input.type === "creativeInfoReady") {
    const pageText = clean(document.body.innerText);
    return { ok:pageText.includes("创意内容") && !pageText.includes("获取创意信息中") };
  }
  if (input.type === "clearCheckboxLabels") {
    const stillSelected = [];
    const notRendered = [];
    for (const labelText of input.labels) {
      const controls = [...document.querySelectorAll("label.el-checkbox")].filter((label) => visible(label) && clean(label.innerText).includes(labelText));
      // 智能版位会按策略隐藏不可投放卡片；隐藏即不可能被选中，视为已排除。
      if (controls.length === 0) { notRendered.push(labelText); continue; }
      if (controls.length !== 1) { stillSelected.push(labelText); continue; }
      const nativeInput = controls[0].querySelector("input[type=checkbox]");
      if (!nativeInput) { stillSelected.push(labelText); continue; }
      if (nativeInput.checked) controls[0].click();
      if (nativeInput.checked) stillSelected.push(labelText);
    }
    return { ok:stillSelected.length === 0, missing:stillSelected, notRendered };
  }
  if (input.type === "pressEnter") { const el = findInput(input.placeholders); if (!el) return { ok:false }; el.focus(); el.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", code:"Enter", bubbles:true })); el.dispatchEvent(new KeyboardEvent("keyup", { key:"Enter", code:"Enter", bubbles:true })); return { ok:true }; }
  if (input.type === "selectAccountRows" || input.type === "selectRowsByText") {
    const values = input.accountIds || input.values; let count = 0;
    for (const value of values) {
      const row = [...document.querySelectorAll("tr,[role=row],.el-table__row")].filter(visible).find((el) => clean(el.innerText).includes(value));
      if (!row) continue;
      const label = row.querySelector("label.el-checkbox");
      const nativeInput = label?.querySelector("input[type=checkbox]");
      if (!label || !nativeInput) continue;
      if (!nativeInput.checked) label.click();
      if (nativeInput.checked || label.classList.contains("is-checked")) count++;
    }
    return { ok:count === values.length, count };
  }
  if (input.type === "checkLabels") {
    const selected = (node) => {
      const input = node.matches("input") ? node : node.querySelector("input");
      return Boolean(input?.checked || node.getAttribute("aria-checked") === "true" || node.classList.contains("is-checked") || node.closest(".is-checked,[aria-checked=true]") || node.querySelector(".is-checked,[aria-checked=true]"));
    };
    const nodes = [...document.querySelectorAll("label,.el-checkbox,[role=checkbox]")].filter(visible);
    return { ok:input.labels.every((label) => nodes.some((node) => clean(node.innerText || node.textContent).includes(label) && selected(node))) };
  }
  if (input.type === "clickAllocationRule") {
    const drawer = findConversionPanel();
    if (!drawer) return { ok:false, error:"未找到选择转化抽屉。" };
    const sections = [...drawer.querySelectorAll(".el-form-item")].filter((item) => visible(item) && clean(item.innerText).includes("转化分配规则"));
    if (sections.length === 0) return { ok:false, error:"未找到转化分配规则区域。" };
    const radioButtons = [...sections[0].querySelectorAll("label.el-radio-button")].filter((btn) => visible(btn) && clean(btn.innerText).includes(input.rule));
    if (radioButtons.length === 0) return { ok:false, error:`未找到"${input.rule}"选项。` };
    const nativeInput = radioButtons[0].querySelector("input[type=radio]");
    if (!nativeInput) return { ok:false, error:`"${input.rule}"缺少单选输入控件。` };
    if (!nativeInput.checked) radioButtons[0].click();
    return { ok:nativeInput.checked };
  }
  if (input.type === "conversionReady") {
    const dialog = findConversionPanel() || document;
    const goalInputs = [...dialog.querySelectorAll("input")].filter(visible).filter((node) => clean(node.placeholder).includes("优化目标"));
    const goalSelected = goalInputs.some((node) => clean(node.value).includes(input.goal)) || clean(dialog.innerText).includes(input.goal);
    const selectedRule = [...dialog.querySelectorAll("label.el-checkbox")].some((node) => visible(node) && clean(node.innerText).includes(input.conversion) && (node.querySelector("input")?.checked || node.classList.contains("is-checked")));
    const apiSelected = [...dialog.querySelectorAll("label.el-radio,label.el-radio-button,button")].some((node) => visible(node) && clean(node.innerText) === "API上报" && (node.querySelector("input")?.checked || node.classList.contains("is-active") || node.classList.contains("is-checked")));
    const clickSelected = [...dialog.querySelectorAll("label.el-radio,label.el-radio-button,button")].some((node) => visible(node) && clean(node.innerText) === "点击归因" && (node.querySelector("input")?.checked || node.classList.contains("is-active") || node.classList.contains("is-checked")));
    let allocationOk = true;
    if (input.allocationRule) {
      const ruleSections = [...dialog.querySelectorAll(".el-form-item")].filter((item) => visible(item) && clean(item.innerText).includes("转化分配规则"));
      if (ruleSections.length > 0) {
        allocationOk = [...ruleSections[0].querySelectorAll("label.el-radio-button")].some((btn) => visible(btn) && clean(btn.innerText).includes(input.allocationRule) && (btn.querySelector("input")?.checked || btn.classList.contains("is-active")));
      } else {
        allocationOk = false;
      }
    }
    return { ok:goalSelected && selectedRule && apiSelected && clickSelected && allocationOk, goalSelected, selectedRule, apiSelected, clickSelected, allocationOk };
  }
  return { ok:false };
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "STOP") { cancelled = true; sendDingTalkNotification(activeDingTalkWebhook, "广点通自动化已停止", "操作人已停止任务，页面保持在当前状态。").finally(() => detach().finally(() => respond({ ok:true }))); return true; }
  if (message.type !== "RUN_TO_PREVIEW") return;
  (async () => {
    cancelled = false;
    try { const tab = await inspectTarget(); await runWorkflow(tab, message.job); respond({ ok:true }); }
    catch (error) { await notify(`已暂停：${error.message}`, "error"); await status("error", "执行已暂停", error.message); await sendDingTalkNotification(activeDingTalkWebhook, "广点通自动化异常暂停", error.message); respond({ ok:false, error:error.message }); }
    finally { await detach(); finish(); activeDingTalkWebhook = ""; }
  })();
  return true;
});
