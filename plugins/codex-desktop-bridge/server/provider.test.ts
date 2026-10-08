import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderEventSchema,
  type ProviderEvent,
  type ProviderConnection,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type { BridgeCall } from "./bridge.js";
import { createDesktopProvider } from "./provider.js";

let connection: ProviderConnection;
afterEach(async () => {
  await connection?.close();
  vi.useRealTimers();
});

async function setup() {
  vi.useFakeTimers();
  const events: ProviderEvent[] = [];
  let snapshot = {
    threadId: "native",
    project: "demo",
    cwd: "/repo",
    title: "Native task",
    items: [] as unknown[],
    turns: {} as Record<string, string>,
  };
  let status = "queued";
  const actions: Record<string, unknown>[] = [];
  const call: BridgeCall = async <T>(request: Record<string, unknown>, schema: z.ZodType<T>) => {
    actions.push(request);
    let result: unknown = { status, threadId: "native", baselineItems: [] };
    if (request.action === "project") result = { project: "demo", cwd: "/repo" };
    else if (request.action === "snapshot") result = snapshot;
    else if (request.action === "creation")
      result = { status, threadId: "native", text: "hello", clientMessageId: "message-1" };
    return schema.parse(result);
  };
  connection = await createDesktopProvider(call).connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence"],
  });
  connection.onEvent((event) => {
    ProviderEventSchema.parse(event);
    events.push(event);
  });
  const open = async (persistence?: {
    version: number;
    data: { project: string; requestId: string };
  }) => {
    await connection.send({
      type: "session.open",
      requestId: "open",
      sessionId: "wrapper",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
        providerOptions: { project: "demo", ...(persistence ? {} : { threadId: "native" }) },
      },
      persistence,
      history: "replay",
    });
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    events,
    actions,
    open,
    update: (value: typeof snapshot) => {
      snapshot = value;
    },
    status: (value: string) => {
      status = value;
    },
  };
}

describe("Codex Desktop provider", () => {
  it("continues the existing thread and completes from the matching native turn", async () => {
    const fixture = await setup();
    await fixture.open();
    await connection.send({
      type: "session.prompt",
      sessionId: "wrapper",
      prompt: {
        clientMessageId: "message-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.actions.find((action) => action.action === "send")?.threadId).toBe("native");
    fixture.update({
      threadId: "native",
      project: "demo",
      cwd: "/repo",
      title: "Native task",
      items: [
        { item: { id: "user-1", type: "user_message", text: "hello" }, turnId: "native-turn" },
        {
          item: { id: "assistant-1", type: "assistant_message", text: "done" },
          turnId: "native-turn",
        },
      ],
      turns: { "native-turn": "completed" },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ type: "session.turn", turnId: "message-1", state: "completed" }),
    );
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ clientMessageId: "message-1" }),
      }),
    );
    expect(fixture.actions.some((action) => action.action === "create")).toBe(false);
  });

  it("reports uncertainty without automatically resending", async () => {
    const fixture = await setup();
    await fixture.open();
    fixture.status("uncertain");
    await connection.send({
      type: "session.prompt",
      sessionId: "wrapper",
      prompt: {
        clientMessageId: "message-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(fixture.actions.filter((action) => action.action === "send")).toHaveLength(1);
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        result: expect.objectContaining({ type: "failed" }),
      }),
    );
  });

  it("restores a pending native creation instead of creating it again", async () => {
    const fixture = await setup();
    await fixture.open({ version: 1, data: { project: "demo", requestId: "creation-1" } });
    expect(fixture.actions.some((action) => action.action === "create")).toBe(false);
    expect(fixture.events).toContainEqual({
      type: "session.persistence",
      sessionId: "wrapper",
      persistence: { version: 1, data: { project: "demo", threadId: "native" } },
    });
    await connection.send({ type: "session.close", requestId: "close", sessionId: "wrapper" });
    await vi.advanceTimersByTimeAsync(0);
    const count = fixture.actions.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(fixture.actions).toHaveLength(count);
  });

  it("keeps uncertain creation recoverable without repeating the same notice", async () => {
    const fixture = await setup();
    fixture.status("uncertain");
    await fixture.open({ version: 1, data: { project: "demo", requestId: "creation-1" } });
    await vi.advanceTimersByTimeAsync(6000);
    expect(
      fixture.events.filter(
        (event) => event.type === "session.notice" && event.notice.id === "bridge-read",
      ),
    ).toHaveLength(1);
    expect(fixture.actions.some((action) => action.action === "create")).toBe(false);
    fixture.status("created");
    fixture.update({
      threadId: "native",
      project: "demo",
      cwd: "/repo",
      title: "Native task",
      items: [
        { item: { id: "initial", type: "user_message", text: "hello" }, turnId: "native-turn" },
      ],
      turns: { "native-turn": "completed" },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ type: "session.turn", state: "completed" }),
    );
  });

  it("reports a confirmed creation failure as a failed turn", async () => {
    const fixture = await setup();
    fixture.status("failed");
    await fixture.open({ version: 1, data: { project: "demo", requestId: "creation-1" } });
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ type: "session.turn", state: "failed" }),
    );
    expect(fixture.actions.some((action) => action.action === "create")).toBe(false);
  });
});
