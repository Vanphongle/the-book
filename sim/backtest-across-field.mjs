// Backtest: $10 place on 4,5,6,8,9,10 ($60 across) + $10 field, every roll.
// Machine-accurate pays: place 9:5 / 7:5 / 7:6 (exact cents, like credit machines),
// field 2 pays double, 12 pays double (or triple with a flag).
//
//   node sim/backtest-across-field.mjs [runs] [rollsPerRun]
//   default: 1,000,000 runs × 100 rolls
//
// Variants reported:
//   A) place bets OFF on the come-out (bubble machine default)
//   B) place bets ALWAYS working
//   C) like A but field 12 pays triple
//
// No database needed — pure simulation; prints aggregate stats.

const RUNS = Number(process.argv[2]) || 1_000_000;
const ROLLS = Number(process.argv[3]) || 100;

const PLACE = 10; // per number
const FIELD = 10;
const ACROSS = PLACE * 6; // 60 on the board

// payout per winning place number (winnings only, bet stays up)
const PLACE_WIN = { 4: PLACE * 1.8, 5: PLACE * 1.4, 6: PLACE * 7 / 6, 8: PLACE * 7 / 6, 9: PLACE * 1.4, 10: PLACE * 1.8 };
const IS_POINT = new Set([4, 5, 6, 8, 9, 10]);
const FIELD_HIT = new Set([2, 3, 4, 9, 10, 11, 12]);

function simulate({ placeOffComeOut, field12Triple }) {
  const nets = new Float64Array(RUNS);
  let sumDrawdown = 0;
  let bust300 = 0, bust500 = 0, bust1000 = 0;
  let totalFieldWager = 0, totalPlaceLoss = 0; // for edge accounting

  for (let r = 0; r < RUNS; r++) {
    let net = 0;
    let minNet = 0;
    let point = 0; // 0 = come-out

    for (let i = 0; i < ROLLS; i++) {
      const d1 = 1 + ((Math.random() * 6) | 0);
      const d2 = 1 + ((Math.random() * 6) | 0);
      const t = d1 + d2;

      // field — every roll
      totalFieldWager += FIELD;
      if (FIELD_HIT.has(t)) {
        net += t === 2 ? FIELD * 2 : t === 12 ? FIELD * (field12Triple ? 3 : 2) : FIELD;
      } else {
        net -= FIELD;
      }

      const placeWorking = point !== 0 || !placeOffComeOut;

      if (placeWorking) {
        if (t === 7) {
          net -= ACROSS; // all six swept; we re-buy (cost realized here)
          totalPlaceLoss += ACROSS;
        } else if (IS_POINT.has(t)) {
          net += PLACE_WIN[t];
        }
      }

      // point bookkeeping (pass-line cycle drives the come-out state)
      if (point === 0) {
        if (IS_POINT.has(t)) point = t;
      } else if (t === 7 || t === point) {
        point = 0;
      }

      if (net < minNet) minNet = net;
    }

    nets[r] = net;
    sumDrawdown += -minNet;
    if (minNet <= -300) bust300++;
    if (minNet <= -500) bust500++;
    if (minNet <= -1000) bust1000++;
  }

  nets.sort();
  const mean = nets.reduce((s, v) => s + v, 0) / RUNS;
  const pct = (p) => nets[Math.min(RUNS - 1, Math.floor(p * RUNS))];
  const winners = nets.findIndex((v) => v > 0);
  const pWin = winners === -1 ? 0 : (RUNS - winners) / RUNS;
  const breakeven = nets.findIndex((v) => v >= 0);
  const pNonLosing = breakeven === -1 ? 0 : (RUNS - breakeven) / RUNS;

  return {
    mean,
    perRoll: mean / ROLLS,
    pWin,
    pNonLosing,
    p5: pct(0.05), p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p95: pct(0.95),
    best: nets[RUNS - 1], worst: nets[0],
    avgDrawdown: sumDrawdown / RUNS,
    bust300: bust300 / RUNS, bust500: bust500 / RUNS, bust1000: bust1000 / RUNS,
  };
}

const fmt = (n) => (n < 0 ? "-$" : "+$") + Math.abs(n).toFixed(2);
const pc = (x) => (x * 100).toFixed(2) + "%";

console.log(`Strategy: $${PLACE} place on 4,5,6,8,9,10 ($${ACROSS} across) + $${FIELD} field, every roll`);
console.log(`Backtest: ${RUNS.toLocaleString()} runs × ${ROLLS} rolls  (${(RUNS * ROLLS / 1e6).toLocaleString()}M dice rolls per variant)\n`);

for (const [name, cfg] of [
  ["A · machine default (place OFF on come-out, field 12 double)", { placeOffComeOut: true, field12Triple: false }],
  ["B · place ALWAYS working, field 12 double", { placeOffComeOut: false, field12Triple: false }],
  ["C · machine default + field 12 TRIPLE", { placeOffComeOut: true, field12Triple: true }],
]) {
  const t0 = Date.now();
  const s = simulate(cfg);
  console.log(`── ${name} ──  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`  expected result per ${ROLLS}-roll run : ${fmt(s.mean)}   (per roll ${fmt(s.perRoll)})`);
  console.log(`  runs that finish ahead              : ${pc(s.pWin)}   (>= break-even ${pc(s.pNonLosing)})`);
  console.log(`  distribution  p5 ${fmt(s.p5)} · p25 ${fmt(s.p25)} · median ${fmt(s.median)} · p75 ${fmt(s.p75)} · p95 ${fmt(s.p95)}`);
  console.log(`  best run ${fmt(s.best)} · worst run ${fmt(s.worst)}`);
  console.log(`  avg worst-moment drawdown per run   : ${fmt(-s.avgDrawdown)}`);
  console.log(`  chance of being down $300+ / $500+ / $1000+ at some point: ${pc(s.bust300)} / ${pc(s.bust500)} / ${pc(s.bust1000)}\n`);
}
