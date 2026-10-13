#!/usr/bin/env node
// Stops the Grid Commander server by killing whatever listens on FLEET_PORT (default 7777).
import { execFileSync } from "node:child_process";

const port = Number(process.env.FLEET_PORT ?? 7777);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`invalid FLEET_PORT: ${process.env.FLEET_PORT}`);
  process.exit(2);
}

let pids = [];
try {
  pids = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
} catch {
  // lsof exits 1 when nothing matches
}

if (pids.length === 0) {
  console.log(`Grid Commander: nothing listening on :${port}`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Grid Commander: sent SIGTERM to pid ${pid} (:${port})`);
  } catch (err) {
    console.error(`could not signal pid ${pid}: ${err.message}`);
  }
}

// Give the server a moment to shut down units and close the DB; escalate if it hangs.
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const alive = pids.filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  if (alive.length === 0) {
    console.log("Grid Commander: stopped");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 200));
}
for (const pid of pids) {
  try { process.kill(pid, "SIGKILL"); console.log(`Grid Commander: killed pid ${pid}`); } catch { /* already gone */ }
}
