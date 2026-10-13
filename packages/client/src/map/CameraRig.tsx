import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { hexToWorld, type Hex } from "@gridcommander/shared";
import { useFleet } from "../store/useFleet.js";

export interface CameraState {
  target: THREE.Vector3;
  distance: number;
  yaw: number;
  pitch: number;
}

const MIN_D = 8;
const MAX_D = 40;
const MIN_P = 0.35;
const MAX_P = 1.45;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export interface CameraRigProps {
  initialTarget: { x: number; z: number };
  /** Extra screen-space offset (px) to keep the focused unit above a bottom sheet. */
  focusOffsetY?: number;
}

/** Orbit camera: mouse (drag pan, right/shift drag rotate, wheel zoom) + touch (1 pan, pinch zoom, 2-finger drag rotate). */
export function CameraRig({ initialTarget, focusOffsetY = 0 }: CameraRigProps) {
  const { camera, gl, size } = useThree();
  const goal = useRef<CameraState>({ target: new THREE.Vector3(initialTarget.x, 0, initialTarget.z), distance: 22, yaw: 0, pitch: 0.95 });
  const cur = useRef<CameraState>({ target: goal.current.target.clone(), distance: 30, yaw: 0.2, pitch: 1.1 });
  const focus = useFleet((s) => s.focus);
  const lastFocusSeq = useRef(0);

  // fly to the requested unit/project
  useEffect(() => {
    if (!focus || focus.seq === lastFocusSeq.current) return;
    lastFocusSeq.current = focus.seq;
    const st = useFleet.getState();
    let hex: Hex | undefined;
    if (focus.unitId) hex = st.units[focus.unitId]?.hex;
    else if (focus.projectId) {
      const p = st.projects[focus.projectId];
      if (p?.cells.length) {
        const w = p.cells.map((c) => hexToWorld(c));
        const x = w.reduce((a, b) => a + b.x, 0) / w.length;
        const z = w.reduce((a, b) => a + b.z, 0) / w.length;
        goal.current.target.set(x, 0, z);
        goal.current.distance = clamp(Math.max(goal.current.distance, 16), MIN_D, MAX_D);
        return;
      }
    }
    if (!hex) return;
    const w = hexToWorld(hex);
    goal.current.target.set(w.x, 0, w.z);
    goal.current.distance = clamp(Math.min(goal.current.distance, 12), MIN_D, MAX_D);
    if (focusOffsetY) {
      // nudge the target toward the camera so the unit lands above the sheet
      const fwd = new THREE.Vector3(Math.sin(goal.current.yaw), 0, Math.cos(goal.current.yaw));
      const worldPerPx = (2 * goal.current.distance * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360)) / size.height;
      goal.current.target.addScaledVector(fwd, focusOffsetY * worldPerPx * 0.8);
    }
  }, [focus, camera, size.height, focusOffsetY]);

  useEffect(() => {
    const el = gl.domElement;
    const pointers = new Map<number, { x: number; y: number }>();
    let lastPinch = 0;
    let lastMid: { x: number; y: number } | null = null;
    let moved = false;

    const pan = (dx: number, dy: number) => {
      const g = goal.current;
      const scale = (g.distance * 0.0016) / Math.max(0.35, Math.sin(g.pitch));
      const right = new THREE.Vector3(Math.cos(g.yaw), 0, -Math.sin(g.yaw));
      const fwd = new THREE.Vector3(-Math.sin(g.yaw), 0, -Math.cos(g.yaw));
      g.target.addScaledVector(right, -dx * scale);
      g.target.addScaledVector(fwd, dy * scale * 1.1);
      g.target.x = clamp(g.target.x, -80, 80);
      g.target.z = clamp(g.target.z, -80, 80);
    };
    const rotate = (dx: number, dy: number) => {
      const g = goal.current;
      g.yaw -= dx * 0.006;
      g.pitch = clamp(g.pitch + dy * 0.005, MIN_P, MAX_P);
    };
    const zoom = (factor: number) => {
      goal.current.distance = clamp(goal.current.distance * factor, MIN_D, MAX_D);
    };

    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        lastPinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        lastMid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (pointers.size === 1) {
        const rotateMode = e.pointerType === "mouse" && (e.buttons & 2 || e.buttons & 4 || e.shiftKey);
        if (rotateMode) rotate(dx, dy);
        else if (e.buttons & 1 || e.pointerType !== "mouse") pan(dx, dy);
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (lastPinch > 0) zoom(lastPinch / pinch);
        lastPinch = pinch;
        const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        if (lastMid) rotate(mid.x - lastMid.x, mid.y - lastMid.y);
        lastMid = mid;
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      if (pointers.size < 2) {
        lastPinch = 0;
        lastMid = null;
      }
      if (moved) {
        // swallow the synthetic click that follows a drag so selection is not cleared
        const stop = (ev: Event) => {
          ev.stopPropagation();
          el.removeEventListener("click", stop, true);
        };
        el.addEventListener("click", stop, true);
        setTimeout(() => el.removeEventListener("click", stop, true), 0);
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(Math.exp(e.deltaY * 0.0012));
    };
    const onCtx = (e: Event) => e.preventDefault();
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const step = 40;
      if (e.key === "ArrowLeft") pan(step, 0);
      else if (e.key === "ArrowRight") pan(-step, 0);
      else if (e.key === "ArrowUp") pan(0, step);
      else if (e.key === "ArrowDown") pan(0, -step);
      else if (e.key === "-" || e.key === "_") zoom(1.15);
      else if (e.key === "=" || e.key === "+") zoom(1 / 1.15);
      else if (e.key === "[") rotate(-30, 0);
      else if (e.key === "]") rotate(30, 0);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", onCtx);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("keydown", onKey);
    };
  }, [gl]);

  useFrame((_, dt) => {
    const k = 1 - Math.exp(-dt * 8);
    const c = cur.current;
    const g = goal.current;
    c.target.lerp(g.target, k);
    c.distance += (g.distance - c.distance) * k;
    c.yaw += (g.yaw - c.yaw) * k;
    c.pitch += (g.pitch - c.pitch) * k;
    const cp = Math.cos(c.pitch);
    camera.position.set(c.target.x + c.distance * Math.sin(c.yaw) * cp, c.target.y + c.distance * Math.sin(c.pitch), c.target.z + c.distance * Math.cos(c.yaw) * cp);
    camera.lookAt(c.target);
    camera.userData.target = c.target;
    if (import.meta.env.DEV || (window as unknown as { __hcDebug?: boolean }).__hcDebug) (window as unknown as { __hc?: unknown }).__hc = { camera, cur: c, goal: g };
  });

  return null;
}
