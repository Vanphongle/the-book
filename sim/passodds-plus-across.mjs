// Sim: Pass $10 + max 3-4-5x odds, PLUS $10 place bets across.
//   node sim/passodds-plus-across.mjs [runs] [rollsPerRun]   (default 1M × 100)
// Variants: baseline (no places) · all six placed · across-minus-point (5 numbers).
// Machine rules: places off on come-out; odds behind the point; place 9:5/7:5/7:6.

const RUNS = Number(process.argv[2]) || 1_000_000;
const ROLLS = Number(process.argv[3]) || 100;

const IS_POINT = new Set([4, 5, 6, 8, 9, 10]);
const PLACE_PAY = { 4: 18, 5: 14, 6: 70 / 6, 8: 70 / 6, 9: 14, 10: 18 }; // $10 place winnings
const ODDS_345 = { 4: 30, 5: 40, 6: 50, 8: 50, 9: 40, 10: 30 };

function simulate({ placeAll, skipPoint }) {
  const nets = new Float64Array(RUNS);
  let sumDD = 0, down300 = 0, down500 = 0, evSum = 0;

  for (let r = 0; r < RUNS; r++) {
    let net = 0, minNet = 0, point = 0;
    for (let i = 0; i < ROLLS; i++) {
      const t = 1 + ((Math.random() * 6) | 0) + 1 + ((Math.random() * 6) | 0);
      const ptOn = point !== 0;
      let d = 0;

      // place bets (off on come-out)
      if (placeAll && ptOn) {
        const active = skipPoint ? 5 : 6; // numbers working
        if (t === 7) d -= active * 10;
        else if (IS_POINT.has(t) && !(skipPoint && t === point)) d += PLACE_PAY[t];
      }

      // pass line + max odds
      if (!ptOn) {
        if (t === 7 || t === 11) d += 10;
        else if (t === 2 || t === 3 || t === 12) d -= 10;
      } else if (t === point) {
        d += 10 + 60; // flat + odds (345x always wins $60)
      } else if (t === 7) {
        d -= 10 + ODDS_345[point];
      }

      if (!ptOn) { if (IS_POINT.has(t)) point = t; }
      else if (t === 7 || t === point) point = 0;

      net += d;
      evSum += d;
      if (net < minNet) minNet = net;
    }
    nets[r] = net;
    sumDD += -minNet;
    if (minNet <= -300) down300++;
    if (minNet <= -500) down500++;
  }

  nets.sort();
  const pct = (p) => nets[Math.min(RUNS - 1, Math.floor(p * RUNS))];
  const firstAhead = nets.findIndex((v) => v > 0);
  return {
    mean: evSum / RUNS,
    pWin: firstAhead === -1 ? 0 : (RUNS - firstAhead) / RUNS,
    p5: pct(0.05), median: pct(0.5), p95: pct(0.95),
    best: nets[RUNS - 1], worst: nets[0],
    avgDD: sumDD / RUNS, down300: down300 / RUNS, down500: down500 / RUNS,
  };
}

const f = (n) => (n < 0 ? "-$" : "+$") + Math.abs(n).toFixed(2);
const pc = (x) => (x * 100).toFixed(2) + "%";

console.log(`${RUNS.toLocaleString()} runs × ${ROLLS} rolls each\n`);
for (const [name, cfg] of [
  ["Pass $10 + max odds (baseline, no places)", { placeAll: false }],
  ["Pass $10 + max odds + $10 place ALL SIX", { placeAll: true, skipPoint: false }],
  ["Pass $10 + max odds + $10 across MINUS the point (5 numbers)", { placeAll: true, skipPoint: true }],
]) {
  const s = simulate(cfg);
  console.log(`── ${name} ──`);
  console.log(`  EV per ${ROLLS} rolls: ${f(s.mean)} · sessions ahead: ${pc(s.pWin)}`);
  console.log(`  median ${f(s.median)} · p5 ${f(s.p5)} · p95 ${f(s.p95)} · best ${f(s.best)} · worst ${f(s.worst)}`);
  console.log(`  avg drawdown ${f(-s.avgDD)} · ever down $300+: ${pc(s.down300)} · $500+: ${pc(s.down500)}\n`);
}
