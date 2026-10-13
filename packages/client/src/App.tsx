import { UNIT_TYPES } from "@hexcommand/shared";

export function App() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: 24, background: "#0b0f14", color: "#e8e3d3", minHeight: "100vh" }}>
      <h1>Hex Command</h1>
      <p>M0 scaffold. {UNIT_TYPES.length} unit types loaded.</p>
    </main>
  );
}
