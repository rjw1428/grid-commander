import type { WsServerEvent } from "@gridcommander/shared";
import { Emitter } from "./runtime/emitter.js";

/** Server-wide event bus: services publish WS events; the WS layer fans them out to clients. */
export class Bus extends Emitter<{ event: (e: WsServerEvent) => void }> {
  publish(e: WsServerEvent): void {
    this.emit("event", e);
  }
}
