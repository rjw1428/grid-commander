import { useState } from "react";
import { setToken } from "../api/token.js";

export function TokenGate({ onDone, error }: { onDone: () => void; error?: string }) {
  const [value, setValue] = useState("");
  return (
    <div className="gate">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setToken(value.trim());
          onDone();
        }}
      >
        <h1>Grid Commander</h1>
        <p>Enter the fleet token (FLEET_TOKEN on the server). It is kept in this browser only.</p>
        <input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="fleet token" aria-label="fleet token" />
        {error && <div className="err">{error}</div>}
        <button type="submit" className="btn">
          Connect
        </button>
      </form>
    </div>
  );
}
