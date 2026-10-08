import { execCommand, type PluginSettings } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { settings } from "../shared/contracts.js";
import python from "./adapter.py";

export function bridgeCaller(connection: PluginSettings<typeof settings.schema>) {
  return async <T>(request: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    const state = await connection.read();
    if (state.status !== "ready") throw new Error(state.error);
    const { stdout } = await execCommand(
      "python3",
      [
        "-c",
        python,
        JSON.stringify({
          ...state.values,
          stateDirectory: join(
            process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
            "codex-desktop-bridge",
          ),
          request,
        }),
      ],
      { timeout: 40000, maxBuffer: 8 * 1024 * 1024 },
    );
    return schema.parse(JSON.parse(stdout));
  };
}
export type BridgeCall = ReturnType<typeof bridgeCaller>;
