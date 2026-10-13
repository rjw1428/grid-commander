import type { UnitStatus } from "@hexcommand/shared";

/**
 * Events that drive a unit's status. Pure data; the runtime and services emit them.
 * See docs/02-domain-model.md "Status machine".
 */
export type StatusEvent =
  | { type: "init" } // system/init received
  | { type: "submit" } // a user turn was submitted (order, queue, inbox)
  | { type: "wait" } // canUseTool / AskUserQuestion / elicitation
  | { type: "answered" } // operator answered the pending prompt
  | { type: "result"; ok: boolean } // turn finished
  | { type: "ack" } // operator acknowledged done/error
  | { type: "stop" } // operator stop or clean process exit
  | { type: "crash" }; // generator threw / process died

export function nextStatus(current: UnitStatus, event: StatusEvent): UnitStatus {
  switch (event.type) {
    case "stop":
      return "offline";
    case "crash":
      return current === "working" || current === "waiting" ? "error" : "offline";
    case "init":
      return current === "offline" ? "idle" : current;
    case "submit":
      return current === "offline" ? current : "working";
    case "wait":
      return current === "working" ? "waiting" : current;
    case "answered":
      return current === "waiting" ? "working" : current;
    case "result":
      if (current === "working" || current === "waiting") return event.ok ? "done" : "error";
      return current;
    case "ack":
      return current === "done" || current === "error" ? "idle" : current;
  }
}

/** Statuses from which a new user turn may be submitted immediately. */
export function canAcceptTurn(status: UnitStatus): boolean {
  return status === "idle" || status === "done" || status === "error";
}

export function isBusy(status: UnitStatus): boolean {
  return status === "working" || status === "waiting";
}
