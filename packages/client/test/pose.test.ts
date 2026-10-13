import { describe, expect, it } from "vitest";
import { Group, Mesh, MeshStandardMaterial } from "three";
import { poseSoldier, type RigParts, STATUS_COLORS } from "../src/map/rigs/pose.js";
import type { UnitStatus, UnitTypeDef } from "@hexcommand/shared";

function rig(): RigParts {
  const g = () => new Group();
  const ringMat = () => new MeshStandardMaterial({ transparent: true });
  const glint = new Mesh();
  const page = g();
  const ping = new Mesh();
  const ring0 = new Mesh();
  const ring1 = new Mesh();
  const ring2 = new Mesh();
  return {
    root: g(),
    legL: g(),
    legR: g(),
    torso: g(),
    armL: g(),
    armR: g(),
    head: g(),
    props: { glint, page, ping, ring0, ring1, ring2 },
    propMaterials: { ping: ringMat(), ring0: ringMat(), ring1: ringMat(), ring2: ringMat() },
  };
}
const base = { t: 1.3, since: 5, phase: 0.4, reducedMotion: false };
const anims: UnitTypeDef["workAnim"][] = ["survey", "dig", "sweep", "paperwork", "radio", "bark"];

describe("poseSoldier", () => {
  it("offline is the rest pose, no motion", () => {
    const p = rig();
    poseSoldier(p, { ...base, status: "offline", workAnim: "dig" });
    expect(p.armR.rotation.x).toBe(0);
    expect(p.head.rotation.y).toBe(0);
    expect(p.root.position.x).toBe(0);
  });
  it("waiting raises the right hand and looks up", () => {
    const p = rig();
    poseSoldier(p, { ...base, status: "waiting", workAnim: "dig" });
    expect(p.armR.rotation.z).toBeLessThan(-2.4);
    expect(p.head.rotation.x).toBeLessThan(0);
  });
  it("error shudders and shakes the head", () => {
    const p = rig();
    poseSoldier(p, { ...base, status: "error", workAnim: "dig", t: 0.05 });
    expect(Math.abs(p.root.position.x)).toBeGreaterThan(0);
    expect(Math.abs(p.head.rotation.y)).toBeGreaterThan(0);
  });
  it("done salutes for one second, then stands at ease", () => {
    const p = rig();
    poseSoldier(p, { ...base, status: "done", workAnim: "dig", since: 0.5 });
    expect(p.armR.rotation.x).toBeLessThan(-2);
    poseSoldier(p, { ...base, status: "done", workAnim: "dig", since: 3 });
    expect(Math.abs(p.armR.rotation.x)).toBeLessThan(0.1);
  });
  it("each work animation moves the rig and resets between frames", () => {
    for (const a of anims) {
      const p = rig();
      poseSoldier(p, { ...base, status: "working", workAnim: a });
      const moved = Math.abs(p.armR.rotation.x) + Math.abs(p.armL.rotation.x) + Math.abs(p.head.rotation.x) + Math.abs(p.root.rotation.y);
      expect(moved, a).toBeGreaterThan(0.1);
      poseSoldier(p, { ...base, status: "offline", workAnim: a });
      expect(p.armR.rotation.x, `${a} reset`).toBe(0);
    }
  });
  it("sweep glints at the ends of the arc; bark and radio drive rings", () => {
    const p = rig();
    // sin(0.8 t + phase) ≈ 1 when 0.8t + phase = π/2
    const tPeak = (Math.PI / 2 - base.phase) / 0.8;
    poseSoldier(p, { ...base, status: "working", workAnim: "sweep", t: tPeak });
    expect(p.props.glint!.visible).toBe(true);
    poseSoldier(p, { ...base, status: "working", workAnim: "sweep", t: tPeak + 2 });
    expect(p.props.glint!.visible).toBe(false);
    poseSoldier(p, { ...base, status: "working", workAnim: "bark" });
    expect(p.props.ring0!.visible && p.props.ring1!.visible && p.props.ring2!.visible).toBe(true);
    poseSoldier(p, { ...base, status: "working", workAnim: "radio" });
    expect(p.props.ping!.visible).toBe(true);
    expect(p.propMaterials.ping!.opacity).toBeLessThanOrEqual(1);
  });
  it("reduced motion keeps a static readable pose", () => {
    const p = rig();
    poseSoldier(p, { ...base, status: "working", workAnim: "dig", reducedMotion: true });
    const a = p.armR.rotation.x;
    poseSoldier(p, { ...base, status: "working", workAnim: "dig", reducedMotion: true, t: 9 });
    expect(p.armR.rotation.x).toBe(a);
  });
  it("every status has a colour", () => {
    const all: UnitStatus[] = ["offline", "idle", "working", "waiting", "done", "error"];
    for (const s of all) expect(STATUS_COLORS[s]).toMatch(/^#/);
  });
});
