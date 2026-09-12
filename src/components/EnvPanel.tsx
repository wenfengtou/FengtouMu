/** 环境自检面板：逐项列出依赖状态，缺失项给出可执行的下一步 */

import { editorStore, pickFwDir, pickFlashFile } from "../state/editorStore";
import { envStore, runEnvCheck, setEnvPanelOpen } from "../state/envStore";
import { useStore } from "../state/store";

const STATUS_TEXT: Record<string, string> = {
  ok: "正常",
  warn: "注意",
  missing: "缺失",
};

export default function EnvPanel() {
  const open = useStore(envStore, (s) => s.open);
  const checking = useStore(envStore, (s) => s.checking);
  const report = useStore(envStore, (s) => s.report);
  const error = useStore(envStore, (s) => s.error);
  const fwDir = useStore(editorStore, (s) => s.fwDir);
  const flashPath = useStore(editorStore, (s) => s.flashPath);

  if (!open) return null;

  const items = report?.items ?? [];
  const missing = report?.missing ?? 0;

  return (
    <div className="env-mask" data-testid="env-panel">
      <div className="env-panel">
        <div className="env-head">
          <strong>环境自检</strong>
          <span
            className={`env-summary ${report?.ok ? "env-summary-ok" : "env-summary-bad"}`}
            data-env-summary={report?.ok ? "ok" : "bad"}
          >
            {report ? (report.ok ? `全部 ${items.length} 项正常` : `${missing} 项缺失`) : "尚未检查"}
          </span>
          <div className="toolbar-spacer" />
          <button type="button" onClick={() => void runEnvCheck()} disabled={checking}>
            {checking ? "检查中…" : "重新检查"}
          </button>
          <button type="button" onClick={() => setEnvPanelOpen(false)}>
            关闭
          </button>
        </div>

        <div className="env-paths">
          fw 目录：<code>{fwDir || "（未设置）"}</code>
          <br />
          固件镜像：<code>{flashPath || "（未设置）"}</code>
          <div className="env-path-actions">
            <button type="button" onClick={() => void pickFwDir()}>
              选择 fw 目录…
            </button>
            <button type="button" onClick={() => void pickFlashFile()}>
              选择固件镜像…
            </button>
          </div>
        </div>

        {error ? <div className="env-error">自检调用失败：{error}</div> : null}

        <ul className="env-list">
          {items.map((it) => (
            <li key={it.id} className={`env-item env-${it.status}`} data-env-item={it.id} data-env-status={it.status}>
              <div className="env-item-head">
                <span className="env-dot" />
                <span className="env-name">{it.name}</span>
                <span className="env-status">{STATUS_TEXT[it.status] ?? it.status}</span>
              </div>
              <div className="env-detail">{it.detail}</div>
              {it.hint ? <div className="env-hint">→ {it.hint}</div> : null}
            </li>
          ))}
          {items.length === 0 && !checking ? (
            <li className="env-item env-warn">
              <div className="env-detail">没有检查结果，点「重新检查」开始。</div>
            </li>
          ) : null}
        </ul>

        <div className="env-foot">
          缺少 QEMU 动态库时请按 <code>docs/build-qemu-dll-windows.md</code> 编译（Windows + MSYS2），
          把 <code>libqemu-xtensa.dll</code> 与依赖 DLL 一起放到项目的 <code>lib/qemu/</code>。
        </div>
      </div>
    </div>
  );
}
