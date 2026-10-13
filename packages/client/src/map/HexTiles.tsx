import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { hexToWorld, type Hex, type Project } from "@hexcommand/shared";

export const TILE_GEO = new THREE.CylinderGeometry(0.96, 0.99, 0.35, 6);
export const TILE_TOP_Y = 0; // tiles are positioned so their top face sits at y = 0

export interface TileRef {
  project: Project;
  hex: Hex;
}

export interface HexTilesProps {
  projects: Project[];
  hoverKey: string | null;
  onHover: (tile: TileRef | null) => void;
  onClick: (tile: TileRef, e: ThreeEvent<MouseEvent>) => void;
}

const tmpObj = new THREE.Object3D();
const tmpColor = new THREE.Color();

export function HexTiles({ projects, hoverKey, onHover, onClick }: HexTilesProps) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const tiles = useMemo<TileRef[]>(() => projects.flatMap((p) => p.cells.map((hex) => ({ project: p, hex }))), [projects]);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    tiles.forEach((t, i) => {
      const { x, z } = hexToWorld(t.hex);
      tmpObj.position.set(x, -0.175, z);
      tmpObj.rotation.set(0, 0, 0);
      tmpObj.updateMatrix();
      m.setMatrixAt(i, tmpObj.matrix);
      const key = `${t.hex[0]},${t.hex[1]}`;
      tmpColor.set(t.project.tint);
      if (key === hoverKey) tmpColor.lerp(new THREE.Color("#ffffff"), 0.22);
      m.setColorAt(i, tmpColor);
    });
    m.count = tiles.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [tiles, hoverKey]);

  return (
    <instancedMesh
      ref={mesh}
      args={[TILE_GEO, undefined, Math.max(1, tiles.length)]}
      receiveShadow
      castShadow
      onPointerMove={(e) => {
        e.stopPropagation();
        const t = e.instanceId !== undefined ? tiles[e.instanceId] : undefined;
        onHover(t ?? null);
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => {
        const t = e.instanceId !== undefined ? tiles[e.instanceId] : undefined;
        if (t) {
          e.stopPropagation();
          onClick(t, e);
        }
      }}
    >
      <meshStandardMaterial color="#ffffff" flatShading roughness={0.9} metalness={0.02} />
    </instancedMesh>
  );
}
