import { beforeEach, expect, it, vi } from "vitest";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { SessionInboundMessageSchema } from "@getpaseo/protocol/messages";
import contribute from "./index.server.js";

const call = vi.hoisted(() => vi.fn());
vi.mock("./server/bridge.js", () => ({ bridgeCaller: () => call }));
let threadTitle: string;

beforeEach(() => {
  threadTitle = "Native task";
  call.mockReset();
  call.mockImplementation(async ({ action }) =>
    action === "directory"
      ? { projects: [{ name: "demo", cwd: "/repo", projectId: "project" }], threads: [] }
      : { project: "demo", cwd: "/repo/worktree", threadId: "native", title: threadTitle },
  );
});

it.each([
  { name: "new", threadId: undefined, title: "Native task", expectedTitle: "demo · 新对话" },
  { name: "existing", threadId: "native", title: "Native task", expectedTitle: "Native task" },
  {
    name: "long title",
    threadId: "native",
    title: "长标题".repeat(711),
    expectedTitle: `${"长标题".repeat(66)}长标`,
  },
  { name: "blank title", threadId: "native", title: " \n\t ", expectedTitle: "demo · 新对话" },
])("opens a valid checkout binding ($name)", async ({ threadId, title, expectedTitle }) => {
  threadTitle = title;
  let openHandler!: Parameters<PluginServerContext["handle"]>[1];
  contribute({
    registerSettings: vi.fn(),
    registerProvider: vi.fn(),
    handle: (contract, handler) => {
      if (contract.name === "open") openHandler = handler;
    },
  } as unknown as PluginServerContext);
  const create = vi.fn(
    async (input: Parameters<PluginHandlerContext["paseo"]["agents"]["create"]>[0]) => {
      SessionInboundMessageSchema.parse({
        type: "create_agent_request",
        requestId: "request",
        config: { provider: "codex-desktop", cwd: "/repo", title: input.title },
      });
      return { id: "agent", workspaceId: "known-workspace" };
    },
  );
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
  expect(create.mock.calls[0][0].config.options).toEqual({
    project: "demo",
    ...(threadId ? { threadId } : {}),
  });
  expect(create.mock.calls[0][0].title).toBe(expectedTitle);
  expect(unplacedCreate).not.toHaveBeenCalled();
});
