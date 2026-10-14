import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { hexKey, hexToWorld, type Hex } from "@gridcommander/shared";
import { TILE_GEO } from "./HexTiles.js";

const tmpObj = new THREE.Object3D();
const tmpColor = new THREE.Color();

/** Translucent candidate tiles shown in territory mode; click one to claim it. */
export function GhostTiles({ cells, tint, hoverKey, onHover, onClick }: { cells: Hex[]; tint: string; hoverKey: string | null; onHover: (hex: Hex | null) => void; onClick: (hex: Hex) => void }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const keyed = useMemo(() => cells.map((hex) => ({ hex, key: hexKey(hex) })), [cells]);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    keyed.forEach((t, i) => {
      const { x, z } = hexToWorld(t.hex);
      tmpObj.position.set(x, -0.26, z);
      tmpObj.scale.set(0.92, 0.5, 0.92);
      tmpObj.updateMatrix();
      m.setMatrixAt(i, tmpObj.matrix);
      tmpColor.set(tint).lerp(new THREE.Color("#ffffff"), t.key === hoverKey ? 0.6 : 0.3);
      m.setColorAt(i, tmpColor);
    });
    m.count = keyed.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [keyed, tint, hoverKey]);

  if (!keyed.length) return null;
  return (
    <instancedMesh
      ref={mesh}
      args={[TILE_GEO, undefined, Math.max(1, keyed.length)]}
      onPointerMove={(e) => {
        e.stopPropagation();
        onHover(e.instanceId !== undefined ? (keyed[e.instanceId]?.hex ?? null) : null);
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => {
        const t = e.instanceId !== undefined ? keyed[e.instanceId] : undefined;
        if (t) {
          e.stopPropagation();
          onClick(t.hex);
        }
      }}
    >
      <meshStandardMaterial color="#ffffff" flatShading transparent opacity={0.45} roughness={0.9} depthWrite={false} />
    </instancedMesh>
  );
}
