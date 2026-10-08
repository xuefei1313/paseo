import { beforeEach, expect, it, vi } from "vitest";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server.js";

const call = vi.hoisted(() => vi.fn());
vi.mock("./server/bridge.js", () => ({ bridgeCaller: () => call }));

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(async ({ action }) =>
    action === "directory"
      ? { projects: [{ name: "demo", cwd: "/repo", projectId: "project" }], threads: [] }
      : { project: "demo", cwd: "/repo/worktree", threadId: "native", title: "Native task" },
  );
});

it.each([undefined, "native"])(
  "opens a new binding in the existing checkout workspace (thread: %s)",
  async (threadId) => {
    let openHandler!: Parameters<PluginServerContext["handle"]>[1];
    contribute({
      registerSettings: vi.fn(),
      registerProvider: vi.fn(),
      handle: (contract, handler) => {
        if (contract.name === "open") openHandler = handler;
      },
    } as unknown as PluginServerContext);
    const create = vi.fn(async () => ({ id: "agent", workspaceId: "known-workspace" }));
    const unplacedCreate = vi.fn(async () => ({ id: "agent", workspaceId: "new-workspace" }));
    const open = vi.fn(async () => ({ id: "known-workspace", agents: { create } }));
    const paseo = {
      workspaces: { open },
      agents: { list: vi.fn(async () => ({ entries: [] })), create: unplacedCreate },
    };
    await openHandler({ project: "demo", threadId, requestKey: "request" }, {
      paseo,
    } as unknown as PluginHandlerContext);
    expect(open).toHaveBeenCalledWith(threadId ? "/repo/worktree" : "/repo");
    expect(create).toHaveBeenCalledOnce();
    expect(unplacedCreate).not.toHaveBeenCalled();
  },
);
