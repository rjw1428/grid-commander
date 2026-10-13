import type { Hex } from "./domain.js";

/** Pointy-top axial coordinates. world x = sqrt3 * (q + r/2) * size, world z = 1.5 * r * size. */
export const SQRT3 = Math.sqrt(3);

export function hexToWorld([q, r]: Hex, size = 1): { x: number; z: number } {
  return { x: SQRT3 * (q + r / 2) * size, z: 1.5 * r * size };
}

export function hexKey([q, r]: Hex): string {
  return `${q},${r}`;
}

export function parseHexKey(key: string): Hex {
  const [q, r] = key.split(",").map(Number);
  if (q === undefined || r === undefined || Number.isNaN(q) || Number.isNaN(r)) {
    throw new Error(`bad hex key: ${key}`);
  }
  return [q, r];
}

export function hexEquals(a: Hex, b: Hex): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export const HEX_DIRECTIONS: readonly Hex[] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

export function hexNeighbors([q, r]: Hex): Hex[] {
  return HEX_DIRECTIONS.map(([dq, dr]) => [q + dq, r + dr]);
}

export function hexDistance(a: Hex, b: Hex): number {
  const dq = a[0] - b[0];
  const dr = a[1] - b[1];
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}
