import { useCallback, useEffect, useState } from "react";
import { connectWs } from "./api/ws.js";
import { api } from "./api/client.js";
import { getToken, setToken } from "./api/token.js";
import { Scene } from "./map/Scene.js";
import type { TileRef } from "./map/HexTiles.js";
import type { Hex } from "@gridcommander/shared";
import { removeBlocker } from "./util/territory.js";
import { persistSnapshots, registerPwa, restoreSnapshotIfOffline } from "./pwa.js";
import { selectCanCommand, useFleet } from "./store/useFleet.js";
import { AlertStack, useAlertSounds } from "./ui/AlertStack.js";
import { CommandBar, useCommands } from "./ui/CommandBar.js";
import { Header } from "./ui/Header.js";
import { SidePanel } from "./ui/SidePanel.js";
import { TokenGate } from "./ui/TokenGate.js";
import { Toasts, reportError } from "./ui/Toasts.js";
import { Tray } from "./ui/Tray.js";
import { Banner } from "./ui/mobile/Banner.js";
import { Sheet } from "./ui/mobile/Sheet.js";
import { TabBar } from "./ui/mobile/TabBar.js";
import { useIsMobile } from "./util/useIsMobile.js";
import "./theme.css";

export function App() {
  const [hasToken, setHasToken] = useState(() => Boolean(getToken()));
  const [authError, setAuthError] = useState<string | undefined>();
  const mobile = useIsMobile();
  const panel = useFleet((s) => s.panel);
  const setPanel = useFleet((s) => s.setPanel);
  const hasSnapshot = useFleet((s) => s.hasSnapshot);
  const mode = useFleet((s) => s.mode);
  const sheet = useFleet((s) => s.sheet);
  const canCommand = useFleet(selectCanCommand);
  const projectCount = useFleet((s) => Object.keys(s.projects).length);
  const commands = useCommands();
  useAlertSounds();

  useEffect(() => {
    void registerPwa();
    return persistSnapshots();
  }, []);

  useEffect(() => {
    if (!hasToken) return;
    void restoreSnapshotIfOffline();
    return connectWs({
      onAuthError: () => {
        setToken(null);
        setAuthError("That token was rejected by the server.");
        setHasToken(false);
      },
    });
  }, [hasToken]);

  const toggleLegend = useCallback(() => {
    const p = useFleet.getState().panel;
    setPanel(p.kind === "legend" ? { kind: "none" } : { kind: "legend" });
  }, [setPanel]);

  // deep link: /#unit-<id>
  useEffect(() => {
    if (!hasSnapshot) return;
    const m = /^#unit-(.+)$/.exec(location.hash);
    if (m && useFleet.getState().units[m[1]!]) {
      useFleet.getState().select([m[1]!]);
      useFleet.getState().focusUnit(m[1]!);
      history.replaceState({}, "", location.pathname);
    }
  }, [hasSnapshot]);

  // keyboard
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const s = useFleet.getState();
      switch (e.key) {
        case "Escape":
          if (s.mode === "move") s.exitMove();
          else if (s.mode === "territory") s.exitTerritory();
          else if (s.selection.length === 1 && (s.units[s.selection[0]!]?.status === "working" || s.units[s.selection[0]!]?.status === "waiting")) {
            api.units.interrupt(s.selection[0]!).catch(reportError);
          } else {
            s.clearSelection();
            s.setPanel({ kind: "none" });
          }
          return;
        case "n":
        case "N":
        case " ":
          e.preventDefault();
          commands.nextOrders();
          return;
        case "r":
        case "R":
          commands.recruit();
          return;
        case "b":
        case "B":
          commands.broadcast();
          return;
        case "m":
        case "M":
          commands.move();
          return;
        case "l":
        case "L":
          toggleLegend();
          return;
        case "p":
        case "P":
          commands.newProject();
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [commands, toggleLegend]);

  // territory mode: a ghost click claims the hex for the project being edited
  const onGhostClick = useCallback((hex: Hex) => {
    const s = useFleet.getState();
    const p = s.territoryProjectId ? s.projects[s.territoryProjectId] : undefined;
    if (!p) return;
    api.projects.patch(p.id, { cells: [...p.cells, hex] }).catch(reportError);
  }, []);

  // move mode: a tile click relocates the unit being moved; territory mode: an own tile click releases it
  const onTileClick = useCallback((tile: TileRef) => {
    const s = useFleet.getState();
    if (s.mode === "territory") {
      const p = s.territoryProjectId ? s.projects[s.territoryProjectId] : undefined;
      if (!p) return false;
      if (tile.project.id !== p.id) {
        s.toast({ kind: "error", text: `That hex belongs to ${tile.project.name}.` });
        return true;
      }
      const why = removeBlocker(p, tile.hex, Object.values(s.units));
      if (why) {
        s.toast({ kind: "error", text: why });
        return true;
      }
      const key = `${tile.hex[0]},${tile.hex[1]}`;
      api.projects.patch(p.id, { cells: p.cells.filter((c) => `${c[0]},${c[1]}` !== key) }).catch(reportError);
      return true;
    }
    if (s.mode !== "move" || !s.moveUnitId) return false;
    const unit = s.units[s.moveUnitId];
    if (!unit) return false;
    const occupied = Object.values(s.units).find((u) => u.hex[0] === tile.hex[0] && u.hex[1] === tile.hex[1] && u.id !== unit.id);
    if (occupied) {
      s.toast({ kind: "error", text: `${occupied.name} is already on that hex.` });
      return true;
    }
    const body = tile.project.id === unit.projectId ? { hex: tile.hex } : { projectId: tile.project.id, hex: tile.hex };
    api.units
      .patch(unit.id, body)
      .then(() => {
        s.toast({ kind: "ok", text: `${unit.name} moved${tile.project.id !== unit.projectId ? ` to ${tile.project.name}` : ""}.` });
        s.exitMove();
        s.select([unit.id]);
      })
      .catch(reportError);
    return true;
  }, []);

  if (!hasToken) return <TokenGate onDone={() => setHasToken(true)} error={authError} />;

  const sheetOpen = mobile && sheet !== "closed" && !(sheet === "detail" && panel.kind === "none");
  const sheetPx = sheetOpen ? Math.round(window.innerHeight * (sheet === "detail" ? 0.52 : 0.78)) : 0;

  return (
    <div className={`app${mobile ? " mobile" : ""}${mode === "move" ? " move-mode" : ""}${mode === "territory" ? " territory-mode" : ""}${canCommand ? "" : " readonly"}`}>
      <Header onLegend={toggleLegend} legendOpen={panel.kind === "legend"} compact={mobile} />
      <main className="stage">
        {hasSnapshot ? <Scene mobile={mobile} onTileClick={onTileClick} onGhostClick={onGhostClick} focusOffsetY={mobile ? sheetPx / 2 : 0} /> : <div className="empty" style={{ padding: 24 }}>Connecting to the fleet server…</div>}
        {hasSnapshot && projectCount === 0 && panel.kind !== "newProject" && (
          <div className="empty-state" role="region" aria-label="no projects">
            <h2>Open water</h2>
            <p>No projects yet. Found one to claim territory, then recruit units into it.</p>
            <button type="button" className="btn" onClick={() => commands.newProject()} disabled={!canCommand}>
              Found the first project
            </button>
          </div>
        )}
        {!mobile && <CommandBar />}
        {!mobile && <AlertStack shifted={panel.kind !== "none"} />}
        {!mobile && <SidePanel />}
        {mobile && <Banner />}
        {mobile && <Sheet />}
        <Toasts />
        {mode === "move" && <div className="mode-banner">Move mode: {mobile ? "tap" : "click"} a free hex · {mobile ? "" : "Esc to cancel"}</div>}
        {mode === "territory" && <div className="mode-banner">Territory mode: {mobile ? "tap" : "click"} a faint hex to claim it, an owned hex to release it{mobile ? "" : " · Esc to finish"}</div>}
        {!canCommand && hasSnapshot && <div className="mode-banner offline">Offline: showing the last known state, commands disabled</div>}
      </main>
      {mobile ? <TabBar /> : <Tray />}
    </div>
  );
}
