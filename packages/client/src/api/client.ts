import type {
  BroadcastBody,
  CreateProjectBody,
  CreateTeamBody,
  CreateUnitBody,
  Message,
  OperatorMessageBody,
  Order,
  OrderBody,
  OrderResponse,
  PatchProjectBody,
  PatchSettingsBody,
  PatchTeamBody,
  PatchUnitBody,
  PermissionAnswerBody,
  Project,
  Settings,
  Snapshot,
  Team,
  TranscriptEntry,
  Unit,
} from "@gridcommander/shared";
import { getToken } from "./token.js";

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiClientError(res.status, err?.code ?? "http_error", err?.message ?? `${res.status} ${res.statusText}`);
  }
  return json as T;
}

export const api = {
  state: () => call<Snapshot>("GET", "/state"),
  health: () => call<{ ok: boolean }>("GET", "/health"),
  units: {
    create: (b: CreateUnitBody) => call<Unit>("POST", "/units", b),
    patch: (id: string, b: PatchUnitBody) => call<Unit>("PATCH", `/units/${id}`, b),
    remove: (id: string) => call<void>("DELETE", `/units/${id}`),
    start: (id: string) => call<Unit>("POST", `/units/${id}/start`),
    stop: (id: string) => call<Unit>("POST", `/units/${id}/stop`),
    interrupt: (id: string) => call<Unit>("POST", `/units/${id}/interrupt`),
    ack: (id: string) => call<Unit>("POST", `/units/${id}/ack`),
    compact: (id: string) => call<OrderResponse>("POST", `/units/${id}/compact`),
    order: (id: string, b: OrderBody) => call<OrderResponse>("POST", `/units/${id}/orders`, b),
    orders: (id: string) => call<Order[]>("GET", `/units/${id}/orders`),
    removeOrder: (id: string, orderId: string) => call<void>("DELETE", `/units/${id}/orders/${orderId}`),
    permission: (id: string, b: PermissionAnswerBody) => call<Unit>("POST", `/units/${id}/permission`, b),
    answer: (id: string, answers: Record<string, string>) => call<Unit>("POST", `/units/${id}/answer`, { answers }),
    transcript: (id: string, q: { before?: number; limit?: number } = {}) => {
      const p = new URLSearchParams();
      if (q.before) p.set("before", String(q.before));
      if (q.limit) p.set("limit", String(q.limit));
      return call<{ entries: TranscriptEntry[] }>("GET", `/units/${id}/transcript?${p}`);
    },
    messages: (id: string) => call<{ messages: Message[] }>("GET", `/units/${id}/messages`),
    context: (id: string) => call<{ usage?: number }>("GET", `/units/${id}/context`),
  },
  broadcast: (b: BroadcastBody) => call<{ sent: string[]; queued: string[]; skipped: string[] }>("POST", "/broadcast", b),
  messages: {
    send: (b: OperatorMessageBody) => call<Message>("POST", "/messages", b),
    list: (q: { threadId?: string; unitId?: string } = {}) => {
      const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
      return call<{ messages: Message[] }>("GET", `/messages?${p}`);
    },
  },
  projects: {
    create: (b: CreateProjectBody) => call<Project>("POST", "/projects", b),
    patch: (id: string, b: PatchProjectBody) => call<Project>("PATCH", `/projects/${id}`, b),
    remove: (id: string) => call<void>("DELETE", `/projects/${id}`),
  },
  teams: {
    create: (b: CreateTeamBody) => call<Team>("POST", "/teams", b),
    patch: (id: string, b: PatchTeamBody) => call<Team>("PATCH", `/teams/${id}`, b),
    remove: (id: string) => call<void>("DELETE", `/teams/${id}`),
  },
  alerts: {
    dismiss: (id: string) => call<void>("POST", `/alerts/${id}/dismiss`),
    dismissAll: () => call<{ dismissed: number }>("POST", "/alerts/dismiss-all"),
  },
  settings: {
    patch: (b: PatchSettingsBody) => call<Settings>("PATCH", "/settings", b),
  },
  push: {
    key: () => call<{ key: string | null }>("GET", "/push/vapid-public-key"),
    subscribe: (sub: unknown) => call<{ ok: boolean }>("POST", "/push/subscribe", sub),
    unsubscribe: (endpoint: string) => call<{ removed: boolean }>("DELETE", "/push/subscribe", { endpoint }),
  },
};
