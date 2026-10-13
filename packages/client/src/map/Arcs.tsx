import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { hexToWorld, type Message } from "@gridcommander/shared";
import { useFleet } from "../store/useFleet.js";

interface Arc {
  id: string;
  from: THREE.Vector3;
  to: THREE.Vector3;
  color: string;
  born: number;
}

const LIFE = 1.6;
const SEGMENTS = 24;

function ArcLine({ arc }: { arc: Arc }) {
  const line = useRef<THREE.Line>(null);
  const head = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => {
    const mid = arc.from.clone().lerp(arc.to, 0.5);
    mid.y += Math.max(1.2, arc.from.distanceTo(arc.to) * 0.35);
    const curve = new THREE.QuadraticBezierCurve3(arc.from, mid, arc.to);
    const pts = curve.getPoints(SEGMENTS);
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    g.setDrawRange(0, 0);
    g.userData.curve = curve;
    return g;
  }, [arc]);
  useFrame(() => {
    const t = (performance.now() / 1000 - arc.born) / LIFE;
    const k = Math.min(1, t * 1.25);
    geometry.setDrawRange(0, Math.max(2, Math.floor(k * (SEGMENTS + 1))));
    const mat = line.current?.material as THREE.LineBasicMaterial | undefined;
    if (mat) mat.opacity = t < 0.75 ? 1 : Math.max(0, 1 - (t - 0.75) / 0.25);
    if (head.current) {
      const curve = geometry.userData.curve as THREE.QuadraticBezierCurve3;
      head.current.position.copy(curve.getPoint(k));
      head.current.visible = t < 0.85;
    }
  });
  return (
    <group>
      <primitive object={new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: arc.color, transparent: true, opacity: 1 }))} ref={line} />
      <mesh ref={head}>
        <sphereGeometry args={[0.09, 8, 8]} />
        <meshBasicMaterial color={arc.color} />
      </mesh>
    </group>
  );
}

/** A relay arc per message.new: sender hex → each recipient hex, 1.6 s. */
export function Arcs() {
  const messages = useFleet((s) => s.messages);
  const [arcs, setArcs] = useState<Arc[]>([]);
  const seen = useRef(new Set<string>());
  const hasHq = useFleet((s) => s.server?.hasHq);

  useEffect(() => {
    const st = useFleet.getState();
    const fresh: Arc[] = [];
    for (const m of messages as Message[]) {
      if (seen.current.has(m.id)) continue;
      seen.current.add(m.id);
      if (Date.now() - m.createdAt > 5000) continue; // history, not a live event
      const color = m.from === "operator" && !m.relayedFrom ? "#9aa3ad" : m.priority === "urgent" ? "#ff6a3d" : "#f2d27a";
      const fromUnit = st.units[m.relayedFrom ?? m.from];
      let from: THREE.Vector3 | null = null;
      if (fromUnit) {
        const w = hexToWorld(fromUnit.hex);
        from = new THREE.Vector3(w.x, 1.2, w.z);
      } else if (hasHq) {
        const hq = st.projects.hq;
        const c = hq?.cells[0];
        if (c) {
          const w = hexToWorld(c);
          from = new THREE.Vector3(w.x, 1.2, w.z);
        }
      }
      for (const rid of Object.keys(m.deliveries)) {
        const r = st.units[rid];
        if (!r) continue;
        const w = hexToWorld(r.hex);
        const to = new THREE.Vector3(w.x, 1.2, w.z);
        const start = from ?? to.clone().add(new THREE.Vector3(-6, 6, -10)); // off-map when no HQ
        fresh.push({ id: `${m.id}:${rid}`, from: start, to, color, born: performance.now() / 1000 });
      }
    }
    if (fresh.length) setArcs((a) => [...a, ...fresh]);
  }, [messages, hasHq]);

  useEffect(() => {
    if (!arcs.length) return;
    const t = setTimeout(() => {
      const now = performance.now() / 1000;
      setArcs((a) => a.filter((x) => now - x.born < LIFE));
    }, LIFE * 1000 + 50);
    return () => clearTimeout(t);
  }, [arcs]);

  return (
    <>
      {arcs.map((a) => (
        <ArcLine key={a.id} arc={a} />
      ))}
    </>
  );
}
