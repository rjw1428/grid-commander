import { get, set } from "idb-keyval";
import type { Snapshot } from "@gridcommander/shared";
import { SnapshotSchema } from "@gridcommander/shared";
import { useFleet } from "./store/useFleet.js";

const SNAP_KEY = "gridcommander.snapshot";

/** Registers the service worker (production builds only) and listens for notification deep links. */
export async function registerPwa(): Promise<void> {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  try {
    const { registerSW } = await import("virtual:pwa-register");
    registerSW({ immediate: true });
    navigator.serviceWorker.addEventListener("message", (ev) => {
      const d = ev.data as { type?: string; url?: string } | undefined;
      if (d?.type === "open-url" && d.url) {
        const m = /#unit-(.+)$/.exec(d.url);
        if (m) {
          const s = useFleet.getState();
          s.select([m[1]!]);
          s.focusUnit(m[1]!);
        }
      }
    });
  } catch (err) {
    console.warn("[pwa] service worker registration failed", err);
  }
}

/** Persist the latest snapshot so the app can open offline. */
export function persistSnapshots(): () => void {
  let last = 0;
  return useFleet.subscribe((st, prev) => {
    if (!st.hasSnapshot || st.units === prev.units && st.alerts === prev.alerts && st.projects === prev.projects) return;
    const now = Date.now();
    if (now - last < 2000) return; // throttle writes
    last = now;
    const snap: Snapshot = {
      projects: Object.values(st.projects),
      teams: Object.values(st.teams),
      units: Object.values(st.units),
      alerts: Object.values(st.alerts),
      unitTypes: Object.values(st.unitTypes),
      settings: st.settings ?? SnapshotSchema.shape.settings.parse({}),
      server: st.server ?? { version: "?", uptime: 0, runningUnits: 0, maxUnits: 0, pushEnabled: false, hasHq: false },
    };
    set(SNAP_KEY, { at: now, snap }).catch(() => {});
  });
}

/** If no live snapshot arrives quickly, show the cached one (marked offline). */
export async function restoreSnapshotIfOffline(afterMs = 2500): Promise<void> {
  await new Promise((r) => setTimeout(r, afterMs));
  const st = useFleet.getState();
  if (st.hasSnapshot) return;
  try {
    const cached = await get<{ at: number; snap: unknown }>(SNAP_KEY);
    if (!cached) return;
    const parsed = SnapshotSchema.safeParse(cached.snap);
    if (!parsed.success) return;
    if (useFleet.getState().hasSnapshot) return;
    useFleet.getState().applySnapshot(parsed.data);
    useFleet.getState().setConnection("offline");
    useFleet.getState().setCachedAt(cached.at);
  } catch {
    /* no cache */
  }
}

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
