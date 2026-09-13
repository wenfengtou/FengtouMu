/**
 * Projects modal — list, open, delete, create new projects.
 * UI 与文案照抄 CircuitMuse 的 ProjectsModal，数据对接本地工程存储（recent 列表）。
 */

import { useEffect, useState } from "react";
import { projectStore, openProjectPath, newProject, removeRecent, importWokwiProject } from "../state/projectStore";
import { useStore } from "../state/store";

interface ProjectsModalProps {
  onClose: () => void;
}

interface Entry {
  path: string;
  name: string;
  openedAt: string;
}

export const ProjectsModal: React.FC<ProjectsModalProps> = ({ onClose }) => {
  const recent = useStore(projectStore, (s) => s.recent);
  const currentPath = useStore(projectStore, (s) => s.path);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setEntries(recent);
    setLoading(false);
  }, [recent]);

  const handleOpen = async (id: string) => {
    await openProjectPath(id);
    onClose();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this project?")) return;
    await removeRecent(id);
    setEntries((prev) => prev.filter((p) => p.path !== id));
  };

  const handleNew = () => {
    newProject();
    onClose();
  };

  const handleImport = async () => {
    await importWokwiProject();
    onClose();
  };

  return (
    <div className="projects-overlay" onClick={onClose}>
      <div className="projects-modal" onClick={(e) => e.stopPropagation()}>
        <div className="projects-header">
          <h2>Projects</h2>
          <button className="projects-close" onClick={onClose} type="button">
            {"\u2715"}
          </button>
        </div>

        <div className="projects-actions">
          <button className="projects-btn projects-btn-primary" onClick={handleNew} type="button">
            New Project
          </button>
          <button className="projects-btn" onClick={handleImport} type="button">
            Import .vlx / .zip
          </button>
        </div>

        <div className="projects-list">
          {loading && <div className="projects-loading">Loading...</div>}
          {!loading && entries.length === 0 && (
            <div className="projects-empty">
              No saved projects yet. Create one or import a .vlx file.
            </div>
          )}
          {entries.map((project) => (
            <div key={project.path} className={`projects-item${project.path === currentPath ? " projects-item-current" : ""}`}>
              <div className="projects-item-info" onClick={() => handleOpen(project.path)}>
                <div className="projects-item-name">{project.name || "Untitled"}</div>
                <div className="projects-item-meta">
                  {project.path} · {new Date(project.openedAt).toLocaleDateString()}
                </div>
              </div>
              <button
                className="projects-item-delete"
                onClick={() => handleDelete(project.path)}
                title="Delete project"
                type="button"
              >
                {"\u2715"}
              </button>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .projects-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
          z-index: 10000;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .projects-modal {
          width: 560px;
          max-height: 80vh;
          background: #1e1e23;
          border: 1px solid #2c2c33;
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .projects-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid #2c2c33;
        }
        .projects-header h2 { margin: 0; font-size: 18px; }
        .projects-close {
          background: transparent;
          border: none;
          color: #888;
          cursor: pointer;
          font-size: 18px;
        }
        .projects-close:hover { color: #e6e6e9; }
        .projects-actions {
          display: flex;
          gap: 8px;
          padding: 12px 20px;
          border-bottom: 1px solid #2c2c33;
        }
        .projects-btn {
          padding: 8px 16px;
          border-radius: 4px;
          font-size: 13px;
          cursor: pointer;
          border: 1px solid #2c2c33;
          background: transparent;
          color: #e6e6e9;
        }
        .projects-btn:hover { background: #2c2c33; }
        .projects-btn-primary {
          background: #007acc;
          border-color: #007acc;
          color: white;
        }
        .projects-btn-primary:hover { background: #005ea1; }
        .projects-list {
          flex: 1;
          overflow-y: auto;
          padding: 8px 0;
        }
        .projects-loading, .projects-empty {
          padding: 40px 20px;
          text-align: center;
          color: #666;
        }
        .projects-item {
          display: flex;
          align-items: center;
          padding: 12px 20px;
          cursor: pointer;
        }
        .projects-item:hover { background: #15151b; }
        .projects-item-current { background: #15151b; }
        .projects-item-info { flex: 1; min-width: 0; }
        .projects-item-name { font-size: 14px; font-weight: 500; }
        .projects-item-meta { font-size: 12px; color: #888; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .projects-item-delete {
          background: transparent;
          border: none;
          color: #666;
          cursor: pointer;
          padding: 4px 8px;
          font-size: 14px;
        }
        .projects-item-delete:hover { color: #da3633; }
      `}</style>
    </div>
  );
};
