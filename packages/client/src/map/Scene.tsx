import { Suspense, useCallback, useMemo, useState } from "react";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { hexToWorld, type Project, type Unit } from "@hexcommand/shared";
import { useFleet } from "../store/useFleet.js";
import { Borders } from "./Borders.js";
import { CameraRig } from "./CameraRig.js";
import { HexTiles, type TileRef } from "./HexTiles.js";
import { LabelProjector } from "./LabelProjector.js";
import { Labels } from "./Labels.js";
import { Sea } from "./Sea.js";
import { UnitMarker } from "./UnitMarker.js";
import { useReducedMotion } from "../util/useIsMobile.js";

export interface SceneProps {
  mobile: boolean;
  focusOffsetY?: number;
  onTileClick?: (tile: TileRef, e: ThreeEvent<MouseEvent>) => void;
}

export function Scene({ mobile, focusOffsetY, onTileClick }: SceneProps) {
  const projectsMap = useFleet((s) => s.projects);
  const unitsMap = useFleet((s) => s.units);
  const teams = useFleet((s) => s.teams);
  const unitTypes = useFleet((s) => s.unitTypes);
  const selection = useFleet((s) => s.selection);
  const hover = useFleet((s) => s.hover);
  const mode = useFleet((s) => s.mode);
  const select = useFleet((s) => s.select);
  const toggleSelect = useFleet((s) => s.toggleSelect);
  const clearSelection = useFleet((s) => s.clearSelection);
  const setHover = useFleet((s) => s.setHover);
  const reducedMotion = useReducedMotion();
  const [tileHover, setTileHover] = useState<TileRef | null>(null);

  const projects = useMemo(() => Object.values(projectsMap), [projectsMap]);
  const units = useMemo(() => Object.values(unitsMap), [unitsMap]);

  const initialTarget = useMemo(() => {
    const cells = projects.flatMap((p) => p.cells);
    if (!cells.length) return { x: 0, z: 0 };
    const w = cells.map((c) => hexToWorld(c));
    return { x: w.reduce((a, b) => a + b.x, 0) / w.length, z: w.reduce((a, b) => a + b.z, 0) / w.length };
  }, [projects.length > 0]);

  const onSelect = useCallback(
    (id: string, multi: boolean) => {
      if (multi || mode === "multi") toggleSelect(id);
      else select([id]);
    },
    [mode, select, toggleSelect],
  );

  const handleTileClick = useCallback(
    (tile: TileRef, e: ThreeEvent<MouseEvent>) => {
      if (onTileClick) return onTileClick(tile, e);
      // territory click → select the project's units as a group
      const ids = units.filter((u) => u.projectId === tile.project.id).map((u) => u.id);
      if (ids.length) select(ids);
      useFleet.getState().setPanel({ kind: "project", id: tile.project.id });
    },
    [onTileClick, units, select],
  );

  const hoverKey = tileHover ? `${tileHover.hex[0]},${tileHover.hex[1]}` : null;

  return (
    <>
      <Canvas
        shadows
        dpr={mobile ? [1, 1.5] : [1, 2]}
        camera={{ fov: 42, near: 0.5, far: 220, position: [0, 22, 24] }}
        gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
        onPointerMissed={(e) => {
          if (e.button === 0) clearSelection();
        }}
      >
        <color attach="background" args={["#0b0f14"]} />
        <fog attach="fog" args={["#0b0f14", 34, 90]} />
        <hemisphereLight args={["#9aa9c0", "#2a2318", 0.95]} />
        <directionalLight
          position={[14, 20, 10]}
          intensity={2.3}
          color="#ffe2b8"
          castShadow
          shadow-mapSize={mobile ? [1024, 1024] : [2048, 2048]}
          shadow-camera-left={-28}
          shadow-camera-right={28}
          shadow-camera-top={28}
          shadow-camera-bottom={-28}
          shadow-camera-near={1}
          shadow-camera-far={80}
          shadow-bias={-0.0006}
        />
        <directionalLight position={[-12, 9, -14]} intensity={0.8} color="#6fa8ff" />
        <Suspense fallback={null}>
          <Sea />
          <HexTiles projects={projects} hoverKey={hoverKey} onHover={setTileHover} onClick={handleTileClick} />
          <Borders projects={projects} />
          {units.map((u) => {
            const type = unitTypes[u.type];
            const project = projectsMap[u.projectId];
            if (!type || !project) return null;
            return (
              <UnitMarker
                key={u.id}
                unit={u}
                type={type}
                project={project}
                team={u.teamId ? teams[u.teamId] : undefined}
                selected={selection.includes(u.id)}
                hovered={hover === u.id}
                reducedMotion={reducedMotion}
                onSelect={onSelect}
                onHover={setHover}
              />
            );
          })}
          <LabelProjector units={units} projects={projects} />
          <CameraRig initialTarget={initialTarget} focusOffsetY={focusOffsetY} />
        </Suspense>
      </Canvas>
      <Labels units={units} projects={projects} selection={selection} />
    </>
  );
}

export type { Project, Unit };
