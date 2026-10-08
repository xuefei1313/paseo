import type { PluginServerContext } from "@getpaseo/plugin/server";
import { directoryRpc, openRpc, settings } from "./shared/contracts.js";
import { bridgeCaller } from "./server/bridge.js";
import { directorySchema, snapshotSchema } from "./server/contracts.js";
import { createDesktopProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  const call = bridgeCaller(server.registerSettings(settings));
  server.registerProvider(createDesktopProvider(call));
  server.handle(directoryRpc, () => call({ action: "directory" }, directorySchema));
  server.handle(openRpc, async ({ project, threadId, requestKey }, { paseo }) => {
    const directory = await call({ action: "directory" }, directorySchema);
    const selected = directory.projects.find((entry) => entry.name === project);
    if (!selected) throw new Error("项目未通过当前 bridge 授权");
    const thread = threadId
      ? await call({ action: "snapshot", threadId }, snapshotSchema)
      : undefined;
    if (thread && thread.project !== project) throw new Error("会话与项目不匹配");
    const key = threadId ? `desktop-thread:${threadId}` : `desktop-new:${requestKey}`;
    const existing = await paseo.agents.list({ filter: { labels: { "desktop-binding": key } } });
    const agent = existing.entries.find((entry) => !entry.agent.archivedAt)?.agent;
    if (agent) return { agentId: agent.id };
    const created = await paseo.agents.create({
      idempotencyKey: key,
      config: {
        provider: "codex-desktop/desktop",
        options: { project, ...(threadId ? { threadId } : {}) },
      },
      cwd: thread?.cwd ?? selected.cwd,
      title: thread?.title ?? `${project} · 新对话`,
      labels: { "desktop-binding": key },
    });
    return { agentId: created.id };
  });
  return () => {};
}
