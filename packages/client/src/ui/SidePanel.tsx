import { useFleet } from "../store/useFleet.js";
import { Legend } from "./Legend.js";
import { RecruitDialog } from "./RecruitDialog.js";
import { GroupPanel } from "./panels/GroupPanel.js";
import { ProjectPanel } from "./panels/ProjectPanel.js";
import { UnitPanel } from "./panels/UnitPanel.js";

export function SidePanel({ className = "side-panel", messagesTab }: { className?: string; messagesTab?: (unitId: string) => React.ReactNode }) {
  const panel = useFleet((s) => s.panel);
  const setPanel = useFleet((s) => s.setPanel);
  const clearSelection = useFleet((s) => s.clearSelection);
  const teams = useFleet((s) => s.teams);
  if (panel.kind === "none") return null;
  const close = () => {
    clearSelection();
    setPanel({ kind: "none" });
  };
  const closeOnly = () => setPanel({ kind: "none" });
  return (
    <aside className={className}>
      {panel.kind === "legend" && (
        <>
          <header>
            <h2>Legend</h2>
            <button type="button" className="xbtn" onClick={closeOnly} aria-label="close">
              ×
            </button>
          </header>
          <Legend />
        </>
      )}
      {panel.kind === "unit" && (
        <UnitPanel id={panel.id} onClose={close}>
          {messagesTab?.(panel.id)}
        </UnitPanel>
      )}
      {panel.kind === "group" && <GroupPanel ids={panel.ids} onClose={close} />}
      {panel.kind === "team" && <GroupPanel ids={teams[panel.id]?.memberIds ?? []} onClose={close} title={teams[panel.id]?.name} />}
      {panel.kind === "project" && <ProjectPanel id={panel.id} onClose={close} />}
      {panel.kind === "recruit" && <RecruitDialog projectId={panel.projectId} onClose={closeOnly} />}
      {panel.kind === "settings" && (
        <>
          <header>
            <h2>Settings</h2>
            <button type="button" className="xbtn" onClick={closeOnly} aria-label="close">
              ×
            </button>
          </header>
          <div className="body">
            <div className="empty">Server settings arrive in M7.</div>
          </div>
        </>
      )}
    </aside>
  );
}
