import { useShallow } from "zustand/react/shallow";
import { selectOpenAlerts, useFleet } from "../../store/useFleet.js";
import { attentionQueue } from "../../util/next.js";
import { useCommands } from "../CommandBar.js";

export function TabBar() {
  const sheet = useFleet((s) => s.sheet);
  const setSheet = useFleet((s) => s.setSheet);
  const alerts = useFleet(useShallow((s) => selectOpenAlerts(s).length));
  const attention = useFleet(useShallow((s) => attentionQueue(Object.values(s.units)).length));
  const c = useCommands();
  const toggle = (k: typeof sheet) => setSheet(sheet === k ? "closed" : k);
  return (
    <nav className="tabbar" aria-label="mobile navigation">
      <button type="button" className={sheet === "units" ? "active" : ""} onClick={() => toggle("units")}>
        <span className="ico">▦</span>Units
      </button>
      <button type="button" className={sheet === "alerts" ? "active" : ""} onClick={() => toggle("alerts")}>
        <span className="ico">◆</span>Alerts{alerts > 0 && <span className="badge">{alerts}</span>}
      </button>
      <button type="button" className={sheet === "commands" ? "active" : ""} onClick={() => toggle("commands")}>
        <span className="ico">⌘</span>Commands
      </button>
      <button type="button" className={attention ? "hot" : ""} onClick={c.nextOrders}>
        <span className="ico">▶</span>Next{attention > 0 && <span className="badge">{attention}</span>}
      </button>
    </nav>
  );
}
