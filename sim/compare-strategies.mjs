// Head-to-head craps strategy comparison — machine-accurate rules.
//   node sim/compare-strategies.mjs [runs] [rollsPerRun]   (default 1,000,000 × 100)
//
// Shared engine: pass/don't-pass cycle, 3-4-5x odds, 6x lays, place bets
// (working only while the point is ON, like the bubble machines), field
// (2 double / 12 double). Every strategy sees the same rule set.

const RUNS = Number(process.argv[2]) || 1_000_000;
const ROLLS = Number(process.argv[3]) || 100;

const IS_POINT = new Set([4, 5, 6, 8, 9, 10]);
const FIELD_HIT = new Set([2, 3, 4, 9, 10, 11, 12]);
const PLACE_PAY = { 4: 1.8, 5: 1.4, 6: 7 / 6, 8: 7 / 6, 9: 1.4, 10: 1.8 };
const ODDS_345 = { 4: 30, 5: 40, 6: 50, 8: 50, 9: 40, 10: 30 }; // $10 flat → odds bet
const ODDS_WIN = 60; // 3-4-5x odds always win $60 on a $10 flat
const LAY_6X = 60;
const LAY_WIN = { 4: 30, 5: 40, 6: 50, 8: 50, 9: 40, 10: 30 };

// A strategy is a config; the engine interprets it.
const STRATS = [
  { name: "Pass line $10 (no odds)", pass: 10 },
  { name: "Pass $10 + 3-4-5x odds", pass: 10, odds: true },
  { name: "Don't pass $10 (no lay)", dp: 10 },
  { name: "Don't pass $10 + 6x lay odds", dp: 10, lay: true },
  { name: "Place 6 & 8 ($12 each)", place: { 6: 12, 8: 12 } },
  { name: "Place inside 5-6-8-9 ($10/12/12/10)", place: { 5: 10, 6: 12, 8: 12, 9: 10 } },
  { name: "Iron Cross (field $10 + place 5,6,8) pt-on", place: { 5: 10, 6: 12, 8: 12 }, field: 10, fieldPtOnly: true },
  { name: "YOURS: $60 across + $10 field every roll", place: { 4: 10, 5: 10, 6: 10, 8: 10, 9: 10, 10: 10 }, field: 10 },
  { name: "Field only $10 every roll", field: 10 },
  { name: "Any Seven $10 every roll (reference)", any7: 10 },
];

function simulate(cfg) {
  const placeNums = cfg.place ? Object.keys(cfg.place).map(Number) : [];
  const placeTotal = placeNums.reduce((s, n) => s + cfg.place[n], 0);
  const nets = new Float64Array(RUNS);
  let sumDD = 0, down300 = 0;
  let evSum = 0, exposureSum = 0;

  for (let r = 0; r < RUNS; r++) {
    let net = 0, minNet = 0, point = 0;

    for (let i = 0; i < ROLLS; i++) {
      const d1 = 1 + ((Math.random() * 6) | 0);
      const d2 = 1 + ((Math.random() * 6) | 0);
      const t = d1 + d2;
      const ptOn = point !== 0;
      let delta = 0, exposure = 0;

      // field
      if (cfg.field && (ptOn || !cfg.fieldPtOnly)) {
        exposure += cfg.field;
        if (FIELD_HIT.has(t)) delta += t === 2 || t === 12 ? cfg.field * 2 : cfg.field;
        else delta -= cfg.field;
      }
      // any seven (reference prop)
      if (cfg.any7) {
        exposure += cfg.any7;
        delta += t === 7 ? cfg.any7 * 4 : -cfg.any7;
      }
      // place bets — working only when the point is on
      if (placeTotal && ptOn) {
        exposure += placeTotal;
        if (t === 7) delta -= placeTotal;
        else if (cfg.place[t]) delta += cfg.place[t] * PLACE_PAY[t];
      }
      // pass line (+ optional 3-4-5x odds)
      if (cfg.pass) {
        exposure += cfg.pass + (cfg.odds && ptOn ? ODDS_345[point] : 0);
        if (!ptOn) {
          if (t === 7 || t === 11) delta += cfg.pass;
          else if (t === 2 || t === 3 || t === 12) delta -= cfg.pass;
        } else if (t === point) {
          delta += cfg.pass + (cfg.odds ? ODDS_WIN : 0);
        } else if (t === 7) {
          delta -= cfg.pass + (cfg.odds ? ODDS_345[point] : 0);
        }
      }
      // don't pass (+ optional 6x lay)
      if (cfg.dp) {
        exposure += cfg.dp + (cfg.lay && ptOn ? LAY_6X : 0);
        if (!ptOn) {
          if (t === 7 || t === 11) delta -= cfg.dp;
          else if (t === 2 || t === 3) delta += cfg.dp; // 12 pushes
        } else if (t === 7) {
          delta += cfg.dp + (cfg.lay ? LAY_WIN[point] : 0);
        } else if (t === point) {
          delta -= cfg.dp + (cfg.lay ? LAY_6X : 0);
        }
      }

      // point transition (after resolution)
      if (!ptOn) { if (IS_POINT.has(t)) point = t; }
      else if (t === 7 || t === point) point = 0;

      net += delta;
      evSum += delta;
      exposureSum += exposure;
      if (net < minNet) minNet = net;
    }
    nets[r] = net;
    sumDD += -minNet;
    if (minNet <= -300) down300++;
  }

  nets.sort();
  const mean = evSum / RUNS;
  const pct = (p) => nets[Math.min(RUNS - 1, Math.floor(p * RUNS))];
  const firstAhead = nets.findIndex((v) => v > 0);
  return {
    mean,
    perRoll: mean / ROLLS,
    edge: exposureSum ? evSum / exposureSum : 0,
    pWin: firstAhead === -1 ? 0 : (RUNS - firstAhead) / RUNS,
    p5: pct(0.05), median: pct(0.5), p95: pct(0.95),
    worst: nets[0], best: nets[RUNS - 1],
    avgDD: sumDD / RUNS,
    down300: down300 / RUNS,
  };
}

const f = (n) => (n < 0 ? "-$" : "+$") + Math.abs(n).toFixed(2);
const pc = (x) => (x * 100).toFixed(2) + "%";

console.log(`${RUNS.toLocaleString()} runs × ${ROLLS} rolls per strategy — machine rules (place off on come-out, field 12 double)\n`);
const results = [];
for (const s of STRATS) {
  const t0 = Date.now();
  const r = simulate(s);
  results.push({ name: s.name, ...r });
  console.log(`${s.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`   EV/run ${f(r.mean)} · per roll ${f(r.perRoll)} · house edge ${pc(-r.edge)} of action`);
  console.log(`   ahead after ${ROLLS} rolls: ${pc(r.pWin)} · median ${f(r.median)} · p5 ${f(r.p5)} · p95 ${f(r.p95)}`);
  console.log(`   avg drawdown ${f(-r.avgDD)} · ever down $300+: ${pc(r.down300)} · best ${f(r.best)} · worst ${f(r.worst)}\n`);
}

console.log("── RANKED by expected loss per 100 rolls (least bleed first) ──");
results.sort((a, b) => b.mean - a.mean);
results.forEach((r, i) =>
  console.log(
    `${String(i + 1).padStart(2)}. ${r.name.padEnd(44)} ${f(r.mean).padStart(9)}/run · edge ${pc(-r.edge).padStart(6)} · ahead ${pc(r.pWin)}`
  )
);
