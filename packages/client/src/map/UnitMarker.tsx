import { useCallback, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { hexToWorld, type Project, type Team, type Unit, type UnitTypeDef } from "@hexcommand/shared";
import { Soldier } from "./rigs/Soldier.js";
import { poseSoldier, STATUS_COLORS, type RigParts } from "./rigs/pose.js";

const PLATE = new THREE.CylinderGeometry(0.54, 0.56, 0.08, 6);
const WORK_RING = new THREE.RingGeometry(0.62, 0.69, 28, 1, 0, Math.PI * 1.45);
const TEAM_RING = new THREE.RingGeometry(0.72, 0.77, 6);
const SELECT_RING = new THREE.RingGeometry(0.82, 0.88, 32);
const HOVER_RING = new THREE.RingGeometry(0.82, 0.85, 32);
const BEACON = new THREE.SphereGeometry(0.08, 10, 8);
const BEACON_POLE = new THREE.CylinderGeometry(0.012, 0.012, 0.45, 5);
const FLAG_POLE = new THREE.CylinderGeometry(0.012, 0.012, 0.5, 5);
const FLAG = new THREE.PlaneGeometry(0.22, 0.14);

export interface UnitMarkerProps {
  unit: Unit;
  type: UnitTypeDef;
  project: Project;
  team?: Team;
  selected: boolean;
  hovered: boolean;
  reducedMotion: boolean;
  onSelect: (id: string, multi: boolean) => void;
  onHover: (id: string | null) => void;
}

function hashPhase(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000 * Math.PI * 2;
}

export function UnitMarker({ unit, type, project, team, selected, hovered, reducedMotion, onSelect, onHover }: UnitMarkerProps) {
  const { x, z } = hexToWorld(unit.hex);
  const parts = useRef<RigParts | null>(null);
  const plateMat = useRef<THREE.MeshStandardMaterial>(null);
  const workRing = useRef<THREE.Mesh>(null);
  const beacon = useRef<THREE.Group>(null);
  const flag = useRef<THREE.Mesh>(null);
  const phase = useMemo(() => hashPhase(unit.id), [unit.id]);
  const offline = unit.status === "offline";
  const onParts = useCallback((p: RigParts | null) => {
    parts.current = p;
  }, []);

  const statusColor = STATUS_COLORS[unit.status];
  const beaconColor = unit.status === "waiting" ? "#6fb3f0" : "#f25f5c";

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const p = parts.current;
    if (p) {
      poseSoldier(p, {
        status: unit.status,
        workAnim: type.workAnim,
        t,
        since: (Date.now() - unit.statusSince) / 1000,
        phase,
        reducedMotion,
      });
    }
    if (plateMat.current) {
      plateMat.current.emissiveIntensity = offline ? 0 : unit.status === "working" && !reducedMotion ? 0.55 + 0.35 * Math.sin(t * 3 + phase) : 0.45;
    }
    if (workRing.current && !reducedMotion) workRing.current.rotation.z = -t * 1.6 + phase;
    if (beacon.current && !reducedMotion) beacon.current.position.y = 1.72 + 0.05 * Math.sin(t * 2.5 + phase);
    if (flag.current && !reducedMotion) flag.current.rotation.y = 0.12 * Math.sin(t * 2.2 + phase);
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect(unit.id, e.shiftKey || e.ctrlKey || e.metaKey);
  };

  return (
    <group
      position={[x, 0, z]}
      onClick={handleClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(unit.id);
      }}
      onPointerOut={() => onHover(null)}
    >
      {/* base plate: project identity */}
      <mesh geometry={PLATE} position={[0, 0.04, 0]} receiveShadow castShadow>
        <meshStandardMaterial ref={plateMat} color={offline ? "#4a4f57" : project.flag} emissive={project.flag} emissiveIntensity={0.45} flatShading roughness={0.6} />
      </mesh>

      {/* rings */}
      {unit.status === "working" && (
        <mesh ref={workRing} geometry={WORK_RING} position={[0, 0.095, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color={statusColor} transparent opacity={0.9} side={THREE.DoubleSide} />
        </mesh>
      )}
      {team && (
        <mesh geometry={TEAM_RING} position={[0, 0.085, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 6]}>
          <meshBasicMaterial color={team.color} transparent opacity={0.85} side={THREE.DoubleSide} />
        </mesh>
      )}
      {selected && (
        <mesh geometry={SELECT_RING} position={[0, 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color="#f2d27a" side={THREE.DoubleSide} />
        </mesh>
      )}
      {hovered && !selected && (
        <mesh geometry={HOVER_RING} position={[0, 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color="#f2d27a" transparent opacity={0.45} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* beacon for waiting / error */}
      {(unit.status === "waiting" || unit.status === "error") && (
        <group ref={beacon} position={[0, 1.72, 0]}>
          <mesh geometry={BEACON}>
            <meshStandardMaterial color={beaconColor} emissive={beaconColor} emissiveIntensity={1.4} />
          </mesh>
          <mesh geometry={BEACON_POLE} position={[0, -0.26, 0]}>
            <meshBasicMaterial color={beaconColor} transparent opacity={0.5} />
          </mesh>
          <pointLight color={beaconColor} intensity={1.2} distance={3} decay={2} />
        </group>
      )}

      {/* mission-complete flag */}
      {unit.missionDone && (
        <group position={[-0.42, 0.08, -0.3]}>
          <mesh geometry={FLAG_POLE} position={[0, 0.25, 0]}>
            <meshStandardMaterial color="#c9c2b0" />
          </mesh>
          <mesh ref={flag} geometry={FLAG} position={[0.11, 0.42, 0]}>
            <meshStandardMaterial color={project.flag} emissive={project.flag} emissiveIntensity={0.3} side={THREE.DoubleSide} />
          </mesh>
        </group>
      )}

      <group position={[0, 0.08, 0]}>
        <Soldier type={type} flag={project.flag} offline={offline} onParts={onParts} />
      </group>
    </group>
  );
}
