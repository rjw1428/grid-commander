import { useCallback, useEffect, useState } from "react";
import { connectWs } from "./api/ws.js";
import { getToken, setToken } from "./api/token.js";
import { Scene } from "./map/Scene.js";
import { useFleet } from "./store/useFleet.js";
import { Header } from "./ui/Header.js";
import { SidePanel } from "./ui/SidePanel.js";
import { TokenGate } from "./ui/TokenGate.js";
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

  // keyboard: Esc clears, L toggles legend
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") useFleet.getState().clearSelection();
      if (e.key.toLowerCase() === "l") toggleLegend();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const toggleLegend = useCallback(() => {
    const p = useFleet.getState().panel;
    setPanel(p.kind === "legend" ? { kind: "none" } : { kind: "legend" });
  }, [setPanel]);

  if (!hasToken) return <TokenGate onDone={() => setHasToken(true)} error={authError} />;

  return (
    <div className={`app${mobile ? " mobile" : ""}`}>
      <Header onLegend={toggleLegend} legendOpen={panel.kind === "legend"} />
      <main className="stage">
        {hasSnapshot ? <Scene mobile={mobile} /> : <div className="empty" style={{ padding: 24 }}>Connecting to the fleet server…</div>}
        <SidePanel />
      </main>
      <Tray />
    </div>
  );
}
