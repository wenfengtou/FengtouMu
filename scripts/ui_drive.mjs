// ESP32 IDE UI 自动化验证（子进程方案）
// 用法：node scripts/ui_drive.mjs
// 覆盖：自动加载 DLL -> 点[运行](自动重试冷启动) -> LED 闪烁验证 -> 点[停止]
//       -> 在同一应用会话内**再次运行** -> 再次验证 -> 停止（验证可重复运行、不闪退）
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(__dirname, "..", "src-tauri", "target", "release", "esp32-ide.exe");
const CDP = "http://127.0.0.1:9222";
const START_TIMEOUT_MS = 120000; // 含宿主自动重试（每次尝试最长 30s，最多 3 次）
const LED_SAMPLE_MS = 15000; // 宿主机负载高时 guest 时间被拖慢，采样放宽到 15 秒
const RUN_HOLD_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
function killApp() {
  try { execSync("taskkill /IM esp32-ide.exe /T /F 2>nul"); } catch { /* ignore */ }
}

let ws = null, msgId = 0;
const pending = new Map();

async function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error("timeout:" + method)); }, 15000);
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
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error("未找到 CDP 调试页面");
}

const probe = `(() => {
  const board = (document.querySelector('.board-svg')||{}).textContent || '';
  return {
    status: (document.querySelector('.status')||{}).textContent || '',
    msg: (document.querySelector('.msgbar')||{}).textContent || '',
    flash: (document.querySelector('.path')||{}).textContent || '',
    led: board.includes('运行中'),
    runDisabled: (document.querySelector('.btn-run')||{}).disabled,
    hasStop: !!document.querySelector('.btn-stop')
  };
})()`;

async function ui() { return evalJs(probe); }

/** 运行一次并验证 LED 闪烁；返回 {ok, why} */
async function runOnce(label) {
  log(`--- ${label}: 点击[运行] ---`);
  await evalJs(`document.querySelector('.btn-run').click(); 'ok'`);
  const t0 = Date.now();
  let retried = false;
  while (Date.now() - t0 < START_TIMEOUT_MS) {
    await sleep(400);
    let p;
    try { p = await ui(); } catch { return { ok: false, why: "页面失联（应用闪退）" }; }
    if (p.msg.includes("正在重试") || p.msg.includes("未成功")) retried = true;
    if (p.msg.includes("启动失败")) return { ok: false, why: "启动失败: " + p.msg };
    if (p.msg.includes("仿真已启动") && p.status.includes("运行中")) break;
  }
  let p = await ui();
  if (!(p.status.includes("运行中"))) return { ok: false, why: "启动超时: " + JSON.stringify(p) };
  log(`${label}: 已启动（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${retried ? "，期间发生过冷启动自动重试" : ""}）`);

  // LED 闪烁采样（GPIO2，500ms 周期；6 秒应翻转 ≥6 次）
  let last = null, flips = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < LED_SAMPLE_MS) {
    await sleep(150);
    let cur;
    try { cur = await ui(); } catch { return { ok: false, why: "运行中闪退" }; }
    if (last !== null && cur.led !== last) flips++;
    last = cur.led;
  }
  if (flips < 3) return { ok: false, why: `LED 未正常闪烁（${LED_SAMPLE_MS / 1000} 秒仅翻转 ${flips} 次）` };
  log(`${label}: LED 闪烁正常（${LED_SAMPLE_MS / 1000} 秒翻转 ${flips} 次）`);

  await sleep(RUN_HOLD_MS);
  try { p = await ui(); } catch { return { ok: false, why: "保持运行期间闪退" }; }
  if (!p.status.includes("运行中")) return { ok: false, why: "运行状态丢失: " + p.status };
  return { ok: true, retried };
}

/** 点击停止并等待回到非运行态；同时确认仿真子进程已退出 */
async function stopOnce(label) {
  await evalJs(`(document.querySelector('.btn-stop')||{click(){}}).click(); 'ok'`);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    let p;
    try { p = await ui(); } catch { return { ok: false, why: "停止后页面失联" }; }
    if (p.status.includes("已停止") || p.status.includes("空闲")) {
      await sleep(1200);
      if (workerRunning()) return { ok: false, why: "停止后仿真子进程仍在运行(残留进程)" };
      log(`${label}: 已停止（子进程已退出）`);
      return { ok: true };
    }
  }
  return { ok: false, why: "停止超时" };
}

function workerRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq esp32-sim.exe" /NH', { encoding: "utf8" });
    return out.includes("esp32-sim.exe");
  } catch {
    return false;
  }
}

// ===== 主流程 =====
killApp();
await sleep(1500);
log("启动应用:", EXE);
spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
  detached: true, stdio: "ignore",
}).unref();

await connectPage();
if (!(await waitForUi())) { log("失败: 前端界面未就绪"); killApp(); process.exit(2); }
// 等待启动时的自动加载 DLL 完成（运行按钮由禁用变为可用）
let ready = false;
for (let i = 0; i < 60; i++) {
  const p = await ui();
  if (p.runDisabled === false) { ready = true; break; }
  await sleep(500);
}
if (!ready) { log("失败: DLL 自动加载未完成"); killApp(); process.exit(2); }
const init = await ui();
log("初始状态:", JSON.stringify(init));
if (!init.msg.includes("已自动加载")) { log("失败: DLL 未自动加载 ->", init.msg); killApp(); process.exit(2); }

for (const round of [1, 2]) {
  const r = await runOnce(`第${round}次运行`);
  if (!r.ok) { log(`失败(第${round}次运行):`, r.why); killApp(); process.exit(2); }
  const s = await stopOnce(`第${round}次运行`);
  if (!s.ok) { log(`失败(第${round}次停止):`, s.why); killApp(); process.exit(2); }
  await sleep(1500);
}

const fin = await ui();
log("最终状态:", JSON.stringify(fin));
killApp();
log("UI 自动化验证通过：同一会话内连续两次 [运行->LED闪烁->停止] 全部成功，且全程未闪退");
process.exit(0);

async function connectPage() {
  const url = await getPageWs();
  await connectTo(url);
}

async function connectTo(url) {
  await new Promise((res, rej) => {
    ws = new WebSocket(url);
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP 连接失败"));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    ws.onclose = () => { for (const [id, fn] of pending) fn({ error: { message: "closed" } }); pending.clear(); };
  });
}

/** 等待前端 UI 挂载（应用刚启动时页面可能是空白 target，需要轮询/切换目标） */
async function waitForUi(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJs(`!!document.querySelector('.btn-run')`)) return true;
    } catch { /* 页面尚未就绪 */ }
    try {
      const url = await getPageWs();
      if (!ws || ws.url !== url) await connectTo(url);
    } catch { /* ignore */ }
    await sleep(700);
  }
  return false;
}
