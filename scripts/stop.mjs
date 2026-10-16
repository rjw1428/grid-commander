#!/usr/bin/env node
// Stops Grid Commander: the web server listening on FLEET_PORT (default 7777) and, unless
// --keep-units is given, the unit host (pid in <data dir>/host.pid), which stops every session.
//   pnpm stop               stop everything
//   pnpm stop --keep-units  stop only the web server; sessions keep running in the host
//   pnpm host:restart       stop only the host; the running server relaunches it and resumes units
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const keepUnits = args.has("--keep-units");
const hostOnly = args.has("--host-only");

const port = Number(process.env.FLEET_PORT ?? 7777);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`invalid FLEET_PORT: ${process.env.FLEET_PORT}`);
  process.exit(2);
}
const base = process.env.INIT_CWD ?? process.cwd();
const db = process.env.FLEET_DB ?? "./data/fleet.db";
const dataDir = db === ":memory:" ? resolve(base, "data") : dirname(resolve(base, db));
const pidFile = join(dataDir, "host.pid");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function terminate(pids, label, graceMs) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`Grid Commander: sent SIGTERM to ${label} pid ${pid}`);
    } catch (err) {
      console.error(`could not signal pid ${pid}: ${err.message}`);
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !alive(pid))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const pid of pids) {
    if (!alive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
      console.log(`Grid Commander: killed ${label} pid ${pid}`);
    } catch {
      /* already gone */
    }
  }
  return false;
}

if (!hostOnly) {
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
  if (pids.length === 0) console.log(`Grid Commander: nothing listening on :${port}`);
  else {
    await terminate(pids, "server", 5000);
    console.log("Grid Commander: server stopped");
  }
}

if (!keepUnits) {
  if (!existsSync(pidFile)) {
    console.log(`Grid Commander: no unit host pid file (${pidFile})`);
  } else {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(pid) || !alive(pid)) {
      console.log("Grid Commander: unit host is not running");
      try {
        unlinkSync(pidFile);
      } catch {
        /* ignore */
      }
    } else {
      // the host stops every session before exiting; give it time
      const clean = await terminate([pid], "unit host", 20_000);
      console.log(clean ? "Grid Commander: unit host stopped" : "Grid Commander: unit host killed");
    }
  }
} else {
  console.log("Grid Commander: unit host left running (--keep-units)");
}
