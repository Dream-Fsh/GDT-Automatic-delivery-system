const $ = (id) => document.getElementById(id);
const fieldIds = ["accountIds","projectName","productKeyword","brandKeyword","targetingTemplate","accountCount","dingTalkWebhook","materialFolder","materialDateStart","materialDateEnd","copyOne","copyTwo","landingPages","bidMin","bidMax","budget"];
let isRunning = false;

const materialMetricNames = new Set(["花费", "点击次数", "目标转化量", "目标转化率", "目标转化成本", "累计关联广告数", "有消耗广告数", "累计关联创意数"]);
const materialMetricOptions = [...materialMetricNames];
const materialOperatorOptions = [{ value:">=", label:"大于等于" }, { value:"<=", label:"小于等于" }, { value:">", label:"大于" }, { value:"<", label:"小于" }, { value:"=", label:"等于" }];
let materialConditionRows = [{ label:"花费", operator:">=", value:"1" }];
function parseMaterialConditions(value) {
  if (Array.isArray(value)) return { conditions:value.map((item) => ({ label:item.label, operator:item.operator || ">=", value:Number(item.value) })), errors:[] };
  const errors = [], conditions = [];
  for (const [index, line] of value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).entries()) {
    const match = line.match(/^(.+?)\s*(>=|≤|<=|>|<|=|≥)\s*(\d+(?:\.\d+)?)$/);
    if (!match) { errors.push(`素材条件第 ${index + 1} 行格式不正确，应为“指标 >= 数值”。`); continue; }
    const label = match[1].trim(), operator = match[2] === "≥" ? ">=" : match[2] === "≤" ? "<=" : match[2], value = Number(match[3]);
    if (!materialMetricNames.has(label)) errors.push(`素材条件“${label}”不是可选指标。`);
    else conditions.push({ label, operator, value });
  }
  if (!conditions.length && !errors.length) errors.push("请至少填写一条素材筛选条件。");
  return { conditions, errors };
}
function renderMaterialConditions() {
  const editor = $("materialConditionsEditor");
  editor.replaceChildren(...materialConditionRows.map((row, index) => {
    const line = document.createElement("div"); line.className = "material-condition-row";
    const metric = document.createElement("select"); metric.className = "condition-metric"; metric.setAttribute("aria-label", `第 ${index + 1} 条素材指标`);
    metric.innerHTML = materialMetricOptions.map((item) => `<option value="${item}">${item}</option>`).join(""); metric.value = row.label;
    const operator = document.createElement("select"); operator.className = "condition-operator"; operator.setAttribute("aria-label", `第 ${index + 1} 条比较符`);
    operator.innerHTML = materialOperatorOptions.map((item) => `<option value="${item.value}">${item.label}</option>`).join(""); operator.value = row.operator || ">=";
    const value = document.createElement("input"); value.className = "condition-value"; value.type = "number"; value.min = "0"; value.step = "0.01"; value.placeholder = "请输入"; value.value = row.value ?? ""; value.setAttribute("aria-label", `第 ${index + 1} 条素材阈值`);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "condition-remove"; remove.dataset.index = index; remove.setAttribute("aria-label", `删除第 ${index + 1} 条条件`); remove.textContent = "×";
    line.append(metric, operator, value, remove); return line;
  }));
}
function readMaterialConditionRows() {
  const errors = [], conditions = [];
  [...$("materialConditionsEditor").querySelectorAll(".material-condition-row")].forEach((row, index) => {
    const label = row.querySelector(".condition-metric")?.value, operator = row.querySelector(".condition-operator")?.value, rawValue = row.querySelector(".condition-value")?.value.trim();
    const value = Number(rawValue);
    if (!materialMetricNames.has(label)) errors.push(`素材条件第 ${index + 1} 行指标无效。`);
    if (!Number.isFinite(value) || value < 0) errors.push(`素材条件第 ${index + 1} 行请输入不小于 0 的数值。`);
    else conditions.push({ label, operator, value });
  });
  if (!conditions.length && !errors.length) errors.push("请至少添加一条素材筛选条件。");
  return { conditions, errors };
}

function readJob() {
  const raw = Object.fromEntries(fieldIds.map((id) => [id, $(id).value.trim()]));
  const accountIds = raw.accountIds.split(/\s+/).filter(Boolean);
  const landingPages = raw.landingPages.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [accountId, ...name] = line.split("|");
    return { accountId: accountId?.trim(), name: name.join("|").trim() };
  });
  const materialConditionResult = readMaterialConditionRows();
  return { ...raw, accountIds, landingPages, materialConditions: materialConditionResult.conditions, materialConditionErrors: materialConditionResult.errors, bidMin: Number(raw.bidMin), bidMax: Number(raw.bidMax), budget: Number(raw.budget) };
}

function validate(job) {
  const errors = [];
  if (!job.accountIds.length || job.accountIds.some((id) => !/^\d+$/.test(id))) errors.push("账户 ID 必须为每行一个纯数字。");
  if (new Set(job.accountIds).size !== job.accountIds.length) errors.push("账户 ID 存在重复项。");
  if (job.accountCount && Number(job.accountCount) !== job.accountIds.length) errors.push("账户数量与账户 ID 数量不一致。");
  if (job.bidMin > job.bidMax) errors.push("最低出价不能高于最高出价。");
  errors.push(...job.materialConditionErrors);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(job.materialDateStart) || !/^\d{4}-\d{2}-\d{2}$/.test(job.materialDateEnd)) errors.push("请完整选择素材数据时间区间。");
  else if (job.materialDateStart > job.materialDateEnd) errors.push("素材数据开始日期不能晚于结束日期。");
  if (!job.copyOne || !job.copyTwo || job.copyOne === job.copyTwo) errors.push("请填写两条不同的创意文案。");
  const mapped = new Map(job.landingPages.map((item) => [item.accountId, item.name]));
  for (const id of job.accountIds) if (!mapped.get(id)) errors.push(`账户 ${id} 缺少落地页映射。`);
  if (job.landingPages.some((item) => !job.accountIds.includes(item.accountId) || !item.name)) errors.push("落地页映射格式应为“账户ID | 落地页名称”，且账户必须在本次任务中。");
  return errors;
}

function setStatus(kind, label) { const node = $("status"); node.className = `status ${kind}`; node.textContent = label; }
function addLog(message, kind = "ok") {
  const item = document.createElement("li"); const time = document.createElement("time"); const text = document.createElement("span");
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12:false }); text.textContent = message; text.className = kind;
  item.append(time, text); $("logs").prepend(item);
}
function showValidation(job) {
  const errors = validate(job);
  if (errors.length) { setStatus("error", "配置需修正"); $("summary").textContent = errors.join("；"); errors.forEach((error) => addLog(error, "error")); return false; }
  setStatus("done", "配置通过"); $("summary").textContent = `已生成任务：${job.accountIds.length} 个账户，随机出价 ${job.bidMin}–${job.bidMax}，预算 ${job.budget}。`;
  addLog("配置校验通过：账户、出价、文案和落地页映射完整。"); return true;
}
async function saveDraft(silent = false) {
  const job = readJob(); await chrome.storage.local.set({ gdtDraft: job });
  if (!silent) { addLog("本地草稿已保存。不会上传到外部服务。"); setStatus("done", "草稿已保存"); }
}
function ensureMaterialDateRange() {
  const end = new Date(); const start = new Date(end); start.setDate(end.getDate() - 6);
  const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  if (!$("materialDateStart").value) $("materialDateStart").value = format(start);
  if (!$("materialDateEnd").value) $("materialDateEnd").value = format(end);
}

const materialDateState = { cursor: new Date(), draftStart: "", draftEnd: "" };
const toDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const fromDateKey = (value) => new Date(`${value}T00:00:00`);
function updateMaterialDateText() {
  const start = $("materialDateStart").value, end = $("materialDateEnd").value;
  $("materialDateText").textContent = start && end ? `${start.replaceAll("-", "/")}  至  ${end.replaceAll("-", "/")}` : "请选择数据时间";
}
function renderCalendar(month) {
  const year = month.getFullYear(), monthIndex = month.getMonth();
  const firstDay = new Date(year, monthIndex, 1).getDay();
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const title = `${year} 年 ${monthIndex + 1} 月`;
  const cells = Array.from({ length: firstDay }, () => '<span class="calendar-day empty"></span>');
  for (let day = 1; day <= lastDay; day++) {
    const key = toDateKey(new Date(year, monthIndex, day));
    const start = materialDateState.draftStart, end = materialDateState.draftEnd;
    const selected = key === start || key === end;
    const between = start && end && key > start && key < end;
    cells.push(`<button type="button" class="calendar-day${selected ? " selected" : ""}${between ? " between" : ""}" data-date="${key}">${day}</button>`);
  }
  return `<section class="calendar-month"><div class="calendar-title">${title}</div><div class="calendar-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div class="calendar-grid">${cells.join("")}</div></section>`;
}
function renderMaterialCalendars() {
  const first = new Date(materialDateState.cursor.getFullYear(), materialDateState.cursor.getMonth(), 1);
  const next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
  $("materialDateCalendars").innerHTML = `<button type="button" class="calendar-nav previous" aria-label="上月">‹</button>${renderCalendar(first)}${renderCalendar(next)}<button type="button" class="calendar-nav next" aria-label="下月">›</button>`;
}
function openMaterialDatePicker() {
  materialDateState.draftStart = $("materialDateStart").value;
  materialDateState.draftEnd = $("materialDateEnd").value;
  materialDateState.cursor = materialDateState.draftStart ? fromDateKey(materialDateState.draftStart) : new Date();
  $("materialDatePicker").hidden = false; $("materialDateTrigger").setAttribute("aria-expanded", "true"); renderMaterialCalendars();
}
function closeMaterialDatePicker() { $("materialDatePicker").hidden = true; $("materialDateTrigger").setAttribute("aria-expanded", "false"); }
function chooseMaterialDate(value) {
  if (!materialDateState.draftStart || materialDateState.draftEnd) { materialDateState.draftStart = value; materialDateState.draftEnd = ""; }
  else if (value < materialDateState.draftStart) { materialDateState.draftEnd = materialDateState.draftStart; materialDateState.draftStart = value; }
  else materialDateState.draftEnd = value;
  renderMaterialCalendars();
}
function initMaterialDatePicker() {
  $("materialDateTrigger").addEventListener("click", openMaterialDatePicker);
  $("materialDateClose").addEventListener("click", closeMaterialDatePicker);
  $("materialDateCalendars").addEventListener("click", (event) => {
    const date = event.target.dataset.date;
    if (date) chooseMaterialDate(date);
    if (event.target.classList.contains("previous")) { materialDateState.cursor.setMonth(materialDateState.cursor.getMonth() - 1); renderMaterialCalendars(); }
    if (event.target.classList.contains("next")) { materialDateState.cursor.setMonth(materialDateState.cursor.getMonth() + 1); renderMaterialCalendars(); }
  });
  document.querySelectorAll("[data-days]").forEach((button) => button.addEventListener("click", () => {
    const end = new Date(); end.setDate(end.getDate() + Number(button.dataset.offset || 0)); const start = new Date(end); start.setDate(end.getDate() - Number(button.dataset.days));
    materialDateState.draftStart = toDateKey(start); materialDateState.draftEnd = toDateKey(end); materialDateState.cursor = new Date(start.getFullYear(), start.getMonth(), 1); renderMaterialCalendars();
  }));
  $("materialDateClear").addEventListener("click", () => { materialDateState.draftStart = ""; materialDateState.draftEnd = ""; renderMaterialCalendars(); });
  $("materialDateApply").addEventListener("click", () => {
    if (!materialDateState.draftStart || !materialDateState.draftEnd) { addLog("请选择完整的素材数据时间区间。", "error"); return; }
    $("materialDateStart").value = materialDateState.draftStart; $("materialDateEnd").value = materialDateState.draftEnd; updateMaterialDateText(); closeMaterialDatePicker();
  });
}
async function hydrate() {
  const { gdtDraft } = await chrome.storage.local.get("gdtDraft");
  if (gdtDraft) {
    for (const id of fieldIds) if (gdtDraft[id] !== undefined) $(id).value = id === "landingPages" ? gdtDraft.landingPages.map((x) => `${x.accountId} | ${x.name}`).join("\n") : String(gdtDraft[id] ?? "");
    if (gdtDraft.materialConditions !== undefined) materialConditionRows = parseMaterialConditions(gdtDraft.materialConditions).conditions;
    addLog("已恢复本地草稿。");
  }
  renderMaterialConditions(); ensureMaterialDateRange();
  updateMaterialDateText();
}

if (!globalThis.chrome?.runtime?.id) {
  setStatus("error", "未连接扩展");
  $("summary").textContent = "当前是直接打开的本地文件，无法连接浏览器。请通过 Chrome 扩展图标打开控制台。";
  ["saveDraft", "checkConfig", "runWorkflow", "stopWorkflow"].forEach((id) => { $(id).disabled = true; });
} else {
$("saveDraft").addEventListener("click", () => saveDraft());
$("checkConfig").addEventListener("click", () => showValidation(readJob()));
$("stopWorkflow").addEventListener("click", async () => { isRunning = false; await chrome.runtime.sendMessage({ type:"STOP" }); $("stopWorkflow").disabled = true; setStatus("error", "已停止"); addLog("操作人已停止任务；页面保持在当前状态。", "error"); });
$("jobForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const job = readJob(); if (!showValidation(job)) return;
  await saveDraft(true); isRunning = true; $("runWorkflow").disabled = true; $("stopWorkflow").disabled = false; $("logs").replaceChildren(); setStatus("running", "正在连接");
  try {
    const result = await chrome.runtime.sendMessage({ type:"RUN_TO_PREVIEW", job });
    if (!result?.ok) throw new Error(result?.error || "无法启动浏览器任务。");
    addLog("已连接当前标签页，执行器正在逐项等待可见状态确认。");
  } catch (error) { setStatus("error", "连接失败"); addLog(error.message, "error"); isRunning = false; $("runWorkflow").disabled = false; $("stopWorkflow").disabled = true; }
});
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "LOG") addLog(message.message, message.level || "ok");
  if (message.type === "STATUS") { setStatus(message.kind, message.label); $("summary").textContent = message.summary || $("summary").textContent; }
  if (message.type === "FINISHED") { isRunning = false; $("runWorkflow").disabled = false; $("stopWorkflow").disabled = true; }
});
$("addMaterialCondition").addEventListener("click", () => { materialConditionRows.push({ label:"花费", operator:">=", value:"" }); renderMaterialConditions(); });
$("materialConditionsEditor").addEventListener("change", (event) => { const row = event.target.closest(".material-condition-row"); if (!row) return; const index = [...$("materialConditionsEditor").children].indexOf(row); if (event.target.matches(".condition-metric,.condition-operator,.condition-value")) materialConditionRows[index] = { label:row.querySelector(".condition-metric").value, operator:row.querySelector(".condition-operator").value, value:row.querySelector(".condition-value").value }; });
$("materialConditionsEditor").addEventListener("click", (event) => { const remove = event.target.closest(".condition-remove"); if (!remove || materialConditionRows.length === 1) return; materialConditionRows.splice(Number(remove.dataset.index), 1); renderMaterialConditions(); });
renderMaterialConditions(); initMaterialDatePicker();
hydrate();
}
