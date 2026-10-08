import { ProviderEventSchema, type ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { threadSchema, directoryRpc } from "../shared/contracts.js";

export const snapshotSchema = threadSchema.extend({
  items: z.array(
    z.object({
      item: z.custom<ProviderTimelineItem>(
        (item) =>
          ProviderEventSchema.safeParse({ type: "timeline.item", sessionId: "validation", item })
            .success,
      ),
      turnId: z.string(),
      timestamp: z.string().nullish(),
    }),
  ),
  turns: z.record(z.string(), z.enum(["started", "completed", "canceled"])),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const deliverySchema = z.object({
  status: z.enum(["dispatching", "queued", "created", "failed", "uncertain"]),
  threadId: z.string().optional(),
  error: z.string().optional(),
  text: z.string().optional(),
  clientMessageId: z.string().optional(),
  baselineItems: z.array(z.string()).optional(),
  baselineTurns: z.array(z.string()).optional(),
});
export const directorySchema = directoryRpc.output;
