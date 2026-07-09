import { useState, useEffect, useRef } from "react";

// ─── ROULETTE ─────────────────────────────────────────────────────────────────
// Casino-standard roulette, phone-first like the other games:
//   • American double-zero wheel (0 + 00) with a European single-zero toggle
//   • Authentic wheel pocket ORDER (the real casino sequence, not 1-2-3)
//   • Smooth animated spin: the SVG wheel makes 5+ rotations easing out while
//     a ball counter-rotates and drops into the winning pocket
//   • Bets: straight-up 35:1 on every number · red/black · odd/even ·
//     1-18/19-36 (1:1) · dozens & columns (2:1)
//   • Real felt layout (3 wide × 12 tall), history strip, win pop, chip-select
//     → tap-spot betting, floating SPIN, bankroll + bust refill, SIM autopilot
// Nothing here touches The Book's Supabase data.

const LS_BANK = "the-book.roulette.bank.v1";
const START_BANK = 1000;
const CHIPS = [1, 5, 10, 25, 100];

// real wheel orders (clockwise)
const POCKETS_US = ["0","28","9","26","30","11","7","20","32","17","5","22","34","15","3","24","36","13","1","00","27","10","25","29","12","8","19","31","18","6","21","33","16","4","23","35","14","2"];
const POCKETS_EU = ["0","32","15","19","4","21","2","25","17","34","6","27","13","36","11","30","8","23","10","5","24","16","33","1","20","14","31","9","22","18","29","7","28","12","35","3","26"];
const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const colorOf = (n) => (n === "0" || n === "00" ? "green" : REDS.has(Number(n)) ? "red" : "black");

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHIP_COLOR = { 1: "#7a7a7a", 5: "#c0392b", 10: "#2471a3", 25: "#1e8449", 100: "#151515", 500: "#6c3483" };
function ChipStack({ amt, size = 22 }) {
  const den = [500, 100, 25, 10, 5, 1];
  const list = [];
  let rem = Math.round(amt);
  for (const d of den) while (rem >= d && list.length < 6) { list.push(d); rem -= d; }
  const shown = list.reverse();
  const off = 2.5;
  return (
    <span className="rl-mstack" style={{ width: size, height: size + off * Math.max(0, shown.length - 1) }}>
      {shown.map((d, i) => (
        <i key={i} style={{ background: CHIP_COLOR[d], width: size, height: size, bottom: i * off, zIndex: i }}>
          {i === shown.length - 1 && <em>${amt % 1 === 0 ? amt : amt.toFixed(0)}</em>}
        </i>
      ))}
    </span>
  );
}

const emptyBets = () => ({
  straight: {}, // {"17": amt}
  red: 0, black: 0, odd: 0, even: 0, low: 0, high: 0,
  d1: 0, d2: 0, d3: 0, c1: 0, c2: 0, c3: 0,
});
const sumBets = (b) =>
  Object.values(b.straight).reduce((s, v) => s + v, 0) +
  b.red + b.black + b.odd + b.even + b.low + b.high +
  b.d1 + b.d2 + b.d3 + b.c1 + b.c2 + b.c3;

// SVG wheel
function Wheel({ pockets, rot, ballRot, spinning, result, fast }) {
  const dur = fast ? 1.3 : 4.2;
  const seg = 360 / pockets.length;
  const R = 140, Rin = 82;
  const rad = (a) => (a * Math.PI) / 180;
  return (
    <div className="rl-wheelwrap">
      <div className="rl-pointer" />
      <svg
        viewBox="-150 -150 300 300"
        className="rl-wheel"
        style={{
          transform: `rotate(${rot}deg)`,
          transition: spinning ? `transform ${dur}s cubic-bezier(.14,.82,.18,1)` : "none",
        }}
      >
        <circle r="148" fill="#2a1608" />
        <circle r="144" fill="#4a2a10" />
        {pockets.map((n, i) => {
          const a0 = i * seg - seg / 2 - 90;
          const a1 = a0 + seg;
          const x0 = R * Math.cos(rad(a0)), y0 = R * Math.sin(rad(a0));
          const x1 = R * Math.cos(rad(a1)), y1 = R * Math.sin(rad(a1));
          const xi0 = Rin * Math.cos(rad(a0)), yi0 = Rin * Math.sin(rad(a0));
          const xi1 = Rin * Math.cos(rad(a1)), yi1 = Rin * Math.sin(rad(a1));
          const fill = colorOf(n) === "green" ? "#0d7a3e" : colorOf(n) === "red" ? "#b3271f" : "#141414";
          return (
            <g key={n}>
              <path
                d={`M${xi0},${yi0} L${x0},${y0} A${R},${R} 0 0 1 ${x1},${y1} L${xi1},${yi1} A${Rin},${Rin} 0 0 0 ${xi0},${yi0} Z`}
                fill={fill}
                stroke="#d8b476"
                strokeWidth="0.8"
              />
              <text
                transform={`rotate(${i * seg}) translate(0,-${(R + Rin) / 2 + 14})`}
                textAnchor="middle"
                fill="#f3e4c8"
                fontSize="11"
                fontWeight="700"
                fontFamily="Georgia, serif"
              >
                {n}
              </text>
            </g>
          );
        })}
        <circle r={Rin} fill="#3a2410" stroke="#d8b476" strokeWidth="2" />
        <circle r="30" fill="#241505" stroke="#d8b476" strokeWidth="1.5" />
      </svg>
      <div
        className="rl-ballorbit"
        style={{
          transform: `rotate(${ballRot}deg)`,
          transition: spinning ? `transform ${dur}s cubic-bezier(.2,.75,.25,1)` : "none",
        }}
      >
        <i className={cx("rl-ball", spinning && "drop", fast && "fast")} style={{ animationDuration: `${dur}s` }} />
      </div>
      {result != null && !spinning && (
        <div className={cx("rl-resultnum", colorOf(result))}>{result}</div>
      )}
    </div>
  );
}

export default function Roulette() {
  const [bank, setBank] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS_BANK));
    return v > 0 ? v : START_BANK;
  });
  useEffect(() => localStorage.setItem(LS_BANK, String(bank)), [bank]);
  const bankRef = useRef(bank);
  const payBank = (d) => { bankRef.current += d; setBank(bankRef.current); };

  const [euro, setEuro] = useState(false);
  const pockets = euro ? POCKETS_EU : POCKETS_US;

  const G = useRef({
    phase: "bet", // bet | spinning | done
    bets: emptyBets(),
    lastBets: null,
    history: [], // winning numbers
    msg: "Place your bets.",
    result: null,
    winNet: 0,
    winKey: 0,
  });
  const [tick, setTick] = useState(0);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const rr = () => { if (aliveRef.current) setTick((t) => t + 1); };
  const [chip, setChip] = useState(5);
  const [rot, setRot] = useState(0);
  const [ballRot, setBallRot] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const g = G.current;

  // ── SIM ──
  const [simOpen, setSimOpen] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [simCfg, setSimCfg] = useState({ strat: "red", unit: 10 });
  const [simStats, setSimStats] = useState(null);
  const simRef = useRef({ running: false, busy: false, spins: 0, startBank: 0, startRefill: 0, prog: 0 });
  const refillAddRef = useRef(0);

  const betting = g.phase === "bet" || g.phase === "done";
  const onBoard = sumBets(g.bets);

  function addBet(path) {
    if (!betting) return;
    if (bankRef.current < chip) { g.msg = "Not enough credits."; rr(); return; }
    if (g.phase === "done") { g.phase = "bet"; g.msg = ""; }
    payBank(-chip);
    if (Array.isArray(path)) {
      const n = path[1];
      g.bets = { ...g.bets, straight: { ...g.bets.straight, [n]: (g.bets.straight[n] || 0) + chip } };
    } else {
      g.bets = { ...g.bets, [path]: g.bets[path] + chip };
    }
    rr();
  }
  function clearBetSpot(path) {
    if (!betting) return;
    if (Array.isArray(path)) {
      const n = path[1];
      const amt = g.bets.straight[n] || 0;
      if (!amt) return;
      payBank(amt);
      const st = { ...g.bets.straight };
      delete st[n];
      g.bets = { ...g.bets, straight: st };
    } else {
      const amt = g.bets[path];
      if (!amt) return;
      payBank(amt);
      g.bets = { ...g.bets, [path]: 0 };
    }
    rr();
  }

  async function spin() {
    if (!betting || spinning) return;
    if (sumBets(g.bets) === 0 && g.lastBets && sumBets(g.lastBets) > 0) {
      if (bankRef.current < sumBets(g.lastBets)) { g.msg = "Not enough credits to rebet."; rr(); return; }
      payBank(-sumBets(g.lastBets));
      g.bets = JSON.parse(JSON.stringify(g.lastBets));
    }
    if (sumBets(g.bets) === 0) { g.msg = "Tap the felt to bet first."; rr(); return; }

    g.lastBets = JSON.parse(JSON.stringify(g.bets));
    g.phase = "spinning";
    g.msg = "No more bets…";
    g.result = null;
    g.winNet = 0;
    rr();

    // pick the pocket, then animate the wheel to land it under the pointer
    const idx = Math.floor(Math.random() * pockets.length);
    const seg = 360 / pockets.length;
    const spins = simRef.current.running ? 2 : 5;
    const targetMod = (360 - idx * seg) % 360; // wheel rotation that puts pocket idx at top
    const current = ((rot % 360) + 360) % 360;
    const delta = (targetMod - current + 360) % 360 + spins * 360;
    setSpinning(true);
    setRot(rot + delta);
    setBallRot(ballRot - (spins + 3) * 360); // counter-spin, ends at top with the pocket
    await sleep(simRef.current.running ? 1400 : 4300);

    const n = pockets[idx];
    settle(n);
    setSpinning(false);
  }

  function settle(n) {
    const b = g.bets;
    const staked = sumBets(b);
    let credit = 0;
    const num = n === "00" ? -1 : Number(n);
    const isNum = num >= 1;
    if (b.straight[n]) credit += b.straight[n] * 36; // 35:1 + stake
    if (isNum) {
      if (b.red && REDS.has(num)) credit += b.red * 2;
      if (b.black && !REDS.has(num)) credit += b.black * 2;
      if (b.odd && num % 2 === 1) credit += b.odd * 2;
      if (b.even && num % 2 === 0) credit += b.even * 2;
      if (b.low && num <= 18) credit += b.low * 2;
      if (b.high && num >= 19) credit += b.high * 2;
      if (b.d1 && num <= 12) credit += b.d1 * 3;
      if (b.d2 && num >= 13 && num <= 24) credit += b.d2 * 3;
      if (b.d3 && num >= 25) credit += b.d3 * 3;
      const col = ((num - 1) % 3) + 1;
      if (b.c1 && col === 1) credit += b.c1 * 3;
      if (b.c2 && col === 2) credit += b.c2 * 3;
      if (b.c3 && col === 3) credit += b.c3 * 3;
    }
    if (credit > 0) payBank(credit);
    g.result = n;
    g.winNet = credit - staked;
    g.winKey = Math.random();
    g.history = [n, ...g.history].slice(0, 24);
    g.bets = emptyBets();
    g.msg = `${n} ${colorOf(n).toUpperCase()}${credit > 0 ? ` — paid ${money(credit)}` : ""}`;
    g.phase = "done";
    if (bankRef.current < CHIPS[0]) {
      refillAddRef.current += START_BANK - bankRef.current;
      payBank(START_BANK - bankRef.current);
      g.msg += " · Busted — bankroll refilled to $1,000.";
    }
    rr();
  }

  function resetBank() {
    if (spinning) return;
    if (!window.confirm("Reset play bankroll to $1,000?")) return;
    for (const [k, v] of Object.entries(g.bets)) {
      if (k === "straight") for (const amt of Object.values(v)) payBank(amt);
      else if (v) payBank(v);
    }
    g.bets = emptyBets();
    payBank(START_BANK - bankRef.current);
    g.msg = "Fresh bankroll. Place your bets.";
    rr();
  }

  // ── SIM ──
  function simStart() {
    setSimOpen(false);
    for (const [k, v] of Object.entries(g.bets)) {
      if (k === "straight") for (const amt of Object.values(v)) payBank(amt);
      else if (v) payBank(v);
    }
    g.bets = emptyBets();
    simRef.current = { running: true, busy: false, spins: 0, startBank: bankRef.current, startRefill: refillAddRef.current, prog: simCfg.unit };
    setSimStats({ spins: 0, net: 0 });
    setSimRunning(true);
  }
  function simStop() {
    simRef.current.running = false;
    setSimRunning(false);
    const net = bankRef.current - simRef.current.startBank - (refillAddRef.current - simRef.current.startRefill);
    setSimStats({ spins: simRef.current.spins, net });
  }
  async function simTurn() {
    if (g.phase === "spinning") return;
    const mart = simCfg.strat === "mart";
    const net = bankRef.current - simRef.current.startBank - (refillAddRef.current - simRef.current.startRefill);
    setSimStats({ spins: simRef.current.spins, net, next: mart ? simRef.current.prog : null });
    simRef.current.spins++;
    let wager = mart ? simRef.current.prog : simCfg.unit;
    wager = Math.min(wager, bankRef.current);
    if (wager < CHIPS[0]) return;
    if (g.phase === "done") { g.phase = "bet"; }
    payBank(-wager);
    const b = emptyBets();
    if (simCfg.strat === "red" || mart) b.red = wager;
    else if (simCfg.strat === "lucky") b.straight = { "17": wager };
    else if (simCfg.strat === "dozen") b.d1 = wager;
    g.bets = b;
    rr();
    await spin();
    if (mart) {
      const won = g.result != null && colorOf(g.result) === "red";
      simRef.current.prog = won ? simCfg.unit : simRef.current.prog * 2;
    }
  }
  useEffect(() => {
    if (!simRunning || simRef.current.busy) return;
    const t = setTimeout(async () => {
      if (!simRef.current.running || simRef.current.busy) return;
      simRef.current.busy = true;
      try { await simTurn(); } finally {
        simRef.current.busy = false;
        if (aliveRef.current) setTick((x) => x + 1);
      }
    }, 240);
    return () => clearTimeout(t);
  }, [simRunning, tick]); // eslint-disable-line

  // felt cells
  const rows = [];
  for (let r = 0; r < 12; r++) rows.push([3 * r + 1, 3 * r + 2, 3 * r + 3]);

  const StraightCell = ({ n }) => {
    const k = String(n);
    const amt = g.bets.straight[k] || 0;
    return (
      <button className={cx("rl-num", colorOf(k), amt > 0 && "has")} onClick={() => addBet(["straight", k])}>
        {k}
        {amt > 0 && (
          <span className="rl-cellchips">
            <ChipStack amt={amt} size={18} />
            {betting && <u className="rl-x" onClick={(e) => { e.stopPropagation(); clearBetSpot(["straight", k]); }}>✕</u>}
          </span>
        )}
      </button>
    );
  };
  const OutsideCell = ({ k, label, sub, cls }) => (
    <button className={cx("rl-out", cls, g.bets[k] > 0 && "has")} onClick={() => addBet(k)}>
      <b>{label}</b>
      {sub && <i>{sub}</i>}
      {g.bets[k] > 0 && (
        <span className="rl-cellchips">
          <ChipStack amt={g.bets[k]} size={18} />
          {betting && <u className="rl-x" onClick={(e) => { e.stopPropagation(); clearBetSpot(k); }}>✕</u>}
        </span>
      )}
    </button>
  );

  return (
    <div className="rl">
      <style>{CSS}</style>
      <header className="rl-top">
        <a className="rl-back" href="#">←</a>
        <span className="rl-title">ROULETTE</span>
        <label className="rl-euro">
          <input type="checkbox" checked={euro} onChange={(e) => {
            if (!betting) return;
            for (const [k, v] of Object.entries(g.bets)) {
              if (k === "straight") for (const amt of Object.values(v)) payBank(amt);
              else if (v) payBank(v);
            }
            g.bets = emptyBets();
            setEuro(e.target.checked);
            rr();
          }} />
          single 0
        </label>
        <span className="rl-meters">
          <b className="mono">{money(bank)}</b><i>credits</i>
        </span>
        <button className="rl-reset" onClick={resetBank}>Reset</button>
      </header>

      {/* history */}
      <div className="rl-hist">
        {g.history.length === 0 && <span className="rl-hist-empty">winning numbers appear here</span>}
        {g.history.map((n, i) => (
          <em key={i} className={colorOf(n)}>{n}</em>
        ))}
      </div>

      {/* wheel */}
      <Wheel pockets={pockets} rot={rot} ballRot={ballRot} spinning={spinning} result={g.result} fast={simRunning} />
      <div className="rl-msg">{g.msg}&nbsp;</div>

      {g.phase === "done" && g.winNet > 0 && (
        <div className="rl-winpop" key={g.winKey}>
          <span className="rl-winpop-t">YOU WIN</span>
          <span className="rl-winpop-amt mono">+{money(g.winNet)}</span>
        </div>
      )}

      {/* felt */}
      <div className="rl-felt">
        <div className="rl-zeros" style={{ gridTemplateColumns: euro ? "1fr" : "1fr 1fr" }}>
          <StraightCell n={"0"} />
          {!euro && <StraightCell n={"00"} />}
        </div>
        <div className="rl-grid">
          {rows.map((row, i) => row.map((n) => <StraightCell key={n} n={n} />))}
        </div>
        <div className="rl-cols">
          <OutsideCell k="c1" label="COL 1" sub="2:1" />
          <OutsideCell k="c2" label="COL 2" sub="2:1" />
          <OutsideCell k="c3" label="COL 3" sub="2:1" />
        </div>
        <div className="rl-dozens">
          <OutsideCell k="d1" label="1st 12" sub="2:1" />
          <OutsideCell k="d2" label="2nd 12" sub="2:1" />
          <OutsideCell k="d3" label="3rd 12" sub="2:1" />
        </div>
        <div className="rl-evens">
          <OutsideCell k="low" label="1-18" />
          <OutsideCell k="even" label="EVEN" />
          <OutsideCell k="red" label="RED" cls="redcell" />
          <OutsideCell k="black" label="BLACK" cls="blackcell" />
          <OutsideCell k="odd" label="ODD" />
          <OutsideCell k="high" label="19-36" />
        </div>
      </div>

      {/* chips */}
      <footer className="rl-rack">
        {CHIPS.map((c) => (
          <button key={c} className={cx("rl-chip", `c${c}`, chip === c && "sel")} onClick={() => setChip(c)}>
            ${c}
          </button>
        ))}
        <span className="rl-onboard">on felt <b className="mono">{money(onBoard)}</b></span>
      </footer>

      {/* floating SPIN */}
      {betting && !simRunning && (onBoard > 0 || (g.lastBets && sumBets(g.lastBets) > 0)) && (
        <button className="rl-spinfab" onClick={spin}>
          SPIN<small>{money(onBoard || sumBets(g.lastBets || emptyBets()))}</small>
        </button>
      )}

      {/* SIM */}
      <button className={cx("rl-simfab", simRunning && "running")} onClick={() => (simRunning ? simStop() : setSimOpen(true))}>
        {simRunning ? "STOP" : "SIM"}
      </button>
      {simStats && (
        <div className="rl-simstats">
          <span>{simStats.spins} spins{simStats.next ? ` · next ${money(simStats.next)}` : ""}</span>
          <b className={cx("mono", simStats.net >= 0 ? "pos" : "neg")}>
            {simStats.net >= 0 ? "+" : "−"}{money(Math.abs(simStats.net))}
          </b>
        </div>
      )}
      {simOpen && (
        <div className="rl-simpanel">
          <div className="rl-simpanel-title">AUTOPILOT</div>
          {[
            ["red", "Flat bet on RED", "the baseline — 5.26% edge (2.70% on single-zero)"],
            ["mart", "Martingale on RED", "double after every loss — smooth climb, brutal cliffs"],
            ["lucky", "Straight-up on 17", "35:1 hits — long droughts, big spikes"],
            ["dozen", "Flat 1st dozen", "2:1 — wins a third of the time"],
          ].map(([k, lbl, sub]) => (
            <button key={k} className={cx("rl-simstrat", simCfg.strat === k && "on")}
              onClick={() => setSimCfg((c) => ({ ...c, strat: k }))}>
              <b>{lbl}</b>
              <i>{sub}</i>
            </button>
          ))}
          <div className="rl-simamts">
            <span>bet</span>
            {[5, 10, 25, 100].map((a) => (
              <button key={a} className={cx("rl-simamt", simCfg.unit === a && "on")}
                onClick={() => setSimCfg((c) => ({ ...c, unit: a }))}>
                ${a}
              </button>
            ))}
          </div>
          <div className="rl-simgo">
            <button className="rl-simcancel" onClick={() => setSimOpen(false)}>Cancel</button>
            <button className="rl-simstart" onClick={simStart}>▶ START</button>
          </div>
        </div>
      )}
    </div>
  );
}

const CSS = `
.rl{
  --felt:#123a2a; --feltdark:#0a241a; --gold:#d8b476; --red:#c0392b; --ink:#f0ead8; --dim:#b9c9b3;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  font-family:var(--sans); color:var(--ink); min-height:100vh; min-height:100dvh; user-select:none;
  background:radial-gradient(ellipse at 50% -10%, #1c5a40, var(--felt) 45%, var(--feltdark));
  display:flex; flex-direction:column; -webkit-font-smoothing:antialiased;
}
.rl *{box-sizing:border-box;}
.rl .mono{font-family:var(--mono); font-variant-numeric:tabular-nums;}

.rl-top{display:flex; align-items:center; gap:12px; padding:10px 14px; background:rgba(0,0,0,.32); flex-wrap:wrap;}
.rl-back{color:var(--dim); text-decoration:none; font-size:1rem;}
.rl-title{font-size:.78rem; letter-spacing:.24em; color:var(--gold); font-weight:800;}
.rl-euro{display:flex; gap:5px; align-items:center; font-size:.62rem; color:var(--dim); cursor:pointer;}
.rl-meters{display:flex; flex-direction:column; align-items:flex-end; margin-left:auto;}
.rl-meters b{font-size:.9rem;}
.rl-meters i{font-style:normal; font-size:.52rem; text-transform:uppercase; letter-spacing:.12em; color:#8aa892;}
.rl-reset{background:transparent; border:1px solid #3f6b4d; color:#9dbfa4; border-radius:8px; padding:6px 10px; font-size:.66rem; cursor:pointer;}

.rl-hist{display:flex; gap:5px; padding:7px 12px; background:rgba(0,0,0,.22); overflow-x:auto; min-height:38px; align-items:center;}
.rl-hist-empty{font-size:.64rem; color:#8aa892;}
.rl-hist em{font-style:normal; width:24px; height:24px; border-radius:50%; display:flex; align-items:center;
  justify-content:center; font-size:.6rem; font-weight:900; color:#fff; flex-shrink:0;}
.rl-hist em.red{background:#b3271f;} .rl-hist em.black{background:#141414; border:1px solid #444;}
.rl-hist em.green{background:#0d7a3e;}

/* wheel */
.rl-wheelwrap{position:relative; width:min(76vw, 300px); aspect-ratio:1; margin:14px auto 4px;}
.rl-wheel{width:100%; height:100%; display:block; filter:drop-shadow(0 10px 26px rgba(0,0,0,.55));}
.rl-pointer{position:absolute; top:-7px; left:50%; transform:translateX(-50%); z-index:5;
  width:0; height:0; border-left:9px solid transparent; border-right:9px solid transparent; border-top:16px solid var(--gold);
  filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));}
.rl-ballorbit{position:absolute; inset:0; pointer-events:none;}
.rl-ball{position:absolute; left:50%; top:5.5%; width:11px; height:11px; margin-left:-5.5px; border-radius:50%;
  background:radial-gradient(circle at 35% 30%, #fff, #cfcfcf 65%, #8a8a8a); box-shadow:0 1px 3px rgba(0,0,0,.6);}
.rl-ball.drop{animation:rl-balldrop 4.2s cubic-bezier(.3,.6,.4,1) forwards;}
@keyframes rl-balldrop{0%{top:4.5%;} 55%{top:5%;} 80%{top:12%;} 90%{top:17.5%;} 95%{top:16.5%;} 100%{top:17%;}}
.rl-resultnum{position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:52px; height:52px;
  border-radius:50%; display:flex; align-items:center; justify-content:center; font-family:Georgia,serif;
  font-size:1.3rem; font-weight:800; color:#fff; border:2.5px solid var(--gold); animation:rl-rpop .4s cubic-bezier(.2,1.5,.4,1);}
.rl-resultnum.red{background:#b3271f;} .rl-resultnum.black{background:#141414;} .rl-resultnum.green{background:#0d7a3e;}
@keyframes rl-rpop{from{transform:translate(-50%,-50%) scale(.3); opacity:0;} to{transform:translate(-50%,-50%) scale(1); opacity:1;}}

.rl-msg{min-height:24px; font-size:.82rem; color:var(--gold); font-weight:700; text-align:center; padding:2px 10px;}

.rl-winpop{position:fixed; top:30%; left:50%; transform:translate(-50%,-50%); z-index:70; pointer-events:none;
  display:flex; flex-direction:column; align-items:center; gap:2px;
  background:rgba(4,20,13,.88); border:2px solid var(--gold); border-radius:16px; padding:14px 30px;
  animation:rl-pop .5s cubic-bezier(.2,1.6,.4,1), rl-fade .4s ease 1.9s forwards;}
.rl-winpop-t{font-size:.68rem; letter-spacing:.34em; color:var(--gold); font-weight:900;}
.rl-winpop-amt{font-size:1.7rem; font-weight:800; color:var(--gold); text-shadow:0 0 18px rgba(216,180,118,.6);}
@keyframes rl-pop{from{transform:translate(-50%,-50%) scale(.4); opacity:0;} 70%{transform:translate(-50%,-50%) scale(1.1);} to{transform:translate(-50%,-50%) scale(1); opacity:1;}}
@keyframes rl-fade{to{opacity:0;}}

/* felt */
.rl-felt{max-width:430px; width:100%; margin:6px auto 0; padding:0 12px 130px;}
.rl-zeros{display:grid; gap:5px; margin-bottom:5px;}
.rl-grid{display:grid; grid-template-columns:repeat(3,1fr); gap:5px;}
.rl-num{position:relative; min-height:40px; border-radius:8px; border:1.5px solid rgba(216,180,118,.5);
  color:#fff; font-family:Georgia,serif; font-weight:800; font-size:.95rem; cursor:pointer;
  display:flex; align-items:center; justify-content:center; gap:6px;}
.rl-num.red{background:#a2251e;} .rl-num.black{background:#161616;} .rl-num.green{background:#0d7a3e; min-height:44px;}
.rl-num.has{box-shadow:0 0 0 2px var(--gold), 0 0 12px rgba(216,180,118,.35);}
.rl-cols,.rl-dozens{display:grid; grid-template-columns:repeat(3,1fr); gap:5px; margin-top:5px;}
.rl-evens{display:grid; grid-template-columns:repeat(3,1fr); gap:5px; margin-top:5px;}
.rl-out{position:relative; min-height:44px; border-radius:8px; border:1.5px solid rgba(216,180,118,.5);
  background:rgba(0,0,0,.22); color:var(--ink); cursor:pointer; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:1px;}
.rl-out b{font-size:.72rem; font-weight:900; letter-spacing:.06em;}
.rl-out i{font-style:normal; font-size:.52rem; color:var(--dim);}
.rl-out.redcell{background:#a2251e;} .rl-out.blackcell{background:#161616;}
.rl-out.has{box-shadow:0 0 0 2px var(--gold), 0 0 12px rgba(216,180,118,.35);}
.rl-cellchips{display:flex; align-items:flex-end; gap:3px;}
.rl-x{text-decoration:none; font-style:normal; cursor:pointer; color:#ffd9d6; font-size:.56rem;
  background:rgba(0,0,0,.5); border-radius:50%; width:14px; height:14px; display:inline-flex; align-items:center; justify-content:center;}
.rl-mstack{position:relative; display:inline-block; flex-shrink:0;}
.rl-mstack i{position:absolute; left:0; border-radius:50%; border:1.2px dashed rgba(255,255,255,.65);
  box-shadow:0 1px 2px rgba(0,0,0,.5); box-sizing:border-box; display:flex; align-items:center; justify-content:center;}
.rl-mstack i em{font-style:normal; color:#fff; font-size:.4rem; font-weight:900; font-family:var(--mono);}

.rl-rack{position:fixed; left:0; right:0; bottom:0; display:flex; align-items:center; gap:8px;
  padding:8px 14px calc(14px + env(safe-area-inset-bottom)); background:rgba(4,18,12,.94);
  border-top:1px solid #2c4a35; justify-content:center; flex-wrap:wrap; z-index:50;}
.rl-chip{width:40px; height:40px; border-radius:50%; font-weight:800; cursor:pointer; color:#fff;
  border:3px dashed rgba(255,255,255,.6); font-size:.64rem;}
.rl-chip.c1{background:#7a7a7a;} .rl-chip.c5{background:#c0392b;} .rl-chip.c10{background:#2471a3;}
.rl-chip.c25{background:#1e8449;} .rl-chip.c100{background:#111;}
.rl-chip.sel{outline:3px solid var(--gold); outline-offset:2px;}
.rl-onboard{font-size:.6rem; color:var(--dim);}
.rl-onboard b{color:var(--gold);}

.rl-spinfab{position:fixed; right:16px; bottom:calc(76px + env(safe-area-inset-bottom)); z-index:60;
  width:78px; height:78px; border-radius:50%; border:3px solid var(--gold);
  background:radial-gradient(circle at 35% 30%, #d4a940, #8a6c1e); color:#fff; font-weight:900;
  letter-spacing:.08em; font-size:.8rem; cursor:pointer; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:1px; box-shadow:0 6px 18px rgba(0,0,0,.55);}
.rl-spinfab small{font-size:.54rem; font-weight:700; opacity:.92;}
.rl-spinfab:active{transform:translateY(2px);}

.rl-simfab{position:fixed; left:16px; bottom:calc(76px + env(safe-area-inset-bottom)); z-index:60;
  width:58px; height:58px; border-radius:50%; border:2.5px solid #7db8ff; color:#a8ceff;
  background:radial-gradient(circle at 35% 30%, #1d3d63, #10233c); font-weight:900; font-size:.68rem;
  letter-spacing:.08em; cursor:pointer; box-shadow:0 6px 16px rgba(0,0,0,.5);}
.rl-simfab.running{border-color:#ff8c85; color:#ffd9d6;
  background:radial-gradient(circle at 35% 30%, #6e211c, #3c100d); animation:rl-simpulse 1s infinite alternate;}
@keyframes rl-simpulse{from{box-shadow:0 0 0 rgba(232,87,77,.5);} to{box-shadow:0 0 18px rgba(232,87,77,.7);}}
.rl-simstats{position:fixed; left:84px; bottom:calc(84px + env(safe-area-inset-bottom)); z-index:60;
  display:flex; flex-direction:column; gap:1px; background:rgba(4,20,13,.92); border:1px solid #2c4a35;
  border-radius:10px; padding:6px 10px; pointer-events:none;}
.rl-simstats span{font-size:.56rem; color:var(--dim); letter-spacing:.06em;}
.rl-simstats b{font-size:.82rem; font-weight:800;}
.rl-simstats b.pos{color:#7de89b;} .rl-simstats b.neg{color:#ff8c85;}
.rl-simpanel{position:fixed; left:50%; transform:translateX(-50%); bottom:calc(14px + env(safe-area-inset-bottom));
  z-index:75; width:min(420px, calc(100vw - 24px)); background:#07231a; border:2px solid var(--gold);
  border-radius:16px; padding:14px; display:flex; flex-direction:column; gap:8px; box-shadow:0 -8px 40px rgba(0,0,0,.6);}
.rl-simpanel-title{font-size:.62rem; letter-spacing:.24em; color:var(--gold); font-weight:900; text-align:center;}
.rl-simstrat{display:flex; flex-direction:column; gap:3px; text-align:left; padding:10px 12px;
  border:1.5px solid #2c4a35; border-radius:10px; background:rgba(255,255,255,.03); color:var(--ink); cursor:pointer;}
.rl-simstrat.on{border-color:var(--gold); background:rgba(216,180,118,.1);}
.rl-simstrat b{font-size:.74rem; font-weight:800;}
.rl-simstrat i{font-style:normal; font-size:.58rem; color:var(--dim); line-height:1.45;}
.rl-simamts{display:flex; align-items:center; gap:7px;}
.rl-simamts > span{font-size:.58rem; color:var(--dim); letter-spacing:.08em;}
.rl-simamt{flex:1; padding:9px 2px; border:1.5px solid #2c4a35; border-radius:9px; background:transparent;
  color:var(--ink); font-weight:800; font-size:.72rem; cursor:pointer; font-family:var(--mono);}
.rl-simamt.on{border-color:var(--gold); background:rgba(216,180,118,.14); color:var(--gold);}
.rl-simgo{display:flex; gap:8px;}
.rl-simcancel{flex:1; padding:11px; border:1.5px solid #2c4a35; border-radius:10px; background:transparent;
  color:var(--dim); font-weight:700; font-size:.72rem; cursor:pointer;}
.rl-simstart{flex:2; padding:11px; border:2px solid var(--gold); border-radius:10px;
  background:linear-gradient(#8a6c1e,#5e4a12); color:#fff; font-weight:900; letter-spacing:.1em; font-size:.78rem; cursor:pointer;}
`;
