import { useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { hexToWorld, type Project, type Unit } from "@hexcommand/shared";
import { projectLabelNodes, unitLabelNodes } from "./labelNodes.js";

const v = new THREE.Vector3();

/** Projects world anchors to screen each frame and positions the DOM labels. */
export function LabelProjector({ units, projects }: { units: Unit[]; projects: Project[] }) {
  const { camera, size } = useThree();
  const centroids = useRef(new Map<string, { x: number; z: number }>());
  centroids.current.clear();
  for (const p of projects) {
    if (!p.cells.length) continue;
    let sx = 0;
    for (const c of p.cells) sx += hexToWorld(c).x;
    // label above the topmost (smallest z) row of the territory
    const minZ = Math.min(...p.cells.map((c) => hexToWorld(c).z));
    centroids.current.set(p.id, { x: sx / p.cells.length, z: minZ - 1.95 });
  }

  useFrame(() => {
    const dist = camera.position.distanceTo((camera as THREE.PerspectiveCamera).userData.target ?? v.set(0, 0, 0));
    const unitOpacity = Math.max(0, Math.min(1, (36 - dist) / 9));
    for (const u of units) {
      const el = unitLabelNodes.get(u.id);
      if (!el) continue;
      const { x, z } = hexToWorld(u.hex);
      v.set(x, 1.95, z).project(camera);
      const sx = (v.x * 0.5 + 0.5) * size.width;
      const sy = (-v.y * 0.5 + 0.5) * size.height;
      const visible = v.z < 1 && sx > -200 && sx < size.width + 200 && sy > -100 && sy < size.height + 100;
      el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.opacity = visible ? String(unitOpacity) : "0";
    }
    for (const p of projects) {
      const el = projectLabelNodes.get(p.id);
      const c = centroids.current.get(p.id);
      if (!el || !c) continue;
      v.set(c.x, 0.2, c.z).project(camera);
      const sx = (v.x * 0.5 + 0.5) * size.width;
      const sy = (-v.y * 0.5 + 0.5) * size.height;
      el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -50%)`;
      el.style.opacity = v.z < 1 ? "0.9" : "0";
    }
  });
  return null;
}
