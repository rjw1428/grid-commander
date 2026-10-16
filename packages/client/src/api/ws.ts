import { WsServerEventSchema } from "@gridcommander/shared";
import { useFleet } from "../store/useFleet.js";
import { getToken } from "./token.js";

let socket: WebSocket | null = null;
let attempt = 0;
let timer: number | null = null;
let stopped = false;
let onAuthError: (() => void) | null = null;

export function connectWs(opts: { onAuthError?: () => void } = {}): () => void {
  stopped = false;
  onAuthError = opts.onAuthError ?? null;
  open();
  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    socket?.close();
    socket = null;
  };
}

function open() {
  const token = getToken();
  if (!token) return;
  const st = useFleet.getState();
  st.setConnection("connecting");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  socket = ws;
  let gotSnapshot = false;

  ws.onmessage = (ev) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const parsed = WsServerEventSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[ws] dropped unknown event", parsed.error.issues[0]?.message, raw);
      return;
    }
    if (parsed.data.type === "snapshot") {
      gotSnapshot = true;
      attempt = 0;
      useFleet.getState().setConnection("live");
    }
    useFleet.getState().applyEvent(parsed.data);
  };
  ws.onclose = (ev) => {
    if (socket === ws) socket = null;
    useFleet.getState().setConnection("offline");
    if (stopped) return;
    // 1008 / immediate close without snapshot → most likely a bad token
    if (!gotSnapshot && attempt >= 2 && onAuthError) {
      void fetch("/api/state", { headers: { authorization: `Bearer ${getToken() ?? ""}` } }).then((r) => {
        if (r.status === 401) onAuthError?.();
      });
    }
    void ev;
    schedule();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function schedule() {
  attempt += 1;
  // a hot-reload restart is back within a second: retry fast first, then back off to 30 s
  const delay = Math.min(30_000, 400 * 2 ** Math.min(attempt, 7)) * (0.75 + Math.random() * 0.5);
  timer = window.setTimeout(() => {
    timer = null;
    if (!stopped) open();
  }, delay);
}

export function sendPing() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
}
