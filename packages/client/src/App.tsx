import { useCallback, useEffect, useState } from "react";
import { connectWs } from "./api/ws.js";
import { api } from "./api/client.js";
import { getToken, setToken } from "./api/token.js";
import { Scene } from "./map/Scene.js";
import type { TileRef } from "./map/HexTiles.js";
import { useFleet } from "./store/useFleet.js";
import { AlertStack, useAlertSounds } from "./ui/AlertStack.js";
import { CommandBar, useCommands } from "./ui/CommandBar.js";
import { Header } from "./ui/Header.js";
import { SidePanel } from "./ui/SidePanel.js";
import { TokenGate } from "./ui/TokenGate.js";
import { Toasts, reportError } from "./ui/Toasts.js";
import { Tray } from "./ui/Tray.js";
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
  const commands = useCommands();
  useAlertSounds();

  useEffect(() => {
    if (!hasToken) return;
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
        default:
          return;
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [commands, toggleLegend]);

  // move mode: a tile click relocates the unit being moved
  const onTileClick = useCallback(
    (tile: TileRef) => {
      const s = useFleet.getState();
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
    },
    [],
  );

  if (!hasToken) return <TokenGate onDone={() => setHasToken(true)} error={authError} />;

  return (
    <div className={`app${mobile ? " mobile" : ""}${mode === "move" ? " move-mode" : ""}`}>
      <Header onLegend={toggleLegend} legendOpen={panel.kind === "legend"} />
      <main className="stage">
        {hasSnapshot ? <Scene mobile={mobile} onTileClick={onTileClick} /> : <div className="empty" style={{ padding: 24 }}>Connecting to the fleet server…</div>}
        {!mobile && <CommandBar />}
        <AlertStack shifted={panel.kind !== "none"} />
        <SidePanel />
        <Toasts />
        {mode === "move" && <div className="mode-banner">Move mode: click a free hex · Esc to cancel</div>}
      </main>
      <Tray />
    </div>
  );
}
