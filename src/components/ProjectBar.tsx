/** 工程工具条：新建 / 打开 / 保存 / 另存为 / 最近工程 / Wokwi zip 互导 / 恢复上次 / 环境自检 */

import { useState } from "react";
import { runEnvCheck, setEnvPanelOpen } from "../state/envStore";
import {
  discardSession,
  exportWokwiProject,
  importWokwiProject,
  newProject,
  openProject,
  openProjectPath,
  projectStore,
  restoreSession,
  saveProject,
  saveProjectAs,
} from "../state/projectStore";
import { useStore } from "../state/store";

export default function ProjectBar() {
  const name = useStore(projectStore, (s) => s.name);
  const dirty = useStore(projectStore, (s) => s.dirty);
  const path = useStore(projectStore, (s) => s.path);
  const recent = useStore(projectStore, (s) => s.recent);
  const session = useStore(projectStore, (s) => s.session);
  const [recentOpen, setRecentOpen] = useState(false);

  return (
    <div className="project-bar">
      <span className="project-title" data-project-title={`${name}${dirty ? " *" : ""}`} title={path ?? ""}>
        工程：{name}
        {dirty ? " *" : ""}
      </span>

      <button type="button" data-action="new" onClick={() => newProject()}>
        新建
      </button>
      <button type="button" data-action="open" onClick={() => void openProject()}>
        打开…
      </button>
      <button type="button" data-action="save" onClick={() => void saveProject()}>
        保存
      </button>
      <button type="button" data-action="save-as" onClick={() => void saveProjectAs()}>
        另存为…
      </button>

      <div className="recent-wrap">
        <button
          type="button"
          data-action="recent"
          onClick={() => setRecentOpen((v) => !v)}
          disabled={recent.length === 0}
          title="最近打开的工程"
        >
          最近{recent.length > 0 ? `（${recent.length}）` : ""}
        </button>
        {recentOpen && recent.length > 0 ? (
          <ul className="recent-list">
            {recent.map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  data-recent-item={e.path}
                  onClick={() => {
                    setRecentOpen(false);
                    void openProjectPath(e.path);
                  }}
                  title={e.path}
                >
                  <span className="recent-name">{e.name}</span>
                  <span className="recent-path">{e.path}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <button type="button" data-action="import-zip" onClick={() => void importWokwiProject()}>
        导入 Wokwi zip
      </button>
      <button type="button" data-action="export-zip" onClick={() => void exportWokwiProject()}>
        导出 Wokwi zip
      </button>

      {session ? (
        <>
          <button
            type="button"
            className="btn-session"
            data-action="restore-session"
            onClick={() => void restoreSession()}
            title="恢复上次退出时未保存的内容"
          >
            恢复上次编辑
          </button>
          <button
            type="button"
            data-action="discard-session"
            onClick={() => void discardSession()}
            title="忽略上次的自动保存内容"
          >
            忽略
          </button>
        </>
      ) : null}

      <div className="toolbar-spacer" />
      <span className="project-path" title={path ?? ""}>
        {path ?? "尚未保存到文件"}
      </span>
      <button
        type="button"
        data-action="env-check"
        onClick={() => {
          setEnvPanelOpen(true);
          void runEnvCheck();
        }}
      >
        环境自检
      </button>
    </div>
  );
}
