import { z } from "zod";
import type { ToolContext } from "../tools/helpers.js";
import { resolveSystem } from "../tools/helpers.js";

function userMessage(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text },
      },
    ],
  };
}

export function registerTransitStatusPrompt(ctx: ToolContext): void {
  ctx.server.registerPrompt(
    "transit-status",
    {
      title: "Transit status",
      description:
        "Summarise currently-active service alerts for configured transit systems.",
      argsSchema: {
        system: z
          .string()
          .optional()
          .describe("System ID (leave blank for all systems)"),
      },
    },
    ({ system }) => {
      const allIds = Array.from(ctx.systems.keys());

      if (allIds.length === 0) {
        return userMessage(
          "No transit systems are configured on this MCP server. Tell the user there is nothing to report."
        );
      }

      if (system && !resolveSystem(ctx.systems, system)) {
        const available = allIds.slice().sort().join(", ");
        return userMessage(
          `Unknown system: ${system}. Call list_systems and tell the user which IDs are available. Available: ${available}.`
        );
      }

      const targetIds = system ? [system] : allIds;
      const scopeNote = system
        ? `the ${system} system`
        : `all ${allIds.length} configured system${allIds.length === 1 ? "" : "s"}`;
      const idList = targetIds.map((id) => `- ${id}`).join("\n");

      const text = [
        `Produce a transit status summary for ${scopeNote}.`,
        "",
        "For each of the following system IDs, call get_alerts:",
        "",
        idList,
        "",
        "Then write a concise summary per system:",
        "- Count the active alerts and call out the most disruptive (prefer effects like NO_SERVICE, SIGNIFICANT_DELAYS, DETOUR, STATION_CLOSURE). Group by route where useful.",
        "- If a system has zero active alerts, one line is enough.",
        "",
        "Keep the whole summary tight — aim for under ~200 words total.",
      ].join("\n");

      return userMessage(text);
    }
  );
}
