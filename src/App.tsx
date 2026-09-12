import { useEffect } from "react";
import BoardView from "./components/BoardView";
import CircuitPanel from "./components/CircuitPanel";
import CodeEditor from "./components/CodeEditor";
import EnvPanel from "./components/EnvPanel";
import ProjectBar from "./components/ProjectBar";
import SerialTerminal from "./components/SerialTerminal";
import { STATUS_TEXT } from "./config";
import { PIN_BOOT } from "./lib/api";
import { initCircuitBridge } from "./state/bridge";
import { initEnvCheck } from "./state/envStore";
import {
  compileCurrent,
  editorStore,
  pickFlashFile,
  pickFwDir,
  pickSketchDir,
  setCode,
} from "./state/editorStore";
import { initProject } from "./state/projectStore";
import {
  clearUart,
  initSim,
  pickDllFile,
  sendUart,
  simStore,
  startSim,
  stopSim,
  togglePauseSim,
  writePin,
} from "./state/simStore";
import { useStore } from "./state/store";
import { setView, uiStore } from "./state/uiStore";
import "./App.css";

function App() {
  const code = useStore(editorStore, (s) => s.code);
  const flashPath = useStore(editorStore, (s) => s.flashPath);
  const pins = useStore(simStore, (s) => s.pins);
  const status = useStore(simStore, (s) => s.status);
  const dllPath = useStore(simStore, (s) => s.dllPath);
  const uartText = useStore(simStore, (s) => s.uartText);
  const msg = useStore(uiStore, (s) => s.msg);
  const busy = useStore(uiStore, (s) => s.busy);
  const view = useStore(uiStore, (s) => s.view);

  useEffect(() => {
    initCircuitBridge();
    void initSim();
    void initProject();
    void initEnvCheck();
  }, []);

  const running = status === "running" || status === "loading" || status === "stopping";

  return (
    <div className="app">
      <header className="toolbar">
        <span className="logo">FengtouMu</span>
        <button onClick={() => void pickDllFile()} disabled={busy}>
          加载 DLL
        </button>
        <button onClick={() => void pickSketchDir()} disabled={busy} title="Arduino 草图目录（含 .ino）">
          草图目录…
        </button>
        <button onClick={() => void compileCurrent()} disabled={busy} title="用 arduino-cli 编译工程">
          编译
        </button>
        <button onClick={() => void pickFlashFile()} disabled={busy} title="固件镜像（4MB 合并 bin）">
          固件…
        </button>
        <button onClick={() => void pickFwDir()} disabled={busy} title="QEMU 的 fw 目录">
          fw 目录…
        </button>
        <span className="path" title={flashPath}>
          {flashPath.split("\\").pop()}
        </span>
        <div className="toolbar-spacer" />
        {!running ? (
          <button className="btn-run" onClick={() => void startSim()} disabled={busy || !dllPath}>
            ▶ 运行
          </button>
        ) : (
          <>
            <button className="btn-pause" onClick={() => void togglePauseSim()}>
              {status === "running" ? "⏸ 暂停" : "▶ 继续"}
            </button>
            <button className="btn-stop" onClick={() => void stopSim()}>
              ⏹ 停止
            </button>
          </>
        )}
        <span className={`status status-${status}`}>● {STATUS_TEXT[status]}</span>
      </header>

      <ProjectBar />

      <div className="msgbar" title={msg}>
        {msg || "就绪：加载 DLL → 编译或选择固件 → 运行仿真"}
      </div>

      <main className="main">
        <section className="editor-pane">
          <div className="pane-title">代码编辑器（Arduino）</div>
          <div className="editor-body">
            <CodeEditor code={code} onChange={setCode} />
          </div>
        </section>
        <section className="board-pane">
          <div className="pane-title pane-tabs">
            <button
              className={view === "board" ? "tab active" : "tab"}
              onClick={() => setView("board")}
            >
              板卡视图
            </button>
            <button
              className={view === "circuit" ? "tab active" : "tab"}
              onClick={() => setView("circuit")}
            >
              电路图
            </button>
          </div>
          <div className={view === "circuit" ? "board-body board-body-circuit" : "board-body"}>
            {view === "board" ? (
              <BoardView
                pins={pins}
                onBootPress={(pressed) => void writePin(PIN_BOOT, pressed ? 0 : 1)}
              />
            ) : (
              <CircuitPanel />
            )}
          </div>
        </section>
      </main>

      <footer className="terminal-pane">
        <SerialTerminal
          text={uartText}
          onInput={(t) => void sendUart(t)}
          onClear={clearUart}
        />
      </footer>

      <EnvPanel />
    </div>
  );
}

export default App;
