/**
 * Aggregate skill-suggestion records across Pi sessions (offline analysis).
 *
 *   bun scripts/stats.ts                       # all sessions under ~/.pi/agent/sessions
 *   bun scripts/stats.ts <sessions-dir>        # e.g. one project's session folder
 */

import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatStats, recordsFromSessionDir, summarize } from "../src/log.ts";

const dir = process.argv[2] ?? path.join(getAgentDir(), "sessions");
const { sessions, records } = await recordsFromSessionDir(dir);
console.log(formatStats(summarize(records)));
console.log(`\n(${records.length} records from ${sessions} sessions in ${dir})`);
