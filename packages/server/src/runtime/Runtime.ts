import type {
  OrderSource,
  PendingQuestion,
  PermissionMode,
  PermissionRequest,
  TranscriptEntry,
  UnitStatus,
} from "@gridcommander/shared";

export interface TurnResult {
  ok: boolean;
  text: string;
  costUsd?: number;
  durationMs?: number;
  interrupted?: boolean;
  errors?: string[];
  at: number;
}

export interface InitInfo {
  sessionId: string;
  model: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  permissionMode?: string;
}

export interface PermissionAnswer {
  allow: boolean;
  updatedInput?: Record<string, unknown>;
  remember?: boolean;
  message?: string;
}

/** Events a Runtime emits. Payloads are domain-typed; nothing SDK-specific leaks out. */
export interface RuntimeEvents {
  status: (status: UnitStatus, at: number) => void;
  activity: (activity: string | undefined) => void;
  transcript: (entries: TranscriptEntry[]) => void;
  toolResult: (r: { toolUseId: string; ok: boolean; at: number }) => void;
  permission: (request: PermissionRequest | null) => void;
  question: (question: PendingQuestion | null) => void;
  init: (info: InitInfo) => void;
  result: (result: TurnResult) => void;
  /** last_assistant_message from the Stop hook, when the hook fires. */
  stopCapture: (text: string) => void;
  /** Repeated API retries, rate limits and similar: surface as info alerts. */
  notice: (text: string, severity: "info" | "error") => void;
  exit: (error?: Error) => void;
}

/**
 * Abstract runtime so a TmuxRuntime (or others) can be added later without touching services.
 * Exactly one turn is in flight at a time; queuing lives above the runtime in OrderService.
 */
export interface Runtime {
  readonly unitId: string;
  readonly status: UnitStatus;
  readonly sessionId: string | undefined;
  readonly inFlight: boolean;

  on<K extends keyof RuntimeEvents>(event: K, listener: RuntimeEvents[K]): () => void;

  /**
   * Spawn (or resume) the session. Resolves once the SDK process is up and has not failed within a
   * short grace window. In streaming-input mode the SDK emits system/init only after the first user
   * turn, so InitInfo (session id, tools, MCP status) arrives later via the "init" event.
   */
  start(): Promise<void>;
  /** Close the session. sessionId is retained for resume. */
  stop(): Promise<void>;
  /** Submit one user turn. Resolves with the result of that turn. Rejects if a turn is already in flight. */
  submit(text: string, source: OrderSource): Promise<TurnResult>;
  /** Interrupt the in-flight turn. Resolves once the interrupted result has arrived (or immediately if idle). */
  interrupt(): Promise<void>;
  answerPermission(answer: PermissionAnswer): boolean;
  answerQuestion(answers: Record<string, string>): boolean;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Context window usage 0..1, when the runtime can report it. */
  contextUsage(): Promise<number | undefined>;
}
