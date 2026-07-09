import { useState, useEffect, useRef } from "react";

// ─── BACCARAT (punto banco) ───────────────────────────────────────────────────
// Casino-standard baccarat, phone-first like the other games:
//   • 8-deck shoe, cut card ~1 deck from the end, reshuffle between rounds
//   • Bets: PLAYER 1:1 · BANKER 1:1 less 5% commission · TIE 8:1
//     · PLAYER PAIR / BANKER PAIR 11:1 (first two cards of that side)
//   • Exact third-card tableau (player draws 0-5; banker by the fixed table)
//   • Bead-road scoreboard, chip-select → tap-spot betting, floating DEAL,
//     win pop, play-money bankroll (localStorage) with bust auto-refill
// Nothing here touches The Book's Supabase data.

const LS_BANK = "the-book.baccarat.bank.v1";
const START_BANK = 1000;
const CHIPS = [5, 10, 25, 100, 500];
const DECKS = 8;

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const BVAL = (r) => (r === "A" ? 1 : ["10", "J", "Q", "K"].includes(r) ? 0 : Number(r));
const total = (cards) => cards.reduce((s, c) => s + BVAL(c.r), 0) % 10;

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newShoe() {
  const shoe = [];
  for (let d = 0; d < DECKS; d++)
    for (const s of SUITS) for (const r of RANKS) shoe.push({ r, s });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

const CHIP_COLOR = { 1: "#7a7a7a", 5: "#c0392b", 10: "#2471a3", 25: "#1e8449", 100: "#151515", 500: "#6c3483" };
function ChipStack({ amt, size = 26 }) {
  const den = [500, 100, 25, 10, 5, 1];
  const list = [];
  let rem = Math.round(amt);
  for (const d of den) while (rem >= d && list.length < 6) { list.push(d); rem -= d; }
  const shown = list.reverse();
  const off = 3;
  return (
    <span className="bc-mstack" style={{ width: size, height: size + off * Math.max(0, shown.length - 1) }}>
      {shown.map((d, i) => (
        <i key={i} style={{ background: CHIP_COLOR[d], width: size, height: size, bottom: i * off, zIndex: i }}>
          {i === shown.length - 1 && <em>${amt % 1 === 0 ? amt : amt.toFixed(0)}</em>}
        </i>
      ))}
    </span>
  );
}

function Card({ c, fresh }) {
  const red = c && (c.s === "♥" || c.s === "♦");
  return (
    <div className={cx("bc-card", fresh && "fresh")}>
      <div className={cx("bc-face", red && "red")}>
        <span className="bc-idx">{c?.r}<em>{c?.s}</em></span>
        <span className="bc-pip">{c?.s}</span>
      </div>
    </div>
  );
}

const emptyBets = () => ({ player: 0, banker: 0, tie: 0, ppair: 0, bpair: 0 });
const sumB = (b) => b.player + b.banker + b.tie + b.ppair + b.bpair;

export default function Baccarat() {
  const [bank, setBank] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS_BANK));
    return v > 0 ? v : START_BANK;
  });
  useEffect(() => localStorage.setItem(LS_BANK, String(bank)), [bank]);
  const bankRef = useRef(bank);
  const payBank = (d) => { bankRef.current += d; setBank(bankRef.current); };

  const G = useRef({
    shoe: newShoe(),
    phase: "bet", // bet | dealing | done
    p: [], b: [],
    bets: emptyBets(),
    lastBets: null,
    road: [], // {w:"P"|"B"|"T", pp, bp}
    msg: "Place your bets.",
    freshIds: new Set(),
    winNet: 0,
    winKey: 0,
  });
  const [tick, setTick] = useState(0);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const rr = () => { if (aliveRef.current) setTick((t) => t + 1); };
  const [chip, setChip] = useState(25);
  const g = G.current;

  // ── SIM autopilot ──
  const [simOpen, setSimOpen] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [simCfg, setSimCfg] = useState({ strat: "banker", unit: 25 });
  const [simStats, setSimStats] = useState(null);
  const simRef = useRef({ running: false, busy: false, hands: 0, startBank: 0, startRefill: 0 });
  const refillAddRef = useRef(0);
  const nap = (ms) => sleep(simRef.current.running ? Math.min(ms, 110) : ms);

  const betting = g.phase === "bet" || g.phase === "done";
  const onBoard = sumB(g.bets);

  function placeBet(k) {
    if (!betting) return;
    if (bankRef.current < chip) { g.msg = "Not enough credits."; rr(); return; }
    if (g.phase === "done") { g.p = []; g.b = []; g.phase = "bet"; g.msg = ""; }
    payBank(-chip);
    g.bets = { ...g.bets, [k]: g.bets[k] + chip };
    rr();
  }
  function clearBet(k) {
    if (!betting || !g.bets[k]) return;
    payBank(g.bets[k]);
    g.bets = { ...g.bets, [k]: 0 };
    rr();
  }

  function drawCard(side) {
    if (!g.shoe.length) g.shoe = newShoe();
    const c = g.shoe.pop();
    c.id = Math.random();
    side.push(c);
    g.freshIds = new Set([c.id]);
    rr();
  }

  async function deal() {
    if (!betting) return;
    // rebet if the felt is empty
    if (sumB(g.bets) === 0 && g.lastBets && sumB(g.lastBets) > 0) {
      if (bankRef.current < sumB(g.lastBets)) { g.msg = "Not enough credits to rebet."; rr(); return; }
      payBank(-sumB(g.lastBets));
      g.bets = { ...g.lastBets };
    }
    if (sumB(g.bets) === 0) { g.msg = "Tap a spot to bet first."; rr(); return; }

    if (g.shoe.length < 52) {
      g.shoe = newShoe();
      g.msg = "Shuffling a fresh shoe…";
      rr();
      await nap(800);
    }

    g.lastBets = { ...g.bets };
    g.phase = "dealing";
    g.p = []; g.b = [];
    g.msg = "";
    g.winNet = 0;
    rr();

    drawCard(g.p); await nap(300);
    drawCard(g.b); await nap(300);
    drawCard(g.p); await nap(300);
    drawCard(g.b); await nap(380);

    let pt = total(g.p), bt = total(g.b);
    const natural = pt >= 8 || bt >= 8;
    if (natural) {
      g.msg = `Natural ${Math.max(pt, bt)}!`;
      rr();
      await nap(500);
    } else {
      // player tableau: draw on 0-5
      let p3 = null;
      if (pt <= 5) {
        g.msg = "Player draws…";
        rr();
        await nap(420);
        drawCard(g.p);
        p3 = g.p[2];
        await nap(380);
      }
      // banker tableau
      const p3v = p3 ? BVAL(p3.r) : null;
      bt = total(g.b);
      const bankerDraws =
        p3 === null ? bt <= 5 :
        bt <= 2 ? true :
        bt === 3 ? p3v !== 8 :
        bt === 4 ? p3v >= 2 && p3v <= 7 :
        bt === 5 ? p3v >= 4 && p3v <= 7 :
        bt === 6 ? p3v >= 6 && p3v <= 7 : false;
      if (bankerDraws) {
        g.msg = "Banker draws…";
        rr();
        await nap(420);
        drawCard(g.b);
        await nap(380);
      }
    }

    // settle
    pt = total(g.p); bt = total(g.b);
    const w = pt > bt ? "P" : bt > pt ? "B" : "T";
    const pp = g.p[0].r === g.p[1].r;
    const bp = g.b[0].r === g.b[1].r;
    const bets = g.bets;
    const staked = sumB(bets);
    let credit = 0;
    const notes = [];

    if (w === "P") {
      notes.push(`PLAYER wins ${pt} over ${bt}`);
      if (bets.player) credit += bets.player * 2;
    } else if (w === "B") {
      notes.push(`BANKER wins ${bt} over ${pt}`);
      if (bets.banker) credit += bets.banker + bets.banker * 0.95; // 5% commission
    } else {
      notes.push(`TIE at ${pt}`);
      if (bets.tie) credit += bets.tie * 9; // 8:1
      credit += bets.player + bets.banker; // P/B push on tie
    }
    if (bets.ppair) { if (pp) { credit += bets.ppair * 12; notes.push("Player pair 11:1"); } }
    if (bets.bpair) { if (bp) { credit += bets.bpair * 12; notes.push("Banker pair 11:1"); } }

    if (credit > 0) payBank(credit);
    g.winNet = credit - staked;
    g.winKey = Math.random();
    g.road = [...g.road, { w, pp, bp }].slice(-72);
    g.bets = emptyBets();
    g.msg = notes.join(" · ");
    g.phase = "done";

    // busted → refill
    if (bankRef.current < CHIPS[0]) {
      refillAddRef.current += START_BANK - bankRef.current;
      payBank(START_BANK - bankRef.current);
      g.msg += " · Busted — bankroll refilled to $1,000.";
    }
    rr();
  }

  // ── SIM: pick a spot, deal, repeat ──
  function lastWinner() {
    for (let i = g.road.length - 1; i >= 0; i--) {
      if (g.road[i].w === "P") return "player";
      if (g.road[i].w === "B") return "banker";
    }
    return null;
  }
  function simStart() {
    setSimOpen(false);
    // refund anything already on the felt so the sim starts clean
    for (const k of Object.keys(g.bets)) if (g.bets[k]) payBank(g.bets[k]);
    g.bets = emptyBets();
    simRef.current = {
      running: true, busy: false, hands: 0,
      startBank: bankRef.current, startRefill: refillAddRef.current,
      prog: simCfg.unit, streak: 0, // progression state (martingale / paroli)
    };
    setSimStats({ hands: 0, net: 0 });
    setSimRunning(true);
  }
  function simStop() {
    simRef.current.running = false;
    setSimRunning(false);
    const net = bankRef.current - simRef.current.startBank - (refillAddRef.current - simRef.current.startRefill);
    setSimStats({ hands: simRef.current.hands, net });
  }
  async function simTurn() {
    if (g.phase === "dealing") return;
    const progression = simCfg.strat === "martingale" || simCfg.strat === "paroli";
    const net = bankRef.current - simRef.current.startBank - (refillAddRef.current - simRef.current.startRefill);
    setSimStats({ hands: simRef.current.hands, net, next: progression ? simRef.current.prog : null });
    simRef.current.hands++;

    const k = simCfg.strat === "streak" ? lastWinner() || "banker" : progression ? "banker" : simCfg.strat;
    let wager = progression ? simRef.current.prog : simCfg.unit;
    wager = Math.min(wager, bankRef.current); // bankroll is the wall martingale hits
    if (wager < CHIPS[0]) return; // wait for the bust refill
    if (g.phase === "done") { g.p = []; g.b = []; g.phase = "bet"; }
    payBank(-wager);
    g.bets = { ...emptyBets(), [k]: wager };
    rr();
    await deal();

    // progression bookkeeping off the result (ties push — bet repeats unchanged)
    if (progression) {
      const last = g.road[g.road.length - 1];
      if (last && last.w === "B") {
        if (simCfg.strat === "martingale") simRef.current.prog = simCfg.unit;
        else {
          simRef.current.streak++;
          if (simRef.current.streak >= 3) { simRef.current.streak = 0; simRef.current.prog = simCfg.unit; }
          else simRef.current.prog = wager * 2;
        }
      } else if (last && last.w === "P") {
        if (simCfg.strat === "martingale") simRef.current.prog = wager * 2;
        else { simRef.current.prog = simCfg.unit; simRef.current.streak = 0; }
      }
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

  function resetBank() {
    if (g.phase === "dealing") return;
    if (!window.confirm("Reset play bankroll to $1,000?")) return;
    payBank(START_BANK - bankRef.current);
    g.bets = emptyBets();
    g.msg = "Fresh bankroll. Place your bets.";
    rr();
  }

  const pt = g.p.length ? total(g.p) : null;
  const bt = g.b.length ? total(g.b) : null;

  const SPOTS = [
    ["player", "PLAYER", "pays 1:1", "pl"],
    ["tie", "TIE", "pays 8:1", "tie"],
    ["banker", "BANKER", "1:1 · 5% comm.", "bk"],
  ];

  return (
    <div className="bc">
      <style>{CSS}</style>
      <header className="bc-top">
        <a className="bc-back" href="#">←</a>
        <span className="bc-title">BACCARAT</span>
        <span className="bc-shoe">🂠 {g.shoe.length}</span>
        <span className="bc-meters">
          <b className="mono">{money(bank)}</b><i>credits</i>
        </span>
        <button className="bc-reset" onClick={resetBank}>Reset</button>
      </header>

      {/* bead road */}
      <div className="bc-road">
        {g.road.length === 0 && <span className="bc-road-empty">results appear here — 🔵 player · 🔴 banker · 🟢 tie</span>}
        <div className="bc-beads">
          {g.road.map((r, i) => (
            <span key={i} className={cx("bc-bead", r.w)}>
              {r.w}
              {(r.pp || r.bp) && <i className={cx("pairdot", r.pp && r.bp ? "both" : r.pp ? "p" : "b")} />}
            </span>
          ))}
        </div>
      </div>

      {/* table */}
      <div className="bc-table">
        <section className="bc-hand">
          <div className="bc-hand-label bk">
            BANKER {bt != null && <b>{bt}</b>}
          </div>
          <div className="bc-cards">
            {g.b.map((c) => <Card key={c.id} c={c} fresh={g.freshIds.has(c.id)} />)}
            {!g.b.length && <div className="bc-slot" />}
          </div>
        </section>

        <section className="bc-hand">
          <div className="bc-hand-label pl">
            PLAYER {pt != null && <b>{pt}</b>}
          </div>
          <div className="bc-cards">
            {g.p.map((c) => <Card key={c.id} c={c} fresh={g.freshIds.has(c.id)} />)}
            {!g.p.length && <div className="bc-slot" />}
          </div>
        </section>

        {g.phase === "done" && g.winNet > 0 && (
          <div className="bc-winpop" key={g.winKey}>
            <span className="bc-winpop-t">YOU WIN</span>
            <span className="bc-winpop-amt mono">+{money(g.winNet)}</span>
          </div>
        )}
        <div className="bc-msg">{g.msg}&nbsp;</div>

        {/* bet spots */}
        <div className="bc-spots">
          {SPOTS.map(([k, lbl, pays, tone]) => (
            <button key={k} className={cx("bc-spot", tone, g.bets[k] > 0 && "has")} onClick={() => placeBet(k)}>
              <b>{lbl}</b>
              <i>{pays}</i>
              {g.bets[k] > 0 && (
                <span className="bc-spot-chips">
                  <ChipStack amt={g.bets[k]} />
                  {betting && <u className="bc-x" onClick={(e) => { e.stopPropagation(); clearBet(k); }}>✕</u>}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="bc-spots small">
          {[["ppair", "PLAYER PAIR", "11:1", "pl"], ["bpair", "BANKER PAIR", "11:1", "bk"]].map(([k, lbl, pays, tone]) => (
            <button key={k} className={cx("bc-spot sm", tone, g.bets[k] > 0 && "has")} onClick={() => placeBet(k)}>
              <b>{lbl}</b>
              <i>{pays}</i>
              {g.bets[k] > 0 && (
                <span className="bc-spot-chips">
                  <ChipStack amt={g.bets[k]} size={22} />
                  {betting && <u className="bc-x" onClick={(e) => { e.stopPropagation(); clearBet(k); }}>✕</u>}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* chips */}
      <footer className="bc-rack">
        {CHIPS.map((c) => (
          <button key={c} className={cx("bc-chip", `c${c}`, chip === c && "sel")} onClick={() => setChip(c)}>
            ${c}
          </button>
        ))}
        <span className="bc-onboard">on felt <b className="mono">{money(onBoard)}</b></span>
      </footer>

      {/* floating DEAL */}
      {betting && !simRunning && (onBoard > 0 || (g.lastBets && sumB(g.lastBets) > 0)) && (
        <button className="bc-dealfab" onClick={deal}>
          DEAL<small>{money(onBoard || sumB(g.lastBets || {}) || 0)}</small>
        </button>
      )}

      {/* SIM autopilot */}
      <button className={cx("bc-simfab", simRunning && "running")} onClick={() => (simRunning ? simStop() : setSimOpen(true))}>
        {simRunning ? "STOP" : "SIM"}
      </button>
      {simStats && (
        <div className="bc-simstats">
          <span>{simStats.hands} hands{simStats.next ? ` · next bet ${money(simStats.next)}` : ""}</span>
          <b className={cx("mono", simStats.net >= 0 ? "pos" : "neg")}>
            {simStats.net >= 0 ? "+" : "−"}{money(Math.abs(simStats.net))}
          </b>
        </div>
      )}
      {simOpen && (
        <div className="bc-simpanel">
          <div className="bc-simpanel-title">AUTOPILOT</div>
          {[
            ["banker", "Always BANKER", "the best bet in baccarat — 1.06% house edge"],
            ["player", "Always PLAYER", "1.24% edge — nearly as good, no commission math"],
            ["streak", "Follow the streak", "bet whatever won last (superstition — same edge as its parts)"],
            ["martingale", "Martingale on BANKER", "double after every loss, reset on a win — feels unbeatable until the losing streak your bankroll can't double past"],
            ["paroli", "Paroli on BANKER", "the mirror: double after wins (3-step), reset on a loss — same edge, gentler crashes"],
            ["tie", "Always TIE (for science)", "14.4% edge — watch it burn"],
          ].map(([k, lbl, sub]) => (
            <button key={k} className={cx("bc-simstrat", simCfg.strat === k && "on")}
              onClick={() => setSimCfg((c) => ({ ...c, strat: k }))}>
              <b>{lbl}</b>
              <i>{sub}</i>
            </button>
          ))}
          <div className="bc-simamts">
            <span>bet</span>
            {[10, 25, 50, 100].map((a) => (
              <button key={a} className={cx("bc-simamt", simCfg.unit === a && "on")}
                onClick={() => setSimCfg((c) => ({ ...c, unit: a }))}>
                ${a}
              </button>
            ))}
          </div>
          <div className="bc-simgo">
            <button className="bc-simcancel" onClick={() => setSimOpen(false)}>Cancel</button>
            <button className="bc-simstart" onClick={simStart}>▶ START</button>
          </div>
        </div>
      )}
    </div>
  );
}

const CSS = `
.bc{
  --felt:#6d1622; --feltdark:#3f0c13; --linec:#f3e4d2; --gold:#e8c56b;
  --pl:#5aa7d6; --bk:#e8574d; --tiec:#57c07a; --ink:#f6ead9; --dim:#d8b9a8;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  font-family:var(--sans); color:var(--ink); min-height:100vh; min-height:100dvh; user-select:none;
  background:radial-gradient(ellipse at 50% -10%, #8d2130, var(--felt) 45%, var(--feltdark));
  display:flex; flex-direction:column; -webkit-font-smoothing:antialiased;
}
.bc *{box-sizing:border-box;}
.bc .mono{font-family:var(--mono); font-variant-numeric:tabular-nums;}

.bc-top{display:flex; align-items:center; gap:12px; padding:10px 14px; background:rgba(0,0,0,.32); flex-wrap:wrap;}
.bc-back{color:var(--dim); text-decoration:none; font-size:1rem;}
.bc-title{font-size:.78rem; letter-spacing:.24em; color:var(--gold); font-weight:800;}
.bc-shoe{font-size:.7rem; color:var(--dim); margin-left:auto;}
.bc-meters{display:flex; flex-direction:column; align-items:flex-end;}
.bc-meters b{font-size:.9rem;}
.bc-meters i{font-style:normal; font-size:.52rem; text-transform:uppercase; letter-spacing:.12em; color:#b98d92;}
.bc-reset{background:transparent; border:1px solid #7a3a42; color:#c99;
  border-radius:8px; padding:6px 10px; font-size:.66rem; cursor:pointer;}

/* bead road */
.bc-road{background:rgba(0,0,0,.25); padding:7px 10px; min-height:44px; display:flex; align-items:center;}
.bc-road-empty{font-size:.64rem; color:#b98d92;}
.bc-beads{display:grid; grid-auto-flow:column; grid-template-rows:repeat(3, 1fr); gap:4px; overflow-x:auto; max-width:100%;}
.bc-bead{position:relative; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  font-size:.6rem; font-weight:900; color:#fff; flex-shrink:0;}
.bc-bead.P{background:var(--pl);} .bc-bead.B{background:var(--bk);} .bc-bead.T{background:var(--tiec);}
.bc-bead .pairdot{position:absolute; top:-2px; right:-2px; width:8px; height:8px; border-radius:50%; border:1px solid #fff;}
.bc-bead .pairdot.p{background:var(--pl);} .bc-bead .pairdot.b{background:var(--bk);}
.bc-bead .pairdot.both{background:linear-gradient(90deg, var(--pl) 50%, var(--bk) 50%);}

/* table */
.bc-table{flex:1; display:flex; flex-direction:column; align-items:center; width:100%;
  max-width:640px; margin:0 auto; padding:14px 14px 120px;}
.bc-hand{display:flex; flex-direction:column; align-items:center; margin-bottom:8px;}
.bc-hand-label{font-size:.64rem; letter-spacing:.26em; font-weight:900; margin-bottom:7px;}
.bc-hand-label.bk{color:#ffb9b2;} .bc-hand-label.pl{color:#b5d9f2;}
.bc-hand-label b{margin-left:7px; font-family:var(--mono); font-size:.9rem; color:var(--gold);}
.bc-cards{display:flex; min-height:86px;}
.bc-slot{width:60px; height:84px; border:2px dashed rgba(243,228,210,.3); border-radius:8px;}
.bc-card{width:60px; height:84px; margin-right:-14px; filter:drop-shadow(0 4px 6px rgba(0,0,0,.5));}
.bc-card.fresh{animation:bc-dealin .3s cubic-bezier(.2,.8,.3,1);}
@keyframes bc-dealin{from{transform:translate(50px,-60px) rotate(7deg); opacity:0;} to{transform:none; opacity:1;}}
.bc-face{width:100%; height:100%; border-radius:8px; border:1px solid #b9b2a2; position:relative;
  background:linear-gradient(150deg,#fdfbf4,#efe9dc); color:#1d232b; display:flex; align-items:center; justify-content:center;}
.bc-face.red{color:#c22c24;}
.bc-idx{position:absolute; top:4px; left:6px; font-size:.76rem; font-weight:800; line-height:.95; font-family:Georgia,serif;}
.bc-idx em{display:block; font-style:normal; font-size:.64rem;}
.bc-pip{font-size:1.7rem;}

.bc-msg{min-height:26px; font-size:.84rem; color:var(--gold); font-weight:700; text-align:center; padding:2px 10px;}

/* win pop overlay (never shifts layout) */
.bc-winpop{position:fixed; top:32%; left:50%; transform:translate(-50%,-50%); z-index:70; pointer-events:none;
  display:flex; flex-direction:column; align-items:center; gap:2px;
  background:rgba(30,6,10,.85); border:2px solid var(--gold); border-radius:16px; padding:14px 30px;
  animation:bc-pop .5s cubic-bezier(.2,1.6,.4,1), bc-fade .4s ease 1.9s forwards;}
.bc-winpop-t{font-size:.68rem; letter-spacing:.34em; color:var(--gold); font-weight:900;}
.bc-winpop-amt{font-size:1.7rem; font-weight:800; color:var(--gold);
  text-shadow:0 0 18px rgba(232,197,107,.6), 0 2px 4px rgba(0,0,0,.5);}
@keyframes bc-pop{from{transform:translate(-50%,-50%) scale(.4); opacity:0;}
  70%{transform:translate(-50%,-50%) scale(1.1);} to{transform:translate(-50%,-50%) scale(1); opacity:1;}}
@keyframes bc-fade{to{opacity:0;}}

/* spots */
.bc-spots{display:grid; grid-template-columns:1fr 0.8fr 1fr; gap:9px; width:100%; margin-top:8px;}
.bc-spots.small{grid-template-columns:1fr 1fr; margin-top:9px;}
.bc-spot{position:relative; display:flex; flex-direction:column; align-items:center; gap:3px;
  border:2.5px solid; border-radius:14px; background:rgba(0,0,0,.18); padding:13px 6px; cursor:pointer; min-height:78px;}
.bc-spot b{font-size:.82rem; font-weight:900; letter-spacing:.1em;}
.bc-spot i{font-style:normal; font-size:.56rem; color:var(--dim);}
.bc-spot.pl{border-color:var(--pl);} .bc-spot.pl b{color:#b5d9f2;}
.bc-spot.bk{border-color:var(--bk);} .bc-spot.bk b{color:#ffb9b2;}
.bc-spot.tie{border-color:var(--tiec);} .bc-spot.tie b{color:#a9e8c0;}
.bc-spot.has{background:rgba(232,197,107,.12); box-shadow:0 0 12px rgba(232,197,107,.25);}
.bc-spot.sm{min-height:60px; padding:9px 4px;}
.bc-spot.sm b{font-size:.62rem;}
.bc-spot-chips{display:flex; align-items:flex-end; gap:5px; margin-top:3px;}
.bc-x{text-decoration:none; font-style:normal; cursor:pointer; color:#e8b7b2; font-size:.62rem;
  background:rgba(0,0,0,.45); border-radius:50%; width:16px; height:16px; display:inline-flex; align-items:center; justify-content:center;}
.bc-mstack{position:relative; display:inline-block; flex-shrink:0;}
.bc-mstack i{position:absolute; left:0; border-radius:50%; border:1.5px dashed rgba(255,255,255,.65);
  box-shadow:0 1px 2px rgba(0,0,0,.5); box-sizing:border-box; display:flex; align-items:center; justify-content:center;}
.bc-mstack i em{font-style:normal; color:#fff; font-size:.44rem; font-weight:900; font-family:var(--mono);}

/* rack + deal */
.bc-rack{display:flex; align-items:center; gap:9px; padding:8px 14px calc(16px + env(safe-area-inset-bottom));
  flex-wrap:wrap; justify-content:center; background:rgba(0,0,0,.22);}
.bc-chip{width:44px; height:44px; border-radius:50%; font-weight:800; cursor:pointer; color:#fff;
  border:3px dashed rgba(255,255,255,.6); font-size:.7rem;}
.bc-chip.c5{background:#c0392b;} .bc-chip.c10{background:#2471a3;} .bc-chip.c25{background:#1e8449;}
.bc-chip.c100{background:#111;} .bc-chip.c500{background:#6c3483;}
.bc-chip.sel{outline:3px solid var(--gold); outline-offset:2px;}
.bc-onboard{font-size:.62rem; color:var(--dim); margin-left:8px;}
.bc-onboard b{color:var(--gold);}
.bc-dealfab{position:fixed; right:16px; bottom:calc(86px + env(safe-area-inset-bottom)); z-index:60;
  width:78px; height:78px; border-radius:50%; border:3px solid var(--gold);
  background:radial-gradient(circle at 35% 30%, #d4a940, #8a6c1e); color:#fff; font-weight:900;
  letter-spacing:.08em; font-size:.82rem; cursor:pointer; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:1px; box-shadow:0 6px 18px rgba(0,0,0,.55);}
.bc-dealfab small{font-size:.56rem; font-weight:700; opacity:.92;}
.bc-dealfab:active{transform:translateY(2px);}

/* SIM */
.bc-simfab{position:fixed; left:16px; bottom:calc(86px + env(safe-area-inset-bottom)); z-index:60;
  width:58px; height:58px; border-radius:50%; border:2.5px solid #7db8ff; color:#a8ceff;
  background:radial-gradient(circle at 35% 30%, #1d3d63, #10233c); font-weight:900; font-size:.68rem;
  letter-spacing:.08em; cursor:pointer; box-shadow:0 6px 16px rgba(0,0,0,.5);}
.bc-simfab.running{border-color:#ff8c85; color:#ffd9d6;
  background:radial-gradient(circle at 35% 30%, #6e211c, #3c100d); animation:bc-simpulse 1s infinite alternate;}
@keyframes bc-simpulse{from{box-shadow:0 0 0 rgba(232,87,77,.5);} to{box-shadow:0 0 18px rgba(232,87,77,.7);}}
.bc-simstats{position:fixed; left:84px; bottom:calc(94px + env(safe-area-inset-bottom)); z-index:60;
  display:flex; flex-direction:column; gap:1px; background:rgba(30,6,10,.92); border:1px solid #7a3a42;
  border-radius:10px; padding:6px 10px; pointer-events:none;}
.bc-simstats span{font-size:.56rem; color:var(--dim); letter-spacing:.06em;}
.bc-simstats b{font-size:.82rem; font-weight:800;}
.bc-simstats b.pos{color:#7de89b;} .bc-simstats b.neg{color:#ff8c85;}
.bc-simpanel{position:fixed; left:50%; transform:translateX(-50%); bottom:calc(14px + env(safe-area-inset-bottom));
  z-index:75; width:min(420px, calc(100vw - 24px)); background:#2a070d; border:2px solid var(--gold);
  border-radius:16px; padding:14px; display:flex; flex-direction:column; gap:8px; box-shadow:0 -8px 40px rgba(0,0,0,.6);}
.bc-simpanel-title{font-size:.62rem; letter-spacing:.24em; color:var(--gold); font-weight:900; text-align:center;}
.bc-simstrat{display:flex; flex-direction:column; gap:3px; text-align:left; padding:10px 12px;
  border:1.5px solid #7a3a42; border-radius:10px; background:rgba(255,255,255,.03); color:var(--ink); cursor:pointer;}
.bc-simstrat.on{border-color:var(--gold); background:rgba(232,197,107,.1);}
.bc-simstrat b{font-size:.74rem; font-weight:800;}
.bc-simstrat i{font-style:normal; font-size:.58rem; color:var(--dim); line-height:1.45;}
.bc-simamts{display:flex; align-items:center; gap:7px;}
.bc-simamts > span{font-size:.58rem; color:var(--dim); letter-spacing:.08em;}
.bc-simamt{flex:1; padding:9px 2px; border:1.5px solid #7a3a42; border-radius:9px; background:transparent;
  color:var(--ink); font-weight:800; font-size:.72rem; cursor:pointer; font-family:var(--mono);}
.bc-simamt.on{border-color:var(--gold); background:rgba(232,197,107,.14); color:var(--gold);}
.bc-simgo{display:flex; gap:8px;}
.bc-simcancel{flex:1; padding:11px; border:1.5px solid #7a3a42; border-radius:10px; background:transparent;
  color:var(--dim); font-weight:700; font-size:.72rem; cursor:pointer;}
.bc-simstart{flex:2; padding:11px; border:2px solid var(--gold); border-radius:10px;
  background:linear-gradient(#8a6c1e,#5e4a12); color:#fff; font-weight:900; letter-spacing:.1em; font-size:.78rem; cursor:pointer;}
`;
