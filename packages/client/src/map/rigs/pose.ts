import type { Object3D, MeshStandardMaterial } from "three";
import type { UnitStatus, UnitTypeDef } from "@hexcommand/shared";

export type WorkAnim = UnitTypeDef["workAnim"];

/** Mutable handles into a built soldier rig. All rotations are reset every frame before posing. */
export interface RigParts {
  root: Object3D;
  legL: Object3D;
  legR: Object3D;
  torso: Object3D;
  armL: Object3D;
  armR: Object3D;
  head: Object3D;
  props: Partial<Record<"glint" | "page" | "ping" | "ring0" | "ring1" | "ring2", Object3D>>;
  propMaterials: Partial<Record<"ping" | "ring0" | "ring1" | "ring2", MeshStandardMaterial>>;
}

export interface PoseInput {
  status: UnitStatus;
  workAnim: WorkAnim;
  /** seconds, monotonic */
  t: number;
  /** seconds since the status changed */
  since: number;
  /** per-unit phase offset so a platoon does not move in lockstep */
  phase: number;
  reducedMotion: boolean;
}

const TAU = Math.PI * 2;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function rest(p: RigParts): void {
  p.root.position.set(0, 0, 0);
  p.root.rotation.set(0, 0, 0);
  p.legL.rotation.set(0, 0, 0);
  p.legR.rotation.set(0, 0, 0);
  p.torso.rotation.set(0, 0, 0);
  p.torso.scale.set(1, 1, 1);
  p.armL.rotation.set(0, 0, 0.08);
  p.armR.rotation.set(0, 0, -0.08);
  p.head.rotation.set(0, 0, 0);
  if (p.props.glint) p.props.glint.visible = false;
  if (p.props.page) p.props.page.rotation.set(0, 0, 0);
  if (p.props.ping) p.props.ping.visible = false;
  for (const k of ["ring0", "ring1", "ring2"] as const) {
    const r = p.props[k];
    if (r) r.visible = false;
  }
}

/** Idle: at ease, breathing, occasional look-around. */
function idle(p: RigParts, t: number, phase: number): void {
  p.torso.scale.y = 1 + 0.015 * Math.sin(t * 2 + phase);
  p.armL.rotation.x = 0.05 * Math.sin(t * 1.3 + phase);
  p.armR.rotation.x = -0.05 * Math.sin(t * 1.3 + phase);
  const gate = Math.max(0, Math.sin(t * 0.17 + phase * 0.7));
  p.head.rotation.y = 0.45 * Math.sin(t * 0.6 + phase) * gate;
}

export function poseSoldier(p: RigParts, i: PoseInput): void {
  rest(p);
  const { t, phase } = i;
  if (i.status === "offline") return;
  if (i.reducedMotion) {
    // keep a static, readable pose per status
    if (i.status === "waiting") p.armR.rotation.z = -2.6;
    if (i.status === "working") workStatic(p, i.workAnim);
    return;
  }
  switch (i.status) {
    case "idle":
      idle(p, t, phase);
      return;
    case "waiting": {
      p.armR.rotation.z = -2.6 + 0.08 * Math.sin(t * 5 + phase);
      p.armR.rotation.x = 0.12 * Math.sin(t * 6 + phase);
      p.head.rotation.x = -0.3;
      p.head.rotation.y = 0.5 * Math.sin(t * 1.2 + phase);
      p.torso.scale.y = 1 + 0.01 * Math.sin(t * 2 + phase);
      return;
    }
    case "error": {
      p.root.position.x = 0.025 * Math.sin(t * 38 + phase);
      p.torso.rotation.z = 0.03 * Math.sin(t * 38 + phase + 1);
      p.head.rotation.y = 0.35 * Math.sin(t * 9 + phase);
      p.head.rotation.x = 0.15;
      return;
    }
    case "done": {
      if (i.since < 1.1) {
        const k = smooth(0, 0.25, i.since) * (1 - smooth(0.85, 1.1, i.since));
        p.armR.rotation.x = -2.25 * k;
        p.armR.rotation.z = 0.55 * k;
        p.head.rotation.x = -0.1 * k;
        p.torso.scale.y = 1 + 0.02 * k;
      } else {
        idle(p, t, phase);
      }
      return;
    }
    case "working":
      work(p, i.workAnim, t, phase);
      return;
  }
}

function workStatic(p: RigParts, anim: WorkAnim): void {
  switch (anim) {
    case "survey":
      p.armL.rotation.x = -1.2;
      p.armR.rotation.x = -1.4;
      p.head.rotation.x = 0.3;
      return;
    case "dig":
      p.armR.rotation.x = -1.3;
      p.armL.rotation.x = -1.3;
      return;
    case "sweep":
      p.armL.rotation.set(-1.4, 0, 0.4);
      p.armR.rotation.set(-1.5, 0, -0.2);
      return;
    case "paperwork":
      p.head.rotation.x = 0.55;
      p.armL.rotation.x = -1.5;
      p.armR.rotation.x = -1.4;
      return;
    case "radio":
      p.armR.rotation.set(-2.2, 0, 0.5);
      return;
    case "bark":
      p.armR.rotation.x = -1.5;
      return;
  }
}

function work(p: RigParts, anim: WorkAnim, t: number, phase: number): void {
  switch (anim) {
    case "survey": {
      // scope → calculator keys → reading plans, 8 s cycle
      const ph = (t + phase) % 8;
      if (ph < 3) {
        const k = smooth(0, 0.4, ph) * (1 - smooth(2.6, 3, ph));
        p.torso.rotation.z = -0.28 * k;
        p.head.rotation.z = -0.3 * k;
        p.head.rotation.x = 0.15 * k;
        p.armL.rotation.x = -1.2;
        p.armR.rotation.x = -1.5 * k;
        p.armR.rotation.z = -0.5 * k;
      } else if (ph < 5) {
        p.armL.rotation.x = -1.2;
        p.armR.rotation.x = -1.65 + 0.18 * Math.sin(t * 14 + phase);
        p.armR.rotation.z = 0.35;
        p.head.rotation.x = 0.5;
      } else {
        p.armL.rotation.x = -1.95;
        p.armL.rotation.z = 0.35;
        p.head.rotation.x = 0.45;
        p.head.rotation.y = 0.1 * Math.sin(t * 1.5);
        p.armR.rotation.x = -0.3;
      }
      return;
    }
    case "dig": {
      const s = ((t + phase) % 1.1) / 1.1;
      const c = Math.cos(TAU * s);
      p.armR.rotation.x = -1.05 - 1.55 * c;
      p.armL.rotation.x = -1.05 - 1.55 * c;
      p.armL.rotation.z = 0.35;
      p.armR.rotation.z = -0.35;
      p.torso.rotation.x = 0.18 * (1 - Math.cos(TAU * s + 0.5)) * 0.5 - 0.04;
      p.head.rotation.x = 0.25 + 0.1 * c;
      p.legL.rotation.x = 0.08 * c;
      p.legR.rotation.x = -0.08 * c;
      return;
    }
    case "sweep": {
      p.armL.rotation.set(-1.4, 0, 0.42);
      p.armR.rotation.set(-1.5, 0, -0.22);
      p.head.rotation.x = 0.1;
      p.root.position.y = -0.04;
      const sw = Math.sin(t * 0.8 + phase);
      p.root.rotation.y = 0.65 * sw;
      if (p.props.glint) p.props.glint.visible = Math.abs(sw) > 0.965;
      return;
    }
    case "paperwork": {
      p.head.rotation.x = 0.55;
      p.armL.rotation.x = -1.55;
      p.armL.rotation.z = 0.3;
      p.armR.rotation.x = -1.45;
      p.armR.rotation.z = -0.45;
      const s = ((t + phase) % 1.6) / 1.6;
      if (p.props.page) p.props.page.rotation.y = -Math.PI * smooth(0.2, 0.6, s);
      p.armR.rotation.x += -0.2 * Math.sin(TAU * smooth(0.2, 0.6, s) / 2);
      return;
    }
    case "radio": {
      p.armR.rotation.set(-2.25, 0, 0.55);
      p.head.rotation.z = -0.18;
      const w = t * 0.8 + phase;
      p.root.position.x = 0.28 * Math.sin(w);
      const speed = Math.cos(w);
      p.root.rotation.y = (Math.PI / 2) * Math.tanh(3 * speed);
      const gait = Math.abs(speed);
      p.legL.rotation.x = 0.55 * Math.sin(t * 7 + phase) * gait;
      p.legR.rotation.x = -0.55 * Math.sin(t * 7 + phase) * gait;
      p.armL.rotation.x = 0.4 * Math.sin(t * 7 + phase) * gait;
      const u = (t * 1.4 + phase) % 1;
      if (p.props.ping) {
        p.props.ping.visible = true;
        const sc = 0.2 + u * 1.6;
        p.props.ping.scale.set(sc, sc, sc);
        if (p.propMaterials.ping) p.propMaterials.ping.opacity = 1 - u;
      }
      return;
    }
    case "bark": {
      const s = (t * 1.25 + phase) % 1;
      const jab = Math.max(0, Math.sin(TAU * s));
      p.armR.rotation.x = -1.15 - 0.95 * jab;
      p.armL.rotation.x = -0.25;
      p.armL.rotation.z = 0.3;
      p.head.rotation.y = 0.5 * Math.sin(t * 1.7 + phase);
      p.torso.rotation.y = 0.15 * Math.sin(t * 1.7 + phase);
      p.head.rotation.x = -0.08;
      for (let k = 0; k < 3; k++) {
        const r = p.props[`ring${k as 0 | 1 | 2}`];
        const m = p.propMaterials[`ring${k as 0 | 1 | 2}`];
        if (!r) continue;
        const u = (t * 1.25 + phase + k / 3) % 1;
        r.visible = true;
        const sc = 0.25 + u * 1.1;
        r.scale.set(sc, sc, sc);
        if (m) m.opacity = (1 - u) * 0.9;
      }
      return;
    }
  }
}

/** Status → ground/plate accents, shared by the marker. */
export const STATUS_COLORS: Record<UnitStatus, string> = {
  offline: "#5f6a75",
  idle: "#b8c0c8",
  working: "#7fd68a",
  waiting: "#6fb3f0",
  done: "#d4a73a",
  error: "#f25f5c",
};
