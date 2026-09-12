import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import CodeEditor, { DEFAULT_SKETCH as SAMPLE_CODE } from "./components/CodeEditor";
import BoardView from "./components/BoardView";
import SerialTerminal, { type TerminalHandle } from "./components/SerialTerminal";
import {
  PIN_BOOT,
  autoLoadDll,
  bytesToText,
  compileSketch,
  dllLoaded,
  loadDll,
  onGpioUpdate,
  onSimLog,
  onSimStatus,
  onUartData,
  pinStates,
  pinWrite,
  simPause,
  simResume,
  simStart,
  simStatus,
  simStop,
  uartSend,
  type PinState,
  type SimStatus,
} from "./lib/api";
import "./App.css";

const DEFAULT_FW = "D:\\work\\Esp32Qume\\FengtouMu\\lib\\qemu\\fw";
const DEFAULT_SKETCH_DIR = "D:\\work\\Esp32Qume\\picsimlab_gpio_demo";
const DEFAULT_OUT = "D:\\work\\Esp32Qume\\FengtouMu\\build_demo";
const DEFAULT_FLASH = DEFAULT_OUT + "\\picsimlab_gpio_demo.ino.merged.bin";

const STATUS_TEXT: Record<SimStatus, string> = {
  idle: "空闲",
  loading: "加载中…",
  running: "运行中",
  stopping: "停止中…",
  stopped: "已停止",
};

function App() {
  const [code, setCode] = useState(SAMPLE_CODE);
  const [pins, setPins] = useState<Map<number, PinState>>(new Map());
  const [status, setStatus] = useState<SimStatus>("idle");
  const [dllPath, setDllPath] = useState("");
  const [fwDir, setFwDir] = useState(DEFAULT_FW);
  const [sketchDir, setSketchDir] = useState(DEFAULT_SKETCH_DIR);
  const [flashPath, setFlashPath] = useState(DEFAULT_FLASH);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const terminalRef = useRef<TerminalHandle>(null);

  const syncStatus = useCallback(async () => {
    const s = await simStatus().catch(() => "idle" as SimStatus);
    setStatus(s);
  }, []);

  useEffect(() => {
    let un: Array<() => void> = [];
    let stopped = false;

    (async () => {
      // 启动时自动定位 libqemu-xtensa.dll（实际加载发生在仿真子进程中）
      let loaded = false;
      try {
        const p = await autoLoadDll();
        setMsg(`DLL 已自动加载：${p}`);
        loaded = true;
      } catch {
        loaded = await dllLoaded().catch(() => false);
      }
      if (!stopped) setDllPath(loaded ? "（已加载）" : "");

      const states = await pinStates().catch(() => [] as PinState[]);
      if (!stopped) {
        const m = new Map<number, PinState>();
        states.forEach((s) => m.set(s.pin, s));
        setPins(m);
      }

      const [u1, u2, u3, u4] = await Promise.all([
        onGpioUpdate((s) => {
          setPins((prev) => {
            const next = new Map(prev);
            next.set(s.pin, s);
            return next;
          });
        }),
        onUartData((c) => {
          terminalRef.current?.append(bytesToText(c.data));
        }),
        onSimStatus((s) => setStatus(s)),
        onSimLog((c) => setMsg(c.message)),
      ]);
      if (!stopped) un = [u1, u2, u3, u4];
    })();

    return () => {
      stopped = true;
      un.forEach((f) => f());
    };
  }, []);

  useEffect(() => {
    syncStatus();
  }, [syncStatus]);

  const pickDll = async () => {
    const f = await open({
      title: "选择 libqemu-xtensa.dll",
      filters: [{ name: "QEMU DLL", extensions: ["dll"] }],
    });
    if (typeof f === "string") {
      setDllPath(f);
      setBusy(true);
      try {
        await loadDll(f);
        setMsg("DLL 加载成功，21 个符号核验通过");
      } catch (e) {
        setMsg(`DLL 加载失败: ${e}`);
      }
      setBusy(false);
    }
  };

  const pickFlash = async () => {
    const f = await open({
      title: "选择固件镜像（4MB 合并 bin）",
      filters: [{ name: "固件镜像", extensions: ["bin"] }],
    });
    if (typeof f === "string") setFlashPath(f);
  };

  const pickFw = async () => {
    const d = await open({ directory: true, title: "选择 fw 目录（含 ROM 和 keymaps）" });
    if (typeof d === "string") setFwDir(d);
  };

  const pickSketch = async () => {
    const d = await open({ directory: true, title: "选择 Arduino 工程目录（含 .ino）" });
    if (typeof d === "string") setSketchDir(d);
  };

  const build = async () => {
    setBusy(true);
    setMsg("正在编译…（首次约 1-3 分钟）");
    try {
      const r = await compileSketch(sketchDir, DEFAULT_OUT);
      if (r.ok && r.merged_bin) {
        setFlashPath(r.merged_bin);
        setMsg(`编译成功：${r.merged_bin}`);
      } else {
        setMsg(`编译未产出镜像：${r.message}`);
      }
    } catch (e) {
      setMsg(`编译失败: ${e}`);
    }
    setBusy(false);
  };

  const run = async () => {
    if (!dllPath || dllPath === "（已加载）") {
      // 尝试用已加载状态判断
      const loaded = await dllLoaded().catch(() => false);
      if (!loaded) {
        setMsg("请先加载 libqemu-xtensa.dll");
        return;
      }
    }
    setBusy(true);
    try {
      await simStart(flashPath, fwDir);
      setMsg("仿真已启动");
    } catch (e) {
      setMsg(`启动失败: ${e}`);
    }
    setBusy(false);
  };

  const stop = async () => {
    try {
      await simStop();
      setMsg("仿真已停止");
    } catch (e) {
      setMsg(`停止失败: ${e}`);
    }
  };

  const togglePause = async () => {
    try {
      if (status === "running") await simPause();
      else await simResume();
      await syncStatus();
    } catch (e) {
      setMsg(`操作失败: ${e}`);
    }
  };

  const bootPress = useCallback(
    async (pressed: boolean) => {
      try {
        await pinWrite(PIN_BOOT, pressed ? 0 : 1);
      } catch (e) {
        setMsg(`按键错误: ${e}`);
      }
    },
    [],
  );

  const uartInput = useCallback((text: string) => {
    const bytes = new TextEncoder().encode(text);
    uartSend(0, Array.from(bytes)).catch((e) => setMsg(`串口发送失败: ${e}`));
  }, []);

  const running = status === "running" || status === "loading" || status === "stopping";

  return (
    <div className="app">
      <header className="toolbar">
        <span className="logo">ESP32 IDE</span>
        <button onClick={pickDll} disabled={busy}>
          加载 DLL
        </button>
        <button onClick={pickSketch} disabled={busy} title="Arduino 工程目录">
          工程…
        </button>
        <button onClick={build} disabled={busy} title="用 arduino-cli 编译工程">
          编译
        </button>
        <button onClick={pickFlash} disabled={busy} title="固件镜像（4MB 合并 bin）">
          固件…
        </button>
        <button onClick={pickFw} disabled={busy}>
          fw 目录…
        </button>
        <span className="path" title={flashPath}>
          {flashPath.split("\\").pop()}
        </span>
        <div className="toolbar-spacer" />
        {!running ? (
          <button className="btn-run" onClick={run} disabled={busy || !dllPath}>
            ▶ 运行
          </button>
        ) : (
          <>
            <button className="btn-pause" onClick={togglePause}>
              {status === "running" ? "⏸ 暂停" : "▶ 继续"}
            </button>
            <button className="btn-stop" onClick={stop}>
              ⏹ 停止
            </button>
          </>
        )}
        <span className={`status status-${status}`}>● {STATUS_TEXT[status]}</span>
      </header>

      <div className="msgbar" title={msg}>
        {msg || "就绪：加载 DLL → 选择固件 → 运行仿真"}
      </div>

      <main className="main">
        <section className="editor-pane">
          <div className="pane-title">代码编辑器（Arduino）</div>
          <div className="editor-body">
            <CodeEditor code={code} onChange={setCode} />
          </div>
        </section>
        <section className="board-pane">
          <div className="pane-title">板卡视图 — ESP32 DevKitC</div>
          <div className="board-body">
            <BoardView pins={pins} onBootPress={bootPress} />
          </div>
        </section>
      </main>

      <footer className="terminal-pane">
        <SerialTerminal ref={terminalRef} onInput={uartInput} />
      </footer>
    </div>
  );
}

export default App;
