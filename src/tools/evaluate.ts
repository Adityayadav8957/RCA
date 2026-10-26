// Evaluation harness: injects known faults and checks whether the RCA engine blames the right service.
//   npm run eval                 17 fault trials + 2 fault-free controls (~7 min)
//   npm run eval -- --reps 2     repeat every trial
//   npm run eval -- --quick      3 trials, for a smoke test
import fs from "node:fs";
import { DATABASES, ENTRY_SERVICE, RCA_URL, SERVICES } from "../shared/config";
import { FAULTS, setChaos } from "./chaos";
import { startLoad } from "./loadgen";
import { startStack } from "./launcher";

const BASELINE_S = 12; // healthy traffic before the fault
const FAULT_S = 8; // how long the fault runs before the final verdict
const WINDOW_S = 6.5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (p: string) => (await fetch(RCA_URL + p)).json() as Promise<any>;
const analysis = (window: number) => get(`/api/analysis?window=${window}&baseline=${BASELINE_S}&lag=1`);

interface Trial {
  service: string | null;
  fault: string;
  top1: string | null;
  ranking: string[];
  hit1: boolean;
  hit3: boolean;
  detectedAfterS: number | null;
  naiveP95Hit: boolean;
  naiveRatioHit: boolean;
  falsePositive: boolean;
}

const CASES: Array<{ fault: keyof typeof FAULTS; value: number }> = [
  { fault: "latency", value: 200 },
  { fault: "errors", value: 0.5 },
  { fault: "cpu", value: 30 },
];

async function runTrial(service: string | null, fault: keyof typeof FAULTS | "none", value: number): Promise<Trial> {
  await fetch(RCA_URL + "/api/reset", { method: "POST" });
  await sleep(BASELINE_S * 1000);
  const t0 = Date.now();
  if (service) await setChaos(service, FAULTS[fault as keyof typeof FAULTS](value));

  let detectedAfterS: number | null = null;
  let last: any;
  for (let s = 1; s <= FAULT_S; s++) {
    await sleep(Math.max(0, t0 + s * 1000 - Date.now()));
    last = await analysis(WINDOW_S);
    if (service && detectedAfterS === null && last.suspects[0]?.name === service) detectedAfterS = s;
  }
  if (service) await setChaos(service, null);

  const ranking: string[] = last.suspects.map((s: any) => s.name);
  return {
    service,
    fault: service ? `${fault} ${value}` : "none (control)",
    top1: ranking[0] ?? null,
    ranking,
    hit1: !!service && ranking[0] === service,
    hit3: !!service && ranking.slice(0, 3).includes(service),
    detectedAfterS,
    naiveP95Hit: !!service && last.naive.highestP95[0] === service,
    naiveRatioHit: !!service && last.naive.highestLatencyRatio[0] === service,
    falsePositive: !service && last.incident,
  };
}

(async () => {
  const quick = process.argv.includes("--quick");
  const reps = Number(process.argv[process.argv.indexOf("--reps") + 1]) || 1;
  const stack = await startStack({ quiet: true });
  const load = startLoad(20);
  await sleep(3000);

  const plan: Array<[string | null, keyof typeof FAULTS | "none", number]> = [];
  for (let r = 0; r < reps; r++) {
    if (quick) plan.push(["payments", "latency", 200], ["inventory", "errors", 0.5], [null, "none", 0]);
    else {
      for (const s of SERVICES) for (const c of CASES) plan.push([s.name, c.fault, c.value]);
      // Real database faults: Postgres slowed from inside (db_gate), Redis stalled with DEBUG SLEEP.
      for (const db of DATABASES) plan.push([db, "latency", 200]);
      plan.push([null, "none", 0], [null, "none", 0]);
    }
  }

  const trials: Trial[] = [];
  for (const [svc, fault, value] of plan) {
    const t = await runTrial(svc, fault, value);
    trials.push(t);
    const mark = svc ? (t.hit1 ? "✔" : t.hit3 ? "~" : "✘") : t.falsePositive ? "✘ false alarm" : "✔ quiet";
    console.log(`${mark}  ${(svc ?? "—").padEnd(10)} ${t.fault.padEnd(14)} ranking=[${t.ranking.join(", ")}]  detected=${t.detectedAfterS ?? "never"}s`);
  }
  load.stop();
  stack.stop();

  const faulty = trials.filter((t) => t.service);
  const controls = trials.filter((t) => !t.service);
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
  const detected = faulty.filter((t) => t.detectedAfterS !== null).map((t) => t.detectedAfterS!);
  const summary = {
    trials: faulty.length,
    top1: pct(faulty.filter((t) => t.hit1).length, faulty.length),
    top3: pct(faulty.filter((t) => t.hit3).length, faulty.length),
    baselineHighestP95Top1: pct(faulty.filter((t) => t.naiveP95Hit).length, faulty.length),
    baselineHighestLatencyRatioTop1: pct(faulty.filter((t) => t.naiveRatioHit).length, faulty.length),
    medianTimeToTop1Seconds: detected.length ? detected.sort((a, b) => a - b)[Math.floor(detected.length / 2)] : null,
    falsePositivesOnControls: `${controls.filter((t) => t.falsePositive).length}/${controls.length}`,
    entryService: ENTRY_SERVICE,
  };
  console.log("\n=== summary ===\n" + JSON.stringify(summary, null, 2));
  fs.writeFileSync("eval-results.json", JSON.stringify({ summary, trials }, null, 2));
  process.exit(0);
})();
