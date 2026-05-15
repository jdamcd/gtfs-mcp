import type { ToolContext } from "../tools/helpers.js";

export function registerSystemsResource(ctx: ToolContext): void {
  ctx.server.registerResource(
    "systems",
    "gtfs://systems",
    {
      title: "Configured transit systems",
      description:
        "Overview of every transit system this server is configured for: id, name, timezone, and which realtime feed types are available.",
      mimeType: "text/markdown",
    },
    (uri) => {
      const systems = Array.from(ctx.systems.values());
      const lines: string[] = ["# Configured transit systems", ""];

      if (systems.length === 0) {
        lines.push("No transit systems are configured on this server.");
      } else {
        lines.push(
          `This server has ${systems.length} transit system${systems.length === 1 ? "" : "s"} configured.`,
          ""
        );
        for (const s of systems) {
          lines.push(
            `## ${s.id} — ${s.name}`,
            "",
            `- Timezone: \`${s.timezone}\``,
            `- Realtime feeds: ${s.realtime.trip_updates.length} trip-updates, ${s.realtime.vehicle_positions.length} vehicle-positions, ${s.realtime.alerts.length} alerts`,
            ""
          );
        }
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: lines.join("\n"),
          },
        ],
      };
    }
  );
}
