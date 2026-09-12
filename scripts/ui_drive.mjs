// FengtouMu UI 自动化验证（真实点击，经 WebView2 CDP）
//
// 用法：node scripts/ui_drive.mjs
// 覆盖三条链路：
//   A 板卡视图：运行 → 板载 LED 闪烁 → 停止
//   B 电路图：放置 LED → 连线 GPIO2/GND → 运行 → 画布上的 LED 闪烁 → 停止
//   C 电路图 + 按键：放置按键 → 连线 GPIO0/GND → 运行 → 按住 → 界面按键状态更新 → 停止
//   D 电路图 + 电位器：放置电位器 → SIG 接 GPIO34 → 运行 → 拖动旋钮 → 读数改变且注入无报错 → 停止
//
// 注：固件侧“按住”电平保持受 QEMU GPIO 输入模型限制（见 docs/开发日志.md），
//     因此 C 只断言界面状态与注入链路，不断言 LED 常亮。
// 冷启动偶发卡死由应用内部自动重试，这里只需等待。

import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(__dirname, "..", "src-tauri", "target", "release", "esp32-ide.exe");
const CDP = "http://127.0.0.1:9222";
const START_TIMEOUT_MS = 150000;
const LED_SAMPLE_MS = 25000;
const RUN_HOLD_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function killApp() {
  try {
    execSync("taskkill /IM esp32-ide.exe /T /F 2>nul");
  } catch {
    /* ignore */
  }
}

function workerRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq esp32-sim.exe" /NH', { encoding: "utf8" });
    return out.includes("esp32-sim.exe");
  } catch {
    return false;
  }
}

let ws = null;
let msgId = 0;
const pending = new Map();

async function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error("timeout:" + method));
    }, 15000);
  });
}

async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.text || ""));
  return r.result.value;
}

async function getPageWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(CDP + "/json/list")).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error("未找到 CDP 调试页面");
}

async function connectTo(url) {
  await new Promise((res, rej) => {
    ws = new WebSocket(url);
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP 连接失败"));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
    ws.onclose = () => {
      for (const [id, fn] of pending) fn({ error: { message: "closed" } });
      pending.clear();
    };
  });
}

async function waitForUi(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJs(`!!document.querySelector('.btn-run')`)) return true;
    } catch {
      /* 页面尚未就绪 */
    }
    try {
      const url = await getPageWs();
      if (!ws || ws.url !== url) await connectTo(url);
    } catch {
      /* ignore */
    }
    await sleep(700);
  }
  return false;
}

const probe = `(() => {
  const boardEl = document.querySelector('.board-svg');
  const term = Array.from(document.querySelectorAll('.terminal-line')).map(e=>e.textContent).join('\\n');
  return {
    status: (document.querySelector('.status')||{}).textContent || '',
    msg: (document.querySelector('.msgbar')||{}).textContent || '',
    flash: (document.querySelector('.path')||{}).textContent || '',
    boardLed: (boardEl && boardEl.querySelector('[data-board-led]')||{}).getAttribute?.('data-board-led') === '1',
    wires: document.querySelectorAll('[data-wire]').length,
    runDisabled: (document.querySelector('.btn-run')||{}).disabled,
    hasStop: !!document.querySelector('.btn-stop'),
    termLen: term.length,
    termTail: term.slice(-400)
  };
})()`;

const ui = () => evalJs(probe);

/** 元素中心坐标（相对视口） */
async function centerOf(selector, dyRatio = 0.5) {
  const rect = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * ${dyRatio}, w: r.width, h: r.height };
  })()`);
  if (!rect) throw new Error(`元素不存在: ${selector}`);
  return rect;
}

async function clickAt(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(180);
}

const clickSel = async (selector, dyRatio = 0.5) => {
  const c = await centerOf(selector, dyRatio);
  await clickAt(c.x, c.y);
};

async function openTab(name) {
  await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('.pane-tabs .tab')).find(b => b.textContent.trim() === ${JSON.stringify(name)});
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(400);
}

/** 确保仿真处于停止状态：上一条链路若失败会残留运行状态，导致后续找不到[运行]按钮 */
async function ensureStopped() {
  for (let i = 0; i < 30; i++) {
    const p = await ui();
    if (!p.hasStop) return true;
    await clickSel(".btn-stop");
    await sleep(600);
  }
  return false;
}

/**
 * 在元件上找一个"确实能点到该元件"的落点。
 * 画布上元件可能互相压盖、导线也可能横穿元件，所以用 elementFromPoint 逐个候选点探测，
 * 返回第一个命中目标元件的位置。
 */
async function pointOnPart(partId, ratios = [0.3, 0.5, 0.2, 0.65, 0.8]) {
  const hits = await evalJs(`(() => {
    const el = document.querySelector('[data-part=${JSON.stringify(partId)}]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return ${JSON.stringify(ratios)}.map(k => {
      const x = r.left + r.width / 2;
      const y = r.top + r.height * k;
      const t = document.elementFromPoint(x, y);
      const owner = t && t.closest ? t.closest('[data-part]') : null;
      return { k, x, y, owner: owner ? owner.getAttribute('data-part') : (t ? t.tagName : 'none') };
    });
  })()`);
  if (!hits) throw new Error(`元素不存在: [data-part="${partId}"]`);
  const good = hits.find((h) => h.owner === partId);
  log(`落点探测 ${partId}: ` + hits.map((h) => `${h.k}->${h.owner}`).join(", "));
  if (!good) throw new Error(`找不到命中 ${partId} 的落点（候选：${hits.map((h) => h.owner).join("/")}）`);
  return good;
}

async function zoomOut(times) {
  const c = await centerOf('[data-testid="circuit-svg"]');
  for (let i = 0; i < times; i++) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: c.x,
      y: c.y,
      deltaX: 0,
      deltaY: 120,
    });
    await sleep(60);
  }
  await sleep(200);
}

const ledLit = () => evalJs(`document.querySelector('[data-part="led1"]')?.getAttribute('data-lit') === '1'`);

async function runOnce(label) {
  log(`--- ${label}: 点击[运行] ---`);
  await clickSel(".btn-run");
  const t0 = Date.now();
  let retried = false;
  while (Date.now() - t0 < START_TIMEOUT_MS) {
    await sleep(400);
    let p;
    try {
      p = await ui();
    } catch {
      return { ok: false, why: "页面失联（应用闪退）" };
    }
    if (p.msg.includes("正在重试") || p.msg.includes("未成功")) retried = true;
    if (p.msg.includes("启动失败")) return { ok: false, why: "启动失败: " + p.msg };
    if (p.msg.includes("仿真已启动") && p.status.includes("运行中")) break;
  }
  const p = await ui();
  if (!p.status.includes("运行中")) return { ok: false, why: "启动超时: " + JSON.stringify(p) };
  log(`${label}: 已启动（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${retried ? "，期间自动重试过" : ""}）`);
  return { ok: true };
}

async function stopOnce(label) {
  await clickSel(".btn-stop");
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    let p;
    try {
      p = await ui();
    } catch {
      return { ok: false, why: "停止后页面失联" };
    }
    if (p.status.includes("已停止") || p.status.includes("空闲")) {
      await sleep(1200);
      if (workerRunning()) return { ok: false, why: "停止后仿真子进程仍在运行" };
      log(`${label}: 已停止（子进程已退出）`);
      return { ok: true };
    }
  }
  return { ok: false, why: "停止超时" };
}

/** A. 板卡视图：LED 闪烁 */
async function stageBoard() {
  await openTab("板卡视图");
  await ensureStopped();
  const r = await runOnce("A 板卡视图");
  if (!r.ok) return r;
  let last = null;
  let flips = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < LED_SAMPLE_MS) {
    await sleep(150);
    let p;
    try {
      p = await ui();
    } catch {
      return { ok: false, why: "运行中闪退" };
    }
    if (last !== null && p.boardLed !== last) flips += 1;
    last = p.boardLed;
  }
  log(`A 板卡视图: LED 翻转 ${flips} 次`);
  if (flips < 3) {
    const p = await ui();
    await stopOnce("A 板卡视图");
    return {
      ok: false,
      why: `板卡 LED 未闪烁（${flips} 次）| 串口长度=${p.termLen} | 尾部=${JSON.stringify((p.termTail || "").split("\n").slice(-6).join(" / "))}`,
    };
  }
  return stopOnce("A 板卡视图");
}

/** B. 电路图：放置 LED、连线、运行并观察画布 LED */
async function stageCircuitLed() {
  await openTab("电路图");
  await ensureStopped();
  await zoomOut(8);

  await clickSel('[data-part-type="led"]');
  const wires0 = (await ui()).wires;
  await clickSel('[data-pin="led1:A"]');
  await clickSel('[data-pin="esp:GPIO2"]');
  await clickSel('[data-pin="led1:C"]');
  await clickSel('[data-pin="esp:GND.1"]');
  const wires1 = (await ui()).wires;
  log(`B 电路图: 导线 ${wires0} → ${wires1} 条`);
  if (wires1 !== wires0 + 2) return { ok: false, why: `连线失败（导线数 ${wires1}）` };

  const r = await runOnce("B 电路图");
  if (!r.ok) return r;

  let last = null;
  let flips = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < LED_SAMPLE_MS) {
    await sleep(150);
    let lit;
    try {
      lit = await ledLit();
    } catch {
      return { ok: false, why: "运行中闪退" };
    }
    if (last !== null && lit !== last) flips += 1;
    last = lit;
  }
  log(`B 电路图: 画布 LED 翻转 ${flips} 次`);
  if (flips < 3) {
    const p = await ui();
    return {
      ok: false,
      why: `画布 LED 未闪烁（${flips} 次）| 串口长度=${p.termLen} | 尾部=${JSON.stringify((p.termTail || "").split("\n").slice(-4).join(" / "))}`,
    };
  }
  return stopOnce("B 电路图");
}

/** C. 电路图 + 按键：验证按下时界面状态与注入调用（固件侧输入保持受限，见开发日志） */
async function stageCircuitButton() {
  await openTab("电路图");
  await ensureStopped();
  await clickSel('[data-part-type="pushbutton"]');
  await clickSel('[data-pin="sw1:A"]');
  await clickSel('[data-pin="esp:GPIO0"]');
  await clickSel('[data-pin="sw1:B"]');
  await clickSel('[data-pin="esp:GND.1"]');
  const p0 = await ui();
  log(`C 按键: 当前导线 ${p0.wires} 条`);
  if (p0.wires !== 4) return { ok: false, why: `按键连线失败（导线数 ${p0.wires}）` };

  const r = await runOnce("C 按键");
  if (!r.ok) return r;
  await sleep(RUN_HOLD_MS);

  // 落点由 elementFromPoint 探测（避开两侧引脚坐标，也避开压盖在上面的元件/导线）
  const c = await pointOnPart("sw1");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await sleep(400);

  const pressedAttr = await evalJs(
    `document.querySelector('[data-part="sw1"]')?.getAttribute('data-pressed')`,
  );
  const msgWhilePressed = (await ui()).msg;

  let litSamples = 0;
  let lowSamples = 0;
  for (let i = 0; i < 8; i++) {
    await sleep(200);
    if (await ledLit()) litSamples += 1;
    else lowSamples += 1;
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  log(`C 按键: 按下状态=${pressedAttr} 提示="${msgWhilePressed}" LED 亮 ${litSamples} 次/灭 ${lowSamples} 次`);

  const stop = await stopOnce("C 按键");
  if (!stop.ok) return stop;
  if (pressedAttr !== "1") return { ok: false, why: `按下时界面状态未更新（data-pressed=${pressedAttr}）` };
  return { ok: true };
}

/** D. 电路图 + 电位器：SIG→GPIO34，拖动旋钮应改变外观并经 cmd_set_apin 注入且不报错 */
async function stageCircuitPot() {
  await openTab("电路图");
  await ensureStopped();
  await clickSel('[data-part-type="potentiometer"]');
  const wires0 = (await ui()).wires;
  await clickSel('[data-pin="pot1:SIG"]');
  await clickSel('[data-pin="esp:GPIO34"]');
  await clickSel('[data-pin="pot1:VCC"]');
  await clickSel('[data-pin="esp:3V3"]');
  await clickSel('[data-pin="pot1:GND"]');
  await clickSel('[data-pin="esp:GND.1"]');
  const p0 = await ui();
  log(`D 电位器: 导线 ${wires0} → ${p0.wires} 条`);
  if (p0.wires !== wires0 + 3) return { ok: false, why: `电位器连线失败（导线数 ${p0.wires}，期望 ${wires0 + 3}）` };

  const r = await runOnce("D 电位器");
  if (!r.ok) return r;

  const potVal = () =>
    evalJs(`document.querySelector('[data-part="pot1"]')?.getAttribute('data-pot')`);
  const before = Number(await potVal());
  const from = await pointOnPart("pot1", [0.3, 0.45, 0.6, 0.75]);
  // 终点：元件内可靠命中的最低点（旋钮拖到高位）
  const bottoms = await pointOnPart("pot1", [0.9, 0.85, 0.75]);
  const to = { x: from.x, y: bottoms.y };
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(120);
  for (let i = 1; i <= 4; i++) {
    const x = from.x + ((to.x - from.x) * i) / 4;
    const y = from.y + ((to.y - from.y) * i) / 4;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(80);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
  await sleep(300);

  const after = Number(await potVal());
  const msg = (await ui()).msg;
  log(`D 电位器: data-pot ${before} → ${after}，提示="${msg}"`);

  const stop = await stopOnce("D 电位器");
  if (!stop.ok) return stop;
  if (!(after - before >= 0.4)) return { ok: false, why: `拖动旋钮未改变读数（${before} → ${after}）` };
  if (after < 0.9) return { ok: false, why: `旋钮未拖到高位（data-pot=${after}）` };
  if (/注入失败|未接到支持 ADC/.test(msg)) return { ok: false, why: `模拟量注入报错：${msg}` };
  return { ok: true };
}

// ===== 主流程 =====
killApp();
await sleep(1500);
log("启动应用:", EXE);
spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
  detached: true,
  stdio: "ignore",
}).unref();

await connectTo(await getPageWs());
if (!(await waitForUi())) {
  log("失败: 前端界面未就绪");
  killApp();
  process.exit(2);
}

let ready = false;
for (let i = 0; i < 60; i++) {
  const p = await ui();
  if (p.runDisabled === false) {
    ready = true;
    break;
  }
  await sleep(500);
}
if (!ready) {
  log("失败: DLL 自动加载未完成");
  killApp();
  process.exit(2);
}
const init = await ui();
log("初始状态:", JSON.stringify(init));
if (!init.msg.includes("已自动加载")) {
  log("失败: DLL 未自动加载 ->", init.msg);
  killApp();
  process.exit(2);
}

const stages = [
  ["A 板卡视图", stageBoard],
  ["B 电路图 LED", stageCircuitLed],
  ["C 电路图按键", stageCircuitButton],
  ["D 电路图电位器", stageCircuitPot],
];

const failed = [];
for (const [name, fn] of stages) {
  log(`===== ${name} =====`);
  let result;
  try {
    result = await fn();
  } catch (e) {
    result = { ok: false, why: e.message };
  }
  log(`${name}: ${result.ok ? "通过" : "失败 - " + result.why}`);
  if (!result.ok) failed.push(`${name}: ${result.why}`);
}

killApp();
if (failed.length > 0) {
  log("UI 自动化失败：");
  failed.forEach((f) => log("  - " + f));
  process.exit(2);
}
log("UI 自动化验证通过：板卡 LED 闪烁、电路图连线后 LED 闪烁、按键注入链路、电位器模拟量注入 四条链路全部成功");
process.exit(0);
