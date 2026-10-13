import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { UnitTypeDef } from "@hexcommand/shared";
import type { RigParts } from "./pose.js";

// ---------------------------------------------------------------------------- shared geometries
const G = {
  leg: new THREE.BoxGeometry(0.14, 0.42, 0.16),
  boot: new THREE.BoxGeometry(0.16, 0.08, 0.2),
  torso: new THREE.BoxGeometry(0.44, 0.48, 0.26),
  patch: new THREE.BoxGeometry(0.11, 0.1, 0.02),
  epaulette: new THREE.BoxGeometry(0.15, 0.035, 0.11),
  arm: new THREE.BoxGeometry(0.12, 0.4, 0.12),
  band: new THREE.BoxGeometry(0.135, 0.07, 0.135),
  hand: new THREE.BoxGeometry(0.11, 0.1, 0.11),
  head: new THREE.BoxGeometry(0.27, 0.28, 0.27),
  hardhat: new THREE.CylinderGeometry(0.12, 0.175, 0.13, 8),
  brim: new THREE.CylinderGeometry(0.22, 0.22, 0.025, 8),
  helmet: new THREE.SphereGeometry(0.195, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.55),
  helmetBand: new THREE.CylinderGeometry(0.2, 0.2, 0.04, 10),
  hood: new THREE.CylinderGeometry(0.07, 0.245, 0.3, 8),
  fringe: new THREE.CylinderGeometry(0.26, 0.23, 0.07, 8),
  cap: new THREE.CylinderGeometry(0.16, 0.165, 0.095, 10),
  capBand: new THREE.CylinderGeometry(0.17, 0.17, 0.035, 10),
  peak: new THREE.BoxGeometry(0.26, 0.02, 0.13),
  star: new THREE.OctahedronGeometry(0.03),
  clipboard: new THREE.BoxGeometry(0.2, 0.26, 0.02),
  calculator: new THREE.BoxGeometry(0.1, 0.15, 0.03),
  tripodLeg: new THREE.CylinderGeometry(0.014, 0.014, 0.72, 5),
  tripodHead: new THREE.BoxGeometry(0.1, 0.07, 0.1),
  scope: new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8),
  handle: new THREE.CylinderGeometry(0.024, 0.024, 0.72, 6),
  pickHead: new THREE.BoxGeometry(0.32, 0.06, 0.06),
  rifle: new THREE.BoxGeometry(0.07, 0.07, 0.95),
  rifleScope: new THREE.CylinderGeometry(0.028, 0.028, 0.2, 8),
  glint: new THREE.SphereGeometry(0.035, 6, 6),
  folder: new THREE.BoxGeometry(0.24, 0.02, 0.3),
  page: new THREE.PlaneGeometry(0.22, 0.28),
  radio: new THREE.BoxGeometry(0.08, 0.16, 0.05),
  antenna: new THREE.CylinderGeometry(0.007, 0.007, 0.26, 5),
  ping: new THREE.RingGeometry(0.06, 0.08, 16),
  baton: new THREE.CylinderGeometry(0.012, 0.012, 0.42, 6),
  barkRing: new THREE.RingGeometry(0.09, 0.11, 18),
};

const UNIFORM: Record<UnitTypeDef["rig"], { uniform: string; pants: string; hat: string }> = {
  engineer: { uniform: "#8d7d55", pants: "#5b5240", hat: "#f2c14e" },
  infantry: { uniform: "#5e6d3e", pants: "#424d2c", hat: "#4f5b34" },
  sniper: { uniform: "#3f5a3b", pants: "#2e4030", hat: "#2f4a2c" },
  officer: { uniform: "#2f3b55", pants: "#232b40", hat: "#232b40" },
};

const desat = (hex: string, amount: number) => {
  const c = new THREE.Color(hex);
  const grey = new THREE.Color("#6b7079");
  return c.lerp(grey, amount);
};

function makeMaterials(type: UnitTypeDef, flag: string, offline: boolean) {
  const d = offline ? 0.75 : 0;
  const palette = UNIFORM[type.rig];
  const std = (hex: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color: desat(hex, d), flatShading: true, roughness: 0.85, metalness: 0.05, ...extra });
  return {
    skin: std("#d7a476"),
    uniform: std(palette.uniform),
    pants: std(palette.pants),
    boots: std("#2a2320"),
    hat: std(palette.hat),
    type: std(type.color, { emissive: new THREE.Color(type.color), emissiveIntensity: offline ? 0 : 0.25 }),
    flag: std(flag, { emissive: new THREE.Color(flag), emissiveIntensity: offline ? 0 : 0.3 }),
    gold: std("#e9c46a", { metalness: 0.4, roughness: 0.4 }),
    wood: std("#7a4f2a"),
    metal: std("#8e98a3", { metalness: 0.6, roughness: 0.35 }),
    paper: std("#efe9d8", { roughness: 1 }),
    dark: std("#1d232c"),
    glint: new THREE.MeshBasicMaterial({ color: "#ffffff" }),
    ping: new THREE.MeshStandardMaterial({ color: type.color, emissive: type.color, emissiveIntensity: 1, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    ring0: new THREE.MeshStandardMaterial({ color: "#f2d27a", emissive: "#f2d27a", emissiveIntensity: 1, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    ring1: new THREE.MeshStandardMaterial({ color: "#f2d27a", emissive: "#f2d27a", emissiveIntensity: 1, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    ring2: new THREE.MeshStandardMaterial({ color: "#f2d27a", emissive: "#f2d27a", emissiveIntensity: 1, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
  };
}

export interface SoldierProps {
  type: UnitTypeDef;
  flag: string;
  offline: boolean;
  /** Receives the rig handles once mounted; the marker drives poseSoldier() per frame. */
  onParts: (parts: RigParts | null) => void;
}

/** Low-poly soldier built from boxes and cylinders. Faces +z. Hips at y≈0.42, eyes at y≈1.1. */
export function Soldier({ type, flag, offline, onParts }: SoldierProps) {
  const mats = useMemo(() => makeMaterials(type, flag, offline), [type, flag, offline]);
  useLayoutEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const root = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const glint = useRef<THREE.Mesh>(null);
  const page = useRef<THREE.Group>(null);
  const ping = useRef<THREE.Mesh>(null);
  const ring0 = useRef<THREE.Mesh>(null);
  const ring1 = useRef<THREE.Mesh>(null);
  const ring2 = useRef<THREE.Mesh>(null);

  useLayoutEffect(() => {
    if (!root.current || !legL.current || !legR.current || !torso.current || !armL.current || !armR.current || !head.current) return;
    onParts({
      root: root.current,
      legL: legL.current,
      legR: legR.current,
      torso: torso.current,
      armL: armL.current,
      armR: armR.current,
      head: head.current,
      props: {
        glint: glint.current ?? undefined,
        page: page.current ?? undefined,
        ping: ping.current ?? undefined,
        ring0: ring0.current ?? undefined,
        ring1: ring1.current ?? undefined,
        ring2: ring2.current ?? undefined,
      },
      propMaterials: { ping: mats.ping, ring0: mats.ring0, ring1: mats.ring1, ring2: mats.ring2 },
    });
    return () => onParts(null);
  }, [onParts, mats, type]);

  const props = new Set(type.props);
  const officer = type.rig === "officer";

  return (
    <group ref={root}>
      {/* legs */}
      <group ref={legL} position={[-0.11, 0.42, 0]}>
        <mesh geometry={G.leg} material={mats.pants} position={[0, -0.21, 0]} castShadow />
        <mesh geometry={G.boot} material={mats.boots} position={[0, -0.4, 0.02]} castShadow />
      </group>
      <group ref={legR} position={[0.11, 0.42, 0]}>
        <mesh geometry={G.leg} material={mats.pants} position={[0, -0.21, 0]} castShadow />
        <mesh geometry={G.boot} material={mats.boots} position={[0, -0.4, 0.02]} castShadow />
      </group>

      {/* torso pivots at the hips */}
      <group ref={torso} position={[0, 0.42, 0]}>
        <mesh geometry={G.torso} material={mats.uniform} position={[0, 0.24, 0]} castShadow />
        <mesh geometry={G.patch} material={mats.type} position={[0.1, 0.33, 0.14]} />
        {officer && (
          <>
            <mesh geometry={G.epaulette} material={mats.type} position={[-0.22, 0.49, 0]} />
            <mesh geometry={G.epaulette} material={mats.type} position={[0.22, 0.49, 0]} />
          </>
        )}

        {/* left arm: project armband */}
        <group ref={armL} position={[-0.29, 0.44, 0]}>
          <mesh geometry={G.arm} material={mats.uniform} position={[0, -0.2, 0]} castShadow />
          <mesh geometry={G.band} material={mats.flag} position={[0, -0.09, 0]} />
          <mesh geometry={G.hand} material={mats.skin} position={[0, -0.44, 0]} />
          {props.has("clipboard") && <mesh geometry={G.clipboard} material={mats.paper} position={[0.04, -0.4, 0.12]} rotation={[-0.35, 0, 0]} />}
          {props.has("folder") && (
            <group position={[0.1, -0.44, 0.1]}>
              <mesh geometry={G.folder} material={mats.dark} />
              <group ref={page} position={[-0.12, 0.015, 0]}>
                <mesh geometry={G.page} material={mats.paper} position={[0.11, 0, 0]} rotation={[-Math.PI / 2, 0, 0]} />
              </group>
            </group>
          )}
        </group>

        {/* right arm: tools */}
        <group ref={armR} position={[0.29, 0.44, 0]}>
          <mesh geometry={G.arm} material={mats.uniform} position={[0, -0.2, 0]} castShadow />
          <mesh geometry={G.hand} material={mats.skin} position={[0, -0.44, 0]} />
          {props.has("calculator") && <mesh geometry={G.calculator} material={mats.dark} position={[0, -0.44, 0.09]} rotation={[-0.3, 0, 0]} />}
          {props.has("pickaxe") && (
            <group position={[0, -0.44, 0]}>
              <mesh geometry={G.handle} material={mats.wood} position={[0, 0.22, 0]} castShadow />
              <mesh geometry={G.pickHead} material={mats.metal} position={[0, 0.56, 0]} rotation={[0, 0, 0.12]} castShadow />
            </group>
          )}
          {props.has("rifle") && (
            <group position={[-0.08, -0.4, 0.28]}>
              <mesh geometry={G.rifle} material={mats.dark} castShadow />
              <mesh geometry={G.rifleScope} material={mats.metal} position={[0, 0.07, -0.05]} rotation={[Math.PI / 2, 0, 0]} />
              <mesh ref={glint} geometry={G.glint} material={mats.glint} position={[0, 0.07, 0.09]} visible={false} />
            </group>
          )}
          {props.has("radio") && (
            <group position={[0, -0.44, 0.06]}>
              <mesh geometry={G.radio} material={mats.dark} />
              <mesh geometry={G.antenna} material={mats.metal} position={[0.03, 0.2, 0]} />
              <mesh ref={ping} geometry={G.ping} material={mats.ping} position={[0.03, 0.34, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false} />
            </group>
          )}
          {props.has("baton") && <mesh geometry={G.baton} material={mats.dark} position={[0, -0.44, 0.2]} rotation={[Math.PI / 2, 0, 0]} />}
        </group>

        {/* head */}
        <group ref={head} position={[0, 0.5, 0]}>
          <mesh geometry={G.head} material={mats.skin} position={[0, 0.16, 0]} castShadow />
          {type.rig === "engineer" && (
            <>
              <mesh geometry={G.hardhat} material={mats.hat} position={[0, 0.34, 0]} castShadow />
              <mesh geometry={G.brim} material={mats.hat} position={[0, 0.285, 0.01]} />
            </>
          )}
          {type.rig === "infantry" && (
            <>
              <mesh geometry={G.helmet} material={mats.hat} position={[0, 0.22, 0]} castShadow />
              <mesh geometry={G.helmetBand} material={mats.type} position={[0, 0.25, 0]} />
            </>
          )}
          {type.rig === "sniper" && (
            <>
              <mesh geometry={G.hood} material={mats.hat} position={[0, 0.3, 0]} castShadow />
              <mesh geometry={G.fringe} material={mats.uniform} position={[0, 0.15, 0]} />
            </>
          )}
          {officer && (
            <>
              <mesh geometry={G.cap} material={mats.hat} position={[0, 0.345, 0]} castShadow />
              <mesh geometry={G.capBand} material={mats.type} position={[0, 0.31, 0]} />
              <mesh geometry={G.peak} material={mats.dark} position={[0, 0.3, 0.17]} />
              {Array.from({ length: type.stars }, (_, k) => (
                <mesh key={k} geometry={G.star} material={mats.gold} position={[(k - (type.stars - 1) / 2) * 0.075, 0.345, 0.165]} />
              ))}
            </>
          )}
          {props.has("baton") && (
            <group position={[0, 0.1, 0.2]}>
              <mesh ref={ring0} geometry={G.barkRing} material={mats.ring0} visible={false} />
              <mesh ref={ring1} geometry={G.barkRing} material={mats.ring1} visible={false} />
              <mesh ref={ring2} geometry={G.barkRing} material={mats.ring2} visible={false} />
            </group>
          )}
        </group>
      </group>

      {/* survey tripod beside the engineer */}
      {props.has("tripod") && (
        <group position={[0.62, 0, 0.12]}>
          <mesh geometry={G.tripodLeg} material={mats.metal} position={[0.12, 0.36, 0.1]} rotation={[0.25, 0, -0.3]} />
          <mesh geometry={G.tripodLeg} material={mats.metal} position={[-0.12, 0.36, 0.1]} rotation={[0.25, 0, 0.3]} />
          <mesh geometry={G.tripodLeg} material={mats.metal} position={[0, 0.36, -0.14]} rotation={[-0.35, 0, 0]} />
          <mesh geometry={G.tripodHead} material={mats.dark} position={[0, 0.74, 0]} />
          <mesh geometry={G.scope} material={mats.type} position={[0, 0.8, 0]} rotation={[Math.PI / 2, 0, 0]} />
        </group>
      )}
    </group>
  );
}
