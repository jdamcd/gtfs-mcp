# gtfs-mcp

An MCP server for querying GTFS static schedules and GTFS-RT realtime feeds. Works with any GTFS-compatible transit system. Includes a ready-to-use config for NYC Subway (MTA).

**Service alerts**

![Asking Claude about G train service alerts at Nassau Av](readme_img/example_alerts.png)


**Arrivals**

![Asking Claude about L train arrival times from Bedford Av](readme_img/example_arrivals.png)

## Setup

```bash
npm install
npm run build
```

## Configuration

The server reads a JSON config file defining transit systems. Point to it with the `GTFS_MCP_CONFIG` environment variable.

An MTA Subway config is included at `config.mta.json` and works with no API key:

```bash
GTFS_MCP_CONFIG=./config.mta.json npm start
```

To add your own systems, create a config file with the following structure:

```json
{
  "systems": [
    {
      "id": "my-system",
      "name": "My Transit System",
      "schedule_url": "https://example.com/gtfs.zip",
      "timezone": "America/New_York",
      "realtime": {
        "trip_updates": ["https://example.com/trip-updates"],
        "vehicle_positions": ["https://example.com/vehicle-positions"],
        "alerts": ["https://example.com/alerts"]
      },
      "auth": null
    }
  ],
  "data_dir": "~/.gtfs-mcp/data",
  "schedule_refresh_hours": 24
}
```

Each realtime feed type accepts multiple URLs (e.g. MTA splits trip updates across 8 feeds). Set any feed type to `[]` if the system doesn't provide it.

`timezone` is the agency's IANA timezone (e.g. `"America/New_York"`, `"Europe/London"`). It's used to compare scheduled stop times to "now" and to render times in responses, so the server produces the same results regardless of where it runs. The value matches `agency_timezone` in the system's GTFS `agency.txt`.

### Authenticated feeds

Some transit APIs require an API key. Configure auth per system — the actual key is read from an environment variable at runtime.

**Query parameter** (appended to URL):
```json
{
  "auth": {
    "type": "query_param",
    "param_name": "api_key",
    "key_env": "MY_API_KEY"
  }
}
```

**Header:**
```json
{
  "auth": {
    "type": "header",
    "header_name": "X-Api-Key",
    "key_env": "MY_API_KEY"
  }
}
```

Set `auth` to `null` for systems that don't require authentication.

## Using with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gtfs": {
      "command": "node",
      "args": ["/absolute/path/to/gtfs-mcp/dist/index.js"],
      "env": {
        "GTFS_MCP_CONFIG": "/absolute/path/to/gtfs-mcp/config.mta.json"
      }
    }
  }
}
```

Add any API keys your systems need to the `env` block.

## Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_systems` | List all configured transit systems | — |
| `search_stops` | Search stops by name | `system`, `query`, `limit?` |
| `find_nearby_stops` | Stops near a coordinate, ordered by distance | `system`, `lat`, `lon`, `radius_m?`, `limit?` |
| `get_stop` | Stop details and routes serving it | `system`, `stop_id` |
| `get_arrivals` | Upcoming arrivals with realtime delays | `system`, `stop_id`, `route_id?`, `limit?` |
| `list_routes` | Routes in a system, with optional name filter and pagination | `system`, `query?`, `route_type?`, `limit?`, `offset?` |
| `get_route` | Route details with ordered stop list | `system`, `route_id`, `direction_id?` |
| `get_alerts` | Active service alerts | `system`, `route_id?`, `stop_id?` |
| `get_vehicles` | Live vehicle positions | `system`, `route_id?` |
| `get_trip` | Trip stop sequence with realtime delays | `system`, `trip_id` |
| `get_system_status` | System overview: counts, alerts, feed health | `system` |

The `system` parameter is the system ID from your config (e.g. `"mta-subway"`).

## How it works

**Static GTFS** data (schedules, stops, routes) is downloaded as a ZIP on first use and imported into a local SQLite database at `data_dir/{system_id}/`. It re-downloads automatically when the database is older than `schedule_refresh_hours`.

**GTFS-RT** feeds (trip updates, vehicle positions, alerts) are fetched on demand with a 30-second in-memory cache. Systems with multiple feeds (MTA has 8 trip update feeds) are fetched in parallel and merged.

**Arrivals** merge realtime and scheduled in a single stream. Realtime is authoritative within its horizon (per stop and route), scheduled fills in beyond. Cancelled trips and skipped stops drop out; trips that only exist in realtime (e.g. added service) come through. Scheduled arrivals honor today's active `service_id` from `calendar.txt` / `calendar_dates.txt`, and services that roll past midnight (`25:30:00`-style stop times) are rendered in wall-clock time for the current calendar day.

## Testing

```bash
npm test
```

### Evals

LLM evals use [promptfoo](https://promptfoo.dev/) to verify that a model selects the correct tools for natural-language transit queries. Requires an `ANTHROPIC_API_KEY` set in `.env` or as an environment variable.

```bash
npm run build
npm run eval
npm run eval:view   # open web UI to inspect results
```

### MCP inspector

Test with the MCP inspector:

```bash
GTFS_MCP_CONFIG=./config.mta.json npx @modelcontextprotocol/inspector node dist/index.js
```
