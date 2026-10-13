import { useMemo } from "react";
import * as THREE from "three";
import { hexToWorld, type Project } from "@hexcommand/shared";

const R = 0.985;
const SQ3 = Math.sqrt(3);

/** Gold line segments along the outer edges of each project's territory. */
export function Borders({ projects }: { projects: Project[] }) {
  const geometry = useMemo(() => {
    const pos: number[] = [];
    for (const p of projects) {
      const own = new Set(p.cells.map(([q, r]) => `${q},${r}`));
      const centres = p.cells.map((h) => ({ h, w: hexToWorld(h) }));
      for (const { w } of centres) {
        for (let k = 0; k < 6; k++) {
          const a0 = (k * Math.PI) / 3;
          const a1 = ((k + 1) * Math.PI) / 3;
          const mid = a0 + Math.PI / 6;
          // neighbour centre across this edge
          const nx = w.x + SQ3 * Math.sin(mid);
          const nz = w.z + SQ3 * Math.cos(mid);
          // back to axial: r = z / 1.5 ; q = x / sqrt3 - r/2
          const nr = Math.round(nz / 1.5);
          const nq = Math.round(nx / SQ3 - nr / 2);
          if (own.has(`${nq},${nr}`)) continue;
          pos.push(w.x + R * Math.sin(a0), 0.012, w.z + R * Math.cos(a0), w.x + R * Math.sin(a1), 0.012, w.z + R * Math.cos(a1));
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }, [projects]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color="#d4a73a" transparent opacity={0.9} />
    </lineSegments>
  );
}
