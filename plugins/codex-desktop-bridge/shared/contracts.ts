import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settings = defineSettings({
  id: "connection",
  scope: "host",
  version: 1,
  schema: z.object({
    bridgeSource: z.string().default("~/.codex/discord-bridge"),
    bridgeConfig: z.string().default("~/.codex/discord-bridge/config.json"),
  }),
});
export const threadSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  cwd: z.string(),
  project: z.string(),
});
export const directoryRpc = defineRpc({
  name: "directory",
  input: z.object({}),
  output: z.object({
    projects: z.array(z.object({ name: z.string(), projectId: z.string(), cwd: z.string() })),
    threads: z.array(threadSchema),
  }),
});
export const openRpc = defineRpc({
  name: "open",
  input: z.object({
    project: z.string(),
    threadId: z.string().optional(),
    requestKey: z.string().min(1),
  }),
  output: z.object({ agentId: z.string() }),
});
