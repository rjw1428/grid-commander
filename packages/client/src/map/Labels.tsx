import { useEffect, useState } from "react";
import type { Project, Unit } from "@gridcommander/shared";
import { projectLabelNodes, unitLabelNodes } from "./labelNodes.js";
import { minutesSince } from "../util/format.js";

/** DOM overlay. Positioned per frame by <LabelProjector/>; content is React-driven. */
export function Labels({ units, projects, selection }: { units: Unit[]; projects: Project[]; selection: string[] }) {
  // re-render every 30 s so idle minutes tick
  const [, bump] = useState(0);
  useEffect(() => {
    const t = setInterval(() => bump((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="labels" aria-hidden="true">
      {projects.map((p) => (
        <div
          key={p.id}
          className="project-label"
          style={{ ["--flag" as string]: p.flag, opacity: 0 }}
          ref={(el) => {
            if (el) projectLabelNodes.set(p.id, el);
            else projectLabelNodes.delete(p.id);
          }}
        >
          <i className="flag-sw" />
          {p.name}
        </div>
      ))}
      {units.map((u) => {
        const idleMin = u.status === "idle" ? minutesSince(u.statusSince) : 0;
        return (
          <div
            key={u.id}
            className={`unit-label${selection.includes(u.id) ? " selected" : ""}`}
            data-unit-label={u.id}
            style={{ opacity: 0 }}
            ref={(el) => {
              if (el) unitLabelNodes.set(u.id, el);
              else unitLabelNodes.delete(u.id);
            }}
          >
            <span className="tag">
              <span className={`status-dot ${u.status}`} />
              {u.name}
              {u.missionDone && <span className="flag">⚑</span>}
            </span>
            {(u.queueLength > 0 || idleMin >= 2 || u.status === "working") && (
              <span className="extra">
                {u.queueLength > 0 && <span className="q">+{u.queueLength}</span>}
                {idleMin >= 2 && <span>{idleMin}m</span>}
                {u.status === "working" && u.activity && <span className="act">{u.activity}</span>}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
