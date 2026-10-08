import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type { BridgeCall } from "./bridge.js";
import { deliverySchema, directorySchema, snapshotSchema, type Snapshot } from "./contracts.js";

const supported = ["prompt.message", "session.list", "session.persistence"] as const;
interface Session {
  threadId?: string;
  project: string;
  cwd: string;
  items: Map<string, string>;
  pending?: {
    clientMessageId: string;
    text: string;
    turnId: string;
    baseline: Set<string>;
    nativeTurn?: string;
    creation?: string;
  };
  timer?: ReturnType<typeof setTimeout>;
  notice?: string;
  stopped: boolean;
}

export function createDesktopProvider(call: BridgeCall): ProviderRegistration {
  return {
    id: "codex-desktop",
    label: "Codex Desktop",
    description: "继续当前 Desktop 会话（bridge）",
    async status() {
      try {
        await call({ action: "directory" }, directorySchema);
        return { available: true };
      } catch (error) {
        return { available: false, diagnostic: String(error) };
      }
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("需要 provider protocol v1");
      return connection(call, negotiateProviderCapabilities(request.capabilities, supported));
    },
  };
}

function connection(call: BridgeCall, capabilities: readonly string[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };
  const persist = (id: string, session: Session) => {
    const data: { project: string; threadId?: string; requestId?: string } = {
      project: session.project,
    };
    if (session.threadId) data.threadId = session.threadId;
    else if (session.pending?.creation) data.requestId = session.pending.creation;
    emit({
      type: "session.persistence",
      sessionId: id,
      persistence: { version: 1, data },
    });
  };
  const publish = (id: string, session: Session, snapshot: Snapshot) => {
    for (const entry of snapshot.items) {
      const item = { ...entry.item };
      const pending = session.pending;
      if (
        pending &&
        item.type === "user_message" &&
        !pending.baseline.has(item.id) &&
        item.text.trim() === pending.text.trim()
      ) {
        item.clientMessageId = pending.clientMessageId;
        pending.nativeTurn = entry.turnId;
      }
      const encoded = JSON.stringify(item);
      if (session.items.get(item.id) === encoded) continue;
      session.items.set(item.id, encoded);
      emit({ type: "timeline.item", sessionId: id, item, timestamp: entry.timestamp ?? undefined });
    }
    const pending = session.pending;
    const state = pending?.nativeTurn ? snapshot.turns[pending.nativeTurn] : undefined;
    if (pending && (state === "completed" || state === "canceled")) {
      emit({ type: "session.turn", sessionId: id, turnId: pending.turnId, state });
      session.pending = undefined;
    }
  };
  const poll = async (id: string, session: Session) => {
    if (closed || session.stopped) return;
    try {
      if (session.pending?.creation) {
        const result = await call(
          { action: "creation", requestId: session.pending.creation },
          deliverySchema,
        );
        if (result.status === "failed") {
          emit({
            type: "session.turn",
            sessionId: id,
            turnId: session.pending.turnId,
            state: "failed",
            error: { message: result.error ?? "Desktop 创建失败" },
          });
          session.pending = undefined;
        }
        if (result.status === "uncertain") throw new Error(result.error ?? "创建结果不确定");
        if (result.threadId) {
          session.threadId = result.threadId;
          if (session.pending) session.pending.creation = undefined;
          persist(id, session);
        }
      }
      if (session.threadId) {
        const snapshot = await call(
          { action: "snapshot", threadId: session.threadId },
          snapshotSchema,
        );
        if (!session.stopped) publish(id, session, snapshot);
      }
    } catch (error) {
      const message = String(error);
      if (!session.stopped && session.notice !== message) {
        session.notice = message;
        emit({
          type: "session.notice",
          sessionId: id,
          notice: {
            id: "bridge-read",
            severity: "warning",
            title: "Desktop 连接待恢复",
            description: message,
          },
        });
      }
    } finally {
      if (!closed && !session.stopped)
        session.timer = setTimeout(() => {
          void poll(id, session);
        }, 2000);
    }
  };
  const restoreCreation = async (session: Session, requestId: string) => {
    const recovered = await call({ action: "creation", requestId }, deliverySchema);
    session.pending = {
      clientMessageId: recovered.clientMessageId ?? requestId,
      text: recovered.text ?? "",
      turnId: recovered.clientMessageId ?? requestId,
      baseline: new Set(),
      creation: requestId,
    };
    if (recovered.threadId) session.threadId = recovered.threadId;
  };
  const openSession = async (input: Extract<ProviderInput, { type: "session.open" }>) => {
    const saved = input.persistence?.data as
      | { threadId?: string; project?: string; requestId?: string }
      | undefined;
    const threadId = saved?.threadId ?? input.config.providerOptions?.threadId;
    const project = saved?.project ?? input.config.providerOptions?.project;
    if (typeof project !== "string") throw new Error("请从 Codex Desktop 项目列表打开对话");
    const authorized = await call(
      { action: "project", project },
      z.object({ project: z.string(), cwd: z.string() }),
    );
    const session: Session = { project, cwd: authorized.cwd, items: new Map(), stopped: false };
    if (saved?.requestId) await restoreCreation(session, saved.requestId);
    let snapshot: Snapshot | undefined;
    const restoredThread = typeof threadId === "string" ? threadId : session.threadId;
    if (restoredThread) {
      snapshot = await call({ action: "snapshot", threadId: restoredThread }, snapshotSchema);
      if (snapshot.project !== project) throw new Error("会话与项目不匹配");
      session.threadId = restoredThread;
      session.cwd = snapshot.cwd;
    }
    if (session.cwd !== input.config.cwd) throw new Error("工作目录与 Desktop 会话不匹配");
    sessions.set(input.sessionId, session);
    emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: input.sessionId,
      capabilities,
      restoration: "core",
      cwd: session.cwd,
      title: snapshot?.title ?? input.config.title,
    });
    persist(input.sessionId, session);
    emit({
      type: "session.config",
      sessionId: input.sessionId,
      config: { models: [], modes: [], thinkingOptions: [], settings: [] },
    });
    emit({
      type: "session.notice",
      sessionId: input.sessionId,
      notice: {
        id: "desktop-controls",
        severity: "info",
        title: "已连接 Codex Desktop",
        description: "消息进入同一 Desktop 会话。模型、审批与停止操作沿用电脑端设置。",
      },
    });
    if (snapshot && input.history === "replay") publish(input.sessionId, session, snapshot);
    emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
    if (session.pending)
      emit({
        type: "session.turn",
        sessionId: input.sessionId,
        turnId: session.pending.turnId,
        state: "started",
      });
    void poll(input.sessionId, session);
  };
  const prompt = async (
    input: Extract<ProviderInput, { type: "session.prompt" }>,
    session: Session,
  ) => {
    if (input.prompt.input.type !== "message") throw new Error("不支持此 Desktop 操作");
    if (session.pending) throw new Error("上一条消息仍在等待 Desktop 回执");
    const parts = input.prompt.input.content;
    if (parts.some((part) => part.type !== "text"))
      throw new Error("Desktop bridge 第一版仅接收文本；可用手机系统听写输入");
    const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    const clientMessageId = input.prompt.clientMessageId;
    const requestId = `${input.sessionId}:${clientMessageId}`;
    if (!session.threadId)
      emit({
        type: "session.persistence",
        sessionId: input.sessionId,
        persistence: { version: 1, data: { project: session.project, requestId } },
      });
    const result = await call(
      session.threadId
        ? { action: "send", threadId: session.threadId, text, requestId }
        : { action: "create", project: session.project, text, requestId, clientMessageId },
      deliverySchema,
    );
    if (
      result.status === "uncertain" ||
      result.status === "failed" ||
      result.status === "dispatching"
    )
      throw new Error(result.error ?? "消息已登记，但发送结果尚未确认；不会自动重发");
    if (result.warning)
      emit({
        type: "session.notice",
        sessionId: input.sessionId,
        notice: {
          id: "bridge-wake",
          severity: "warning",
          title: "消息已排队，需打开电脑端对话",
          description: result.warning,
        },
      });
    session.pending = {
      clientMessageId,
      text,
      turnId: clientMessageId,
      baseline: new Set(result.baselineItems ?? []),
      creation: session.threadId ? undefined : requestId,
    };
    emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId,
      result: { type: "turn", turnId: clientMessageId },
    });
    emit({
      type: "session.turn",
      sessionId: input.sessionId,
      turnId: clientMessageId,
      state: "started",
    });
  };
  const dispatch = async (input: ProviderInput) => {
    requireProviderCapabilities(capabilities, input);
    if (input.type === "catalog") {
      emit({ type: "catalog", requestId: input.requestId, catalog: { models: [], modes: [] } });
      return;
    }
    if (input.type === "sessions") {
      const directory = await call({ action: "directory" }, directorySchema);
      emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: directory.threads.map((thread) => ({
          cwd: thread.cwd,
          title: thread.title,
          persistence: { version: 1, data: { threadId: thread.threadId, project: thread.project } },
        })),
      });
      return;
    }
    if (input.type === "session.open") return openSession(input);
    if (!("sessionId" in input)) throw new Error("不支持此 Desktop 操作");
    const session = sessions.get(input.sessionId);
    if (!session) throw new Error("未知的 Desktop 会话");
    if (input.type === "session.close") {
      session.stopped = true;
      clearTimeout(session.timer);
      sessions.delete(input.sessionId);
      emit({ type: "session.closed", sessionId: input.sessionId });
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    if (input.type === "session.interrupt")
      throw new Error("当前 bridge 没有停止接口，请在 Codex Desktop 操作");
    if (input.type !== "session.prompt" || input.prompt.input.type !== "message")
      throw new Error("不支持此 Desktop 操作");
    await prompt(input, session);
  };
  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Desktop connection closed");
      queueMicrotask(() => {
        void dispatch(input).catch((error) => {
          if (input.type === "session.prompt")
            emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: { message: String(error) } },
            });
          else if ("requestId" in input)
            emit({
              type: "request.failed",
              requestId: input.requestId,
              error: { message: String(error) },
            });
        });
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      for (const session of sessions.values()) {
        session.stopped = true;
        clearTimeout(session.timer);
      }
      sessions.clear();
      listeners.clear();
    },
  };
}
