#!/usr/bin/env node
/**
 * Dev CLI. `pnpm cli unit run --project <id> --type infantry "<prompt>"`
 * Spawns one unit with the real SDK, prints status transitions and transcript lines, exits on result.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getUnitType, type Project } from "@gridcommander/shared";
import { loadEnv, loadFleetConfig } from "../config.js";
import { UnitRuntime, realSdk } from "../runtime/UnitRuntime.js";
import { buildUnitSystemPrompt } from "../runtime/systemPrompt.js";

function usage(code = 1): never {
  console.error(`usage:
  cli unit run --project <id> --type <type> [--model <m>] [--permission <mode>] [--config fleet.json] [--cwd <dir>] "<prompt>"`);
  process.exit(code);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const color = (c: number, s: string) => `\x1b[${c}m${s}\x1b[0m`;

async function unitRun(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      type: { type: "string", default: "infantry" },
      model: { type: "string" },
      permission: { type: "string" },
      config: { type: "string" },
      cwd: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  const prompt = positionals.join(" ").trim();
  if (!prompt) usage();

  const env = loadEnv({ ...process.env, FLEET_TOKEN: process.env.FLEET_TOKEN ?? "cli-local-token" });
  const fleet = loadFleetConfig(values.config ?? env.FLEET_CONFIG);
  let project: Project | undefined = fleet.projects.find((p) => p.id === values.project);
  if (!project) {
    if (values.project && !values.cwd) {
      console.error(`project "${values.project}" not found in ${values.config ?? env.FLEET_CONFIG}; pass --cwd to run ad hoc`);
      process.exit(1);
    }
    project = {
      id: values.project ?? "adhoc",
      name: values.project ?? "ad hoc",
      cwd: values.cwd ?? process.cwd(),
      tint: "#333333",
      flag: "#999999",
      cells: [],
    };
  }
  const type = getUnitType(values.type ?? "infantry");
  const cwd = values.cwd ?? (project.cwd || process.cwd());
  const unitName = `cli-${type.id}`;

  const rt = new UnitRuntime(
    {
      unitId: unitName,
      cwd,
      model: values.model ?? project.defaults?.model ?? type.model,
      permissionMode: (values.permission as never) ?? project.defaults?.permissionMode ?? type.defaultPermissionMode,
      systemPromptAppend: buildUnitSystemPrompt({ name: unitName, task: prompt.slice(0, 80) }, type, project),
      log: {
        debug: () => {},
        info: (o, m) => console.error(dim(`[info] ${m ?? ""} ${typeof o === "object" ? JSON.stringify(o) : ""}`)),
        warn: (o, m) => console.error(color(33, `[warn] ${m ?? ""} ${typeof o === "object" ? JSON.stringify(o) : ""}`)),
        error: (o, m) => console.error(color(31, `[error] ${m ?? ""} ${typeof o === "object" ? JSON.stringify(o) : ""}`)),
      },
    },
    realSdk,
  );

  const rl = stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : null;

  rt.on("status", (s) => console.log(bold(color(36, `● status → ${s}`))));
  rt.on("activity", (a) => a && console.log(dim(`  … ${a}`)));
  rt.on("transcript", (entries) => {
    for (const e of entries) {
      switch (e.kind) {
        case "user":
          console.log(color(33, `> ${e.text}`));
          break;
        case "assistant":
          console.log(e.text);
          break;
        case "tool":
          console.log(dim(`  [${e.summary}]`));
          break;
        case "result":
          console.log(color(e.ok ? 32 : 31, `■ result ${e.ok ? "ok" : "error"}${e.costUsd ? ` $${e.costUsd.toFixed(4)}` : ""}${e.durationMs ? ` ${e.durationMs} ms` : ""}`));
          break;
        case "system":
          console.log(dim(`  (${e.text})`));
          break;
        default:
          break;
      }
    }
  });
  rt.on("permission", async (req) => {
    if (!req) return;
    console.log(color(35, `? permission: ${req.summary}`));
    if (values.yes || !rl) {
      console.log(dim(values.yes ? "  auto-allow (--yes)" : "  no TTY: denying"));
      rt.answerPermission({ allow: !!values.yes, message: "no operator attached" });
      return;
    }
    const a = (await rl.question("  allow? [y/N/a(lways)] ")).trim().toLowerCase();
    rt.answerPermission({ allow: a === "y" || a === "a", remember: a === "a" });
  });
  rt.on("question", async (q) => {
    if (!q) return;
    const answers: Record<string, string> = {};
    for (const qq of q.questions) {
      console.log(color(35, `? ${qq.question}`));
      qq.options.forEach((o, i) => console.log(`   ${i + 1}. ${o.label}${o.description ? dim(` — ${o.description}`) : ""}`));
      const first = qq.options[0]?.label ?? "";
      if (!rl) {
        answers[qq.question] = first;
        continue;
      }
      const a = (await rl.question(`  choice [1]: `)).trim();
      const idx = Number(a) - 1;
      answers[qq.question] = qq.options[idx]?.label ?? (a || first);
    }
    rt.answerQuestion(answers);
  });
  rt.on("notice", (t, sev) => console.log(color(sev === "error" ? 31 : 34, `! ${t}`)));

  rt.on("init", (init) =>
    console.log(dim(`session ${init.sessionId} model ${init.model} mcp ${init.mcpServers.map((s) => `${s.name}:${s.status}`).join(",") || "-"}`)),
  );
  await rt.start();
  const result = await rt.submit(prompt, "operator");
  const sid = rt.sessionId;
  await rt.stop();
  rl?.close();
  if (sid) console.log(dim(`resume in a terminal with: claude --resume ${sid}`));
  process.exit(result.ok ? 0 : 2);
}

const [group, cmd, ...rest] = process.argv.slice(2);
if (group === "unit" && cmd === "run") {
  unitRun(rest).catch((err) => {
    console.error(color(31, err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
} else {
  usage();
}
