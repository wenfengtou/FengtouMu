/** 文件标签页（CircuitMuse 风格）：sketch.ino / diagram.json，居中放在统一工具条里 */

import { projectStore } from "../state/projectStore";
import { useStore } from "../state/store";
import { setActiveFile, uiStore } from "../state/uiStore";

const FILES = [
  { id: "sketch", name: "sketch.ino" },
  { id: "diagram", name: "diagram.json" },
];

export default function FileTabs() {
  const activeFileId = useStore(uiStore, (s) => s.activeFileId);
  const name = useStore(projectStore, (s) => s.name);
  const dirty = useStore(projectStore, (s) => s.dirty);

  return (
    <div className="file-tabs">
      <span className="file-tabs-owner" data-project-title={name} title={`These files belong to ${name}`}>
        {name}
      </span>
      {FILES.map((f) => (
        <div
          key={f.id}
          className={`file-tab${f.id === activeFileId ? " file-tab-active" : ""}`}
          onClick={() => setActiveFile(f.id)}
          title={f.name}
        >
          {f.id === "sketch" && dirty && <span className="file-tab-modified" title="有未保存改动" />}
          <span className="file-tab-name">{f.name}</span>
        </div>
      ))}
    </div>
  );
}
