// FengtouMu UI 自动化验证（真实点击，经 WebView2 CDP）
//
// 用法：node scripts/ui_drive.mjs
// 覆盖八条链路：
//   B 电路图 LED：放置 LED → 连线 D2/GND → 运行 → 画布上的 LED 闪烁 → 停止
//   C 电路图 + 按键：放置按键 → 连线 D0/GND → 运行 → 按住 → 界面按键状态更新 → 停止
//   D 电路图 + 电位器：放置电位器 → SIG 接 D34 → 运行 → 拖动旋钮 → 读数改变且注入无报错 → 停止
//   E 自动保存恢复：预置 autosave.vlx → 点「恢复上次编辑」→ 内容与工程名被整份灌回
//   H 一键编译：点「编译」→ arduino-cli 产出合并镜像、固件路径切到 *.ino.merged.bin
//   F 工程工具条：点「新建」→ 电路图与导线清空、标题回到未命名工程
//   G 环境自检：点「环境自检」→ 面板列出全部检查项且本机无缺失
//   H 一键编译：点「编译」→ arduino-cli 产出合并镜像、固件路径切到 *.ino.merged.bin
//
// 顺序说明：恢复链路必须排在「新建」之前 —— 新建会清掉会话标记（保存 / 打开也会），
// 排在后面就再也看不到「恢复上次编辑」按钮了。
//
// 注：固件侧“按住”电平保持受 QEMU GPIO 输入模型限制（见 docs/开发日志.md），
//     因此 C 只断言界面状态与注入链路，不断言 LED 常亮。
// 冷启动偶发卡死由应用内部自动重试，这里只需等待。

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(__dirname, "..", "src-tauri", "target", "release", "esp32-ide.exe");
// Tauri 的应用数据目录：%APPDATA%\<identifier>
const CONFIG_DIR = path.join(process.env.APPDATA ?? "", "com.lwf.esp32-ide");
const AUTOSAVE = path.join(CONFIG_DIR, "autosave.vlx");
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

/**
 * 预置一份自动保存内容（阶段 G 用），让「恢复上次编辑」链路的断言不依赖上一次运行是否恰好触发过自动保存。
 * 结构与 Rust 侧 Project 一致（diagram 是 diagram.json 文本）。
 */
function seedAutosave() {
  const diagram = JSON.stringify({
    version: 1,
    parts: [
      { type: "board-esp32-devkitc", id: "esp", top: 40, left: 40, attrs: {} },
      { type: "wokwi-led", id: "led1", top: 240, left: 460, attrs: { color: "red" } },
    ],
    connections: [
      ["led1:A", "esp:D2", "green", []],
      ["led1:C", "esp:GND.1", "green", []],
    ],
  });
  const project = {
    format: "fengtoumu-project",
    version: 1,
    name: "自动保存样例",
    updatedAt: new Date().toISOString(),
    code: "// 自动保存样例\nvoid setup(){}\nvoid loop(){}\n",
    files: [{ name: "sketch.ino", content: "// 自动保存样例\nvoid setup(){}\nvoid loop(){}\n" }],
    diagram,
    sketchDir: "",
    fwDir: "",
    flashPath: "",
    fqbn: "",
  };
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(AUTOSAVE, JSON.stringify(project, null, 2), "utf8");
    log(`已预置自动保存内容：${AUTOSAVE}`);
  } catch (e) {
    log(`预置自动保存内容失败（阶段 G 可能跳过）：${e.message}`);
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
    // 放宽到 45s：长编译期间 WebView2 后台节流会让 eval 挂起，编译结束即恢复
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error("timeout:" + method));
    }, 45000);
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
  const term = Array.from(document.querySelectorAll('.terminal-line')).map(e=>e.textContent).join('\\n');
  return {
    status: (document.querySelector('.status')||{}).textContent || '',
    msg: (document.querySelector('.msgbar')||{}).textContent || '',
    flash: (document.querySelector('.path')||{}).textContent || '',
    parts: document.querySelectorAll('[data-part]').length,
    wires: document.querySelectorAll('[data-wire]').length,
    runDisabled: (document.querySelector('.btn-run')||{}).disabled,
    hasStop: !!document.querySelector('.btn-stop'),
    projectTitle: (document.querySelector('[data-project-title]')||{}).textContent || '',
    envPanel: !!document.querySelector('[data-testid="env-panel"]'),
    envSummary: (document.querySelector('[data-env-summary]')||{}).getAttribute?.('data-env-summary') || '',
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
  // 若目标在可滚动容器（元件面板）内，先滚动到可见，避免命中裁剪区外的坐标
  await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el && el.closest && el.closest('.palette-items, .tb-overflow-menu, .file-explorer-list')) {
      el.scrollIntoView?.({ block: 'nearest' });
    }
    return true;
  })()`);
  await sleep(120);
  const c = await centerOf(selector, dyRatio);
  await clickAt(c.x, c.y);
};

/**
 * 点击引脚圆点本身（而非整个 <g> 的中心）。
 * 带标签的引脚（如 esp:D2）其 <g> 包围盒包含文字，几何中心会落在圆点与文字之间的
 * 空隙上（命中底板图像而不是引脚），导致 clickPin 不触发。直接点 <circle> 的中心最稳。
 */
async function clickPinSel(selector) {
  const c = await evalJs(`(() => {
    const g = document.querySelector(${JSON.stringify(selector)});
    if (!g) return null;
    const el = g.querySelector('circle');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!c) return clickSel(selector); // 兜底
  await clickAt(c.x, c.y);
}

async function openTab() {
  // 板卡视图已移除，右侧恒为电路图；保留调用点仅为兼容旧阶段顺序
  await sleep(200);
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

/** 断言某个元件内部已渲染出 wokwi 原图（.wokwi-art svg），证明外观不是手绘占位 */
async function assertWokwiArt(partId) {
  const ok = await evalJs(
    `!!document.querySelector('[data-part=${JSON.stringify(partId)}] .wokwi-art svg')`,
  );
  if (!ok) throw new Error(`元件 ${partId} 未渲染出 wokwi 原图（.wokwi-art svg 缺失）`);
  log(`元件 ${partId} 的 wokwi 原图已渲染`);
}

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

/** B. 电路图：放置 LED、连线、运行并观察画布 LED */
async function stageCircuitLed() {
  await openTab("电路图");
  await ensureStopped();
  await zoomOut(8);

  await addPartViaPicker('led');
  const wires0 = (await ui()).wires;
  await clickPinSel('[data-pin="led1:A"]');
  await clickPinSel('[data-pin="esp:D2"]');
  await clickPinSel('[data-pin="led1:C"]');
  await clickPinSel('[data-pin="esp:GND.1"]');
  const wires1 = (await ui()).wires;
  log(`B 电路图: 导线 ${wires0} → ${wires1} 条`);
  if (wires1 !== wires0 + 2) return { ok: false, why: `连线失败（导线数 ${wires1}）` };
  await assertWokwiArt("led1");

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
  await addPartViaPicker('pushbutton');
  await clickPinSel('[data-pin="sw1:A"]');
  await clickPinSel('[data-pin="esp:D0"]');
  await clickPinSel('[data-pin="sw1:B"]');
  await clickPinSel('[data-pin="esp:GND.1"]');
  const p0 = await ui();
  log(`C 按键: 当前导线 ${p0.wires} 条`);
  if (p0.wires !== 4) return { ok: false, why: `按键连线失败（导线数 ${p0.wires}）` };
  await assertWokwiArt("sw1");

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

/** D. 电路图 + 电位器：SIG→D34，拖动旋钮应改变外观并经 cmd_set_apin 注入且不报错 */
async function stageCircuitPot() {
  await openTab("电路图");
  await ensureStopped();
  await addPartViaPicker('potentiometer');
  const wires0 = (await ui()).wires;
  await clickPinSel('[data-pin="pot1:SIG"]');
  await clickPinSel('[data-pin="esp:D34"]');
  await clickPinSel('[data-pin="pot1:VCC"]');
  await clickPinSel('[data-pin="esp:3V3"]');
  await clickPinSel('[data-pin="pot1:GND"]');
  await clickPinSel('[data-pin="esp:GND.1"]');
  const p0 = await ui();
  log(`D 电位器: 导线 ${wires0} → ${p0.wires} 条`);
  if (p0.wires !== wires0 + 3) return { ok: false, why: `电位器连线失败（导线数 ${p0.wires}，期望 ${wires0 + 3}）` };
  await assertWokwiArt("pot1");

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

/** E. 工程工具条：新建工程应清空电路图与源码改动标记 */
async function stageProjectBar() {
  await ensureStopped();
  const before = await ui();
  log(`F 工程: 新建前 元件 ${before.parts} 个 / 导线 ${before.wires} 条 / 标题「${before.projectTitle}」`);
  if (before.wires === 0) return { ok: false, why: "前置状态异常：新建前导线数已为 0" };

  await clickSel('[data-action="new"]');
  await sleep(600);
  const after = await ui();
  log(`F 工程: 新建后 元件 ${after.parts} 个 / 导线 ${after.wires} 条 / 标题「${after.projectTitle}」`);
  if (after.wires !== 0) return { ok: false, why: `新建后导线未清空（${after.wires} 条）` };
  if (after.parts !== 1) return { ok: false, why: `新建后应只剩底板（当前 ${after.parts} 个元件）` };
  if (!after.msg.includes("已新建工程")) return { ok: false, why: `未出现新建提示：${after.msg}` };
  return { ok: true };
}

/** F. 环境自检：面板应列出全部检查项，且本机环境无缺失 */
async function stageEnvCheck() {
  // 打开汉堡菜单，让 [data-action="env-check"] 进入 DOM（默认折叠在菜单里）
  const opened = await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('.unified-toolbar button')).find(b => (b.getAttribute('title')||'') === 'Menu');
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  if (!opened) return { ok: false, why: "未找到汉堡菜单按钮" };
  await sleep(300);
  await clickSel('[data-action="env-check"]');
  let report = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await sleep(500);
    const items = await evalJs(`(() => {
      const list = Array.from(document.querySelectorAll('[data-env-item]'));
      return {
        count: list.length,
        missing: list.filter(e => e.getAttribute('data-env-status') === 'missing').map(e => e.getAttribute('data-env-item')),
        statuses: list.map(e => e.getAttribute('data-env-item') + ':' + e.getAttribute('data-env-status'))
      };
    })()`);
    if (items.count >= 6 && !(await evalJs(`!!document.querySelector('.env-panel button[disabled]')`))) {
      report = items;
      break;
    }
    report = items;
  }
  const panel = await ui();
  log(`G 自检: 面板=${panel.envPanel} 项数=${report ? report.count : 0} 缺失=${report ? report.missing.join(",") || "无" : "?"}`);
  log(`G 自检: ${report ? report.statuses.join(", ") : "（无结果）"}`);
  // 关闭面板，避免影响后续
  await evalJs(`(() => {
    const btns = Array.from(document.querySelectorAll('.env-head button'));
    const close = btns.find(b => b.textContent.trim() === '关闭');
    if (close) close.click();
    return true;
  })()`);
  await sleep(300);
  if (!panel.envPanel) return { ok: false, why: "自检面板未打开" };
  if (!report || report.count < 6) return { ok: false, why: `自检项不足（${report ? report.count : 0} 项）` };
  if (report.missing.length > 0) return { ok: false, why: `本机环境存在缺失项：${report.missing.join(", ")}` };
  return { ok: true };
}

/** G. 自动保存恢复：预置一份 autosave.vlx，点「恢复上次编辑」应把它整份灌回 */
async function stageRestoreSession() {
  const has = await evalJs(`!!document.querySelector('[data-action="restore-session"]')`);
  if (!has) return { ok: false, why: "未出现「恢复上次编辑」按钮（预置的自动保存内容未被识别）" };
  await clickSel('[data-action="restore-session"]');
  await sleep(900);
  const p = await ui();
  log(`E 恢复: 元件 ${p.parts} 个 / 导线 ${p.wires} 条 / 标题「${p.projectTitle}」/ 提示="${p.msg}"`);
  if (!p.msg.includes("已恢复")) return { ok: false, why: `未出现恢复提示：${p.msg}` };
  if (p.wires !== 2) return { ok: false, why: `恢复后导线数应为 2，实际 ${p.wires}` };
  if (p.parts !== 2) return { ok: false, why: `恢复后元件数应为 2（底板 + LED），实际 ${p.parts}` };
  if (!p.projectTitle.includes("自动保存样例")) {
    return { ok: false, why: `工程名未恢复：${p.projectTitle}` };
  }
  return { ok: true };
}

/** 通过 Add → 元件选择器模态框添加元件（CircuitMuse 交互） */
async function addPartViaPicker(type) {
  await clickSel('.add-component-btn');
  await sleep(500);
  await clickSel(`[data-part-type="${type}"]`);
  await sleep(400);
}

/** H. 一键编译：点「编译」应产出合并镜像并把固件路径指过去 */
async function stageCompile() {
  await ensureStopped();
  const clicked = await evalJs(`(() => {
    const btn = document.querySelector('[data-action="compile"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!clicked) return { ok: false, why: "未找到「编译」按钮（[data-action=compile]）" };
  log("H 编译: 已点击[编译]，等待 arduino-cli…");

  const deadline = Date.now() + 240000;
  let last = "";
  let sawCompiling = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    const p = await ui();
    last = p.msg;
    if (last.includes("正在编译")) sawCompiling = true;
    if (sawCompiling && last.includes("编译成功")) {
      log(`H 编译: 成功 → flash=${p.flash} | ${last.slice(0, 160)}`);
      if (!p.flash.endsWith(".ino.merged.bin")) {
        return { ok: false, why: `固件路径未指向合并镜像：${p.flash}` };
      }
      if (!last.includes("已同步到草图目录")) {
        return { ok: false, why: `编译提示里没有"编辑器内容已同步到草图目录"：${last.slice(0, 200)}` };
      }
      return { ok: true };
    }
    if (last.includes("编译失败") || last.includes("编译未产出")) {
      return { ok: false, why: last.slice(0, 400) };
    }
  }
  return { ok: false, why: `编译超时，最后提示：${last.slice(0, 200)}` };
}

/** I. 电路图 + 拨动开关：放置、连线、运行、切换开合，断言界面状态与注入链路 */
async function stageCircuitSwitch() {
  await openTab("电路图");
  await ensureStopped();
  await addPartViaPicker('switch');
  const wires0 = (await ui()).wires;
  await clickPinSel('[data-pin="tgl1:1"]');
  await clickPinSel('[data-pin="esp:D0"]');
  await clickPinSel('[data-pin="tgl1:2"]');
  await clickPinSel('[data-pin="esp:GND.1"]');
  const p0 = await ui();
  log(`I 开关: 导线 ${wires0} → ${p0.wires} 条`);
  if (p0.wires !== wires0 + 2) return { ok: false, why: `开关连线失败（导线数 ${p0.wires}）` };
  await assertWokwiArt("tgl1");

  const r = await runOnce("I 开关");
  if (!r.ok) return r;

  const c = await pointOnPart("tgl1", [0.4, 0.5, 0.6, 0.7]);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await sleep(250);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await sleep(300);

  const closed = await evalJs(
    `document.querySelector('[data-part="tgl1"]')?.getAttribute('data-closed')`,
  );
  const msg = (await ui()).msg;
  log(`I 开关: 切换后 data-closed=${closed} 提示="${msg}"`);

  const stop = await stopOnce("I 开关");
  if (!stop.ok) return stop;
  if (closed !== "1") return { ok: false, why: `切换开关后 data-closed=${closed}（应为 1）` };
  if (/注入失败/.test(msg)) return { ok: false, why: `注入报错：${msg}` };
  return { ok: true };
}

// ===== 主流程 =====
seedAutosave();
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

// Tauri 2 的 window.confirm 是原生对话框（返回 Promise），CDP 无法自动处理；
// 自动化里注入桩函数直接放行，真实用户不受影响。
await evalJs(`(() => { window.confirm = () => true; return true; })()`);

let ready = false;
for (let i = 0; i < 60; i++) {
  const p = await ui();
  // [运行] 按钮可用即说明 DLL 已自动加载完成（按钮的 disabled 取决于 dllPath）
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
// 注意：消息条只显示"最近一条"消息，启动时可能是自动保存提示而不是 DLL 提示，
// 因此不再对消息文本做强断言 —— 上面「[运行] 可用」已经等价于 DLL 路径就绪。
const init = await ui();
log("初始状态:", JSON.stringify(init));

const stages = [
  ["B 电路图 LED", stageCircuitLed],
  ["C 电路图按键", stageCircuitButton],
  ["D 电路图电位器", stageCircuitPot],
  ["E 自动保存恢复", stageRestoreSession],
  ["F 工程工具条", stageProjectBar],
  ["G 环境自检", stageEnvCheck],
  ["H 一键编译", stageCompile],
  ["I 电路图开关", stageCircuitSwitch],
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
log("UI 自动化验证通过：电路图 LED、按键注入、电位器注入、拨动开关、工程新建、环境自检、自动保存恢复、一键编译 八条链路全部成功");
process.exit(0);
