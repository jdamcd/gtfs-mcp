/**
 * Run with: npx tsx test/fixtures/create-gtfs-zip.ts
 * Creates a minimal valid GTFS zip for testing.
 */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const dir = join(import.meta.dirname, "gtfs-tmp");
mkdirSync(dir, { recursive: true });

const files: Record<string, string> = {
  "agency.txt": `agency_id,agency_name,agency_url,agency_timezone
TA,Test Agency,http://test.example.com,America/New_York`,

  "calendar.txt": `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WEEKDAY,1,1,1,1,1,0,0,20240101,20261231
WEEKEND,0,0,0,0,0,1,1,20240101,20261231`,

  "routes.txt": `route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color
R1,TA,1,Route One,1,FF0000,FFFFFF
R2,TA,2,Route Two,3,00FF00,000000`,

  "stops.txt": `stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station
S1,Central Station,40.7128,-74.0060,1,
S1N,Central Station North,40.7130,-74.0058,0,S1
S1S,Central Station South,40.7126,-74.0062,0,S1
S2,Park Avenue,40.7200,-74.0100,0,
S3,Times Square,40.7580,-73.9855,0,`,

  "trips.txt": `route_id,service_id,trip_id,trip_headsign,direction_id
R1,WEEKDAY,T1,Uptown,0
R1,WEEKDAY,T2,Downtown,1
R2,WEEKDAY,T3,Eastbound,0`,

  "stop_times.txt": `trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign
T1,08:00:00,08:01:00,S1N,1,
T1,08:10:00,08:11:00,S2,2,
T1,08:20:00,08:21:00,S3,3,
T2,09:00:00,09:01:00,S3,1,
T2,09:10:00,09:11:00,S2,2,
T2,09:20:00,09:21:00,S1S,3,
T3,07:30:00,07:31:00,S1N,1,
T3,07:45:00,07:46:00,S2,2,`,
};

for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(dir, name), content);
}

const outPath = join(import.meta.dirname, "gtfs.zip");
execSync(`cd "${dir}" && zip -j "${outPath}" *.txt`);
rmSync(dir, { recursive: true });
console.log(`Created ${outPath}`);
