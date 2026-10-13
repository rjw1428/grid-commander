import { useFleet } from "../store/useFleet.js";
import { STATUS_COLORS } from "../map/rigs/pose.js";
import { STATUS_LABEL } from "../util/format.js";

export function Legend() {
  const unitTypes = useFleet((s) => s.unitTypes);
  const projects = useFleet((s) => s.projects);
  return (
    <div className="body">
      <h3 className="sec">Ranks</h3>
      <div className="legend-grid">
        {Object.values(unitTypes).map((t) => (
          <div key={t.id} className="legend-row">
            <span className="glyph" style={{ ["--type" as string]: t.color }}>
              {t.glyph}
            </span>
            <div>
              <div className="t">
                {t.name} <span className="m">· {t.rank}</span>
              </div>
              <div className="m">
                {t.model} · {"★".repeat(t.stars) || "—"} · comms: {t.commsScope}
              </div>
              <div className="r">{t.role}</div>
            </div>
          </div>
        ))}
      </div>
      <h3 className="sec">Status</h3>
      <div className="swatches">
        {Object.entries(STATUS_COLORS).map(([k, c]) => (
          <span key={k}>
            <i className="sw" style={{ background: c }} />
            {STATUS_LABEL[k]}
          </span>
        ))}
      </div>
      <h3 className="sec">Identity</h3>
      <div className="swatches">
        <span>
          <i className="sw" style={{ background: "#6fb3f0" }} /> left armband + base plate = project
        </span>
        <span>
          <i className="sw" style={{ background: "#e07a3a" }} /> cap band, chest patch, epaulettes = rank
        </span>
        <span>
          <i className="sw" style={{ background: "#7fd68a" }} /> rotating ring = working
        </span>
        <span>
          <i className="sw" style={{ background: "#d4a73a" }} /> gold ring = selected · hex ring = team
        </span>
        <span>
          <i className="sw" style={{ background: "#6fb3f0" }} /> blue beacon = awaiting input · red = error
        </span>
      </div>
      <h3 className="sec">Projects</h3>
      <div className="swatches">
        {Object.values(projects).map((p) => (
          <span key={p.id}>
            <i className="sw" style={{ background: p.flag }} />
            {p.name} <span className="mono" style={{ color: "var(--dim)" }}>{p.cells.length} hexes</span>
          </span>
        ))}
      </div>
    </div>
  );
}
