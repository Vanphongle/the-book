import { useState, useEffect, useRef } from "react";

// ─── BẦU CUA (Bầu Cua Tôm Cá) ─────────────────────────────────────────────────
// The Vietnamese Tết dice game — three dice, six symbols, phone-first:
//   • Bet any symbols (Bầu, Cua, Tôm, Cá, Gà, Nai) with stacked chips
//   • Three dice shake under the bowl, then reveal with a bounce
//   • Each die matching a symbol pays 1:1 on that bet (2 dice = 2×, 3 = 3×);
//     no match loses the stake  (house edge 7.87% — same as chuck-a-luck)
//   • Results history, win pop, $10k play bankroll with bust refill, SIM
// Nothing here touches The Book's Supabase data.

const LS_BANK = "the-book.baucua.bank.v1";
const START_BANK = 10000;
const CHIPS = [5, 10, 25, 100];

const SYMBOLS = [
  { k: "nai", vn: "Nai", icon: "🦌" },
  { k: "bau", vn: "Bầu", icon: "🍐" },
  { k: "ga", vn: "Gà", icon: "🐓" },
  { k: "ca", vn: "Cá", icon: "🐟" },
  { k: "cua", vn: "Cua", icon: "🦀" },
  { k: "tom", vn: "Tôm", icon: "🦐" },
];
const ICON = Object.fromEntries(SYMBOLS.map((s) => [s.k, s.icon]));

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rollDie = () => SYMBOLS[Math.floor(Math.random() * 6)].k;

const CHIP_COLOR = { 5: "#c0392b", 10: "#2471a3", 25: "#1e8449", 100: "#151515" };
function ChipStack({ amt, size = 22 }) {
  const den = [100, 25, 10, 5];
  const list = [];
  let rem = Math.round(amt);
  for (const d of den) while (rem >= d && list.length < 6) { list.push(d); rem -= d; }
  const shown = list.reverse();
  const off = 2.5;
  return (
    <span className="bu-mstack" style={{ width: size, height: size + off * Math.max(0, shown.length - 1) }}>
      {shown.map((d, i) => (
        <i key={i} style={{ background: CHIP_COLOR[d], width: size, height: size, bottom: i * off, zIndex: i }}>
          {i === shown.length - 1 && <em>${amt}</em>}
        </i>
      ))}
    </span>
  );
}

const emptyBets = () => ({ nai: 0, bau: 0, ga: 0, ca: 0, cua: 0, tom: 0 });
const sumBets = (b) => Object.values(b).reduce((s, v) => s + v, 0);

export default function BauCua() {
  const [bank, setBank] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS_BANK));
    return v > 0 ? v : START_BANK;
  });
  useEffect(() => localStorage.setItem(LS_BANK, String(bank)), [bank]);
  const bankRef = useRef(bank);
  const payBank = (d) => { bankRef.current += d; setBank(bankRef.current); };

  const G = useRef({
    phase: "bet", // bet | shake | done
    bets: emptyBets(),
    lastBets: null,
    dice: ["bau", "cua", "ca"],
    history: [], // arrays of 3 symbols
    msg: "Đặt cược đi! Place your bets.",
    winNet: 0,
    winKey: 0,
  });
  const [tick, setTick] = useState(0);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const rr = () => { if (aliveRef.current) setTick((t) => t + 1); };
  const [chip, setChip] = useState(10);
  const [drag, setDrag] = useState(null); // {amt, from: 'rack'|sym, x, y, over}
  const suppressClickRef = useRef(0);
  const g = G.current;

  // ── SIM ──
  const [simOpen, setSimOpen] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [simCfg, setSimCfg] = useState({ strat: "cua", unit: 10 });
  const [simStats, setSimStats] = useState(null);
  const simRef = useRef({ running: false, busy: false, rolls: 0, startBank: 0, startRefill: 0, prog: 0, template: null });
  const refillAddRef = useRef(0);

  const betting = g.phase === "bet" || g.phase === "done";
  const onBoard = sumBets(g.bets);

  function addBet(k, amt = chip) {
    if (!betting) return;
    if (bankRef.current < amt) { g.msg = "Not enough credits."; rr(); return; }
    if (g.phase === "done") { g.phase = "bet"; g.msg = ""; }
    payBank(-amt);
    g.bets = { ...g.bets, [k]: g.bets[k] + amt };
    if (navigator.vibrate) navigator.vibrate(8);
    rr();
  }

  // drag a chip from the rack (from="rack") or a placed stack (from=symbol key)
  function startDrag(e, amt, from) {
    if (!betting || g.phase === "shake" || simRunning) return;
    if (from === "rack" && bankRef.current < amt) return;
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const tileAt = (ev) => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      const tile = t && t.closest ? t.closest("[data-sym]") : null;
      return tile ? tile.dataset.sym : null;
    };
    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 7) return;
      moved = true;
      setDrag({ amt, from, x: ev.clientX, y: ev.clientY, over: tileAt(ev) });
    };
    const cleanup = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      setDrag(null);
    };
    const onUp = (ev) => {
      if (moved) {
        suppressClickRef.current = Date.now() + 400;
        const sym = tileAt(ev);
        if (from === "rack") {
          if (sym) addBet(sym, amt);
        } else if (sym && sym !== from) {
          g.bets = { ...g.bets, [from]: 0, [sym]: g.bets[sym] + amt }; // slide the stack over
          if (navigator.vibrate) navigator.vibrate(8);
          rr();
        } else if (!sym) {
          payBank(amt); // dragged off the mat — chips come home
          g.bets = { ...g.bets, [from]: 0 };
          g.msg = `${money(amt)} back in your pocket.`;
          rr();
        }
      }
      cleanup();
    };
    const onCancel = cleanup;
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
  }
  function clearBet(k) {
    if (!betting || !g.bets[k]) return;
    payBank(g.bets[k]);
    g.bets = { ...g.bets, [k]: 0 };
    rr();
  }

  async function shake() {
    if (g.phase === "shake") return;
    if (sumBets(g.bets) === 0 && g.lastBets && sumBets(g.lastBets) > 0) {
      if (bankRef.current < sumBets(g.lastBets)) { g.msg = "Not enough credits to rebet."; rr(); return; }
      payBank(-sumBets(g.lastBets));
      g.bets = { ...g.lastBets };
    }
    if (sumBets(g.bets) === 0) { g.msg = "Tap a symbol to bet first."; rr(); return; }
    g.lastBets = { ...g.bets };
    g.phase = "shake";
    g.msg = "Xóc đĩa… 🥣";
    g.winNet = 0;
    rr();
    await sleep(simRef.current.running ? 500 : 1400);
    if (!aliveRef.current) return;

    const dice = [rollDie(), rollDie(), rollDie()];
    g.dice = dice;
    const b = g.bets;
    const staked = sumBets(b);
    let credit = 0;
    const hits = [];
    g.lastWins = {};
    for (const s of SYMBOLS) {
      if (!b[s.k]) continue;
      const k = dice.filter((d) => d === s.k).length;
      if (k > 0) {
        credit += b[s.k] * (1 + k); // stake back + 1:1 per matching die
        g.lastWins[s.k] = b[s.k] * k;
        hits.push(`${s.icon}×${k}`);
      }
    }
    if (credit - staked > 0 && navigator.vibrate && !simRef.current.running) navigator.vibrate([40, 60, 40]);
    if (credit > 0) payBank(credit);
    g.winNet = credit - staked;
    g.winKey = Math.random();
    g.history = [dice, ...g.history].slice(0, 16);
    g.bets = emptyBets();
    g.msg = `${dice.map((d) => ICON[d]).join(" ")}${hits.length ? ` — ${hits.join(" ")} paid` : " — no match"}`;
    g.phase = "done";
    if (bankRef.current < CHIPS[0]) {
      refillAddRef.current += START_BANK - bankRef.current;
      payBank(START_BANK - bankRef.current);
      g.msg += " · Busted — refilled to $10,000.";
    }
    rr();
  }

  function resetBank() {
    if (g.phase === "shake") return;
    if (!window.confirm("Reset play bankroll to $10,000?")) return;
    for (const [k, v] of Object.entries(g.bets)) if (v) payBank(v);
    g.bets = emptyBets();
    payBank(START_BANK - bankRef.current);
    g.msg = "Fresh bankroll.";
    rr();
  }

  // ── SIM ──
  const customTemplate = sumBets(g.bets) > 0 ? g.bets : g.lastBets && sumBets(g.lastBets) > 0 ? g.lastBets : null;
  function simStart(strat = simCfg.strat) {
    setSimOpen(false);
    const template = strat === "custom" && customTemplate ? { ...customTemplate } : null;
    for (const [k, v] of Object.entries(g.bets)) if (v) payBank(v);
    g.bets = emptyBets();
    simRef.current = {
      running: true, busy: false, rolls: 0,
      startBank: bankRef.current, startRefill: refillAddRef.current,
      prog: simCfg.unit, template, strat,
    };
    setSimStats({ rolls: 0, net: 0 });
    setSimRunning(true);
  }
  function simStop() {
    simRef.current.running = false;
    setSimRunning(false);
    const net = bankRef.current - simRef.current.startBank - (refillAddRef.current - simRef.current.startRefill);
    setSimStats({ rolls: simRef.current.rolls, net });
  }
  async function simTurn() {
    if (g.phase === "shake") return;
    const strat = simRef.current.strat;
    const mart = strat === "mart";
    const net = bankRef.current - simRef.current.startBank - (refillAddRef.current - simRef.current.startRefill);
    setSimStats({ rolls: simRef.current.rolls, net, next: mart ? simRef.current.prog : null });
    simRef.current.rolls++;
    if (g.phase === "done") g.phase = "bet";
    if (strat === "custom") {
      const tpl = simRef.current.template;
      if (!tpl) { simStop(); return; }
      const cost = sumBets(tpl);
      if (bankRef.current < cost) return;
      payBank(-cost);
      g.bets = { ...tpl };
    } else {
      let wager = mart ? simRef.current.prog : simCfg.unit;
      wager = Math.min(wager, bankRef.current);
      if (wager < CHIPS[0]) return;
      payBank(-wager);
      g.bets = { ...emptyBets(), cua: wager };
    }
    rr();
    await shake();
    if (mart) {
      const won = g.dice.includes("cua");
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

  return (
    <div className="bu" onClickCapture={(e) => {
      if (Date.now() < suppressClickRef.current) { e.stopPropagation(); e.preventDefault(); }
    }}>
      <style>{CSS}</style>
      <header className="bu-top">
        <a className="bu-back" href="#">←</a>
        <span className="bu-title">BẦU CUA</span>
        <span className="bu-meters">
          <b className="mono">{money(bank)}</b><i>credits</i>
        </span>
        <button className="bu-reset" onClick={resetBank}>Reset</button>
      </header>

      {/* history */}
      <div className="bu-hist">
        {g.history.length === 0 && <span className="bu-hist-empty">results appear here</span>}
        {g.history.map((d, i) => (
          <em key={i}>{d.map((x) => ICON[x]).join("")}</em>
        ))}
      </div>

      {/* bowl + dice */}
      <div className="bu-stage">
        {g.phase === "shake" ? (
          <div className="bu-bowlwrap">
            <div className="bu-plate jig" />
            <div className="bu-bowl shaking" />
          </div>
        ) : (
          <div className="bu-dicewrap">
            <div className="bu-dice">
              {g.dice.map((d, i) => (
                <div key={`${g.winKey}-${i}`} className="bu-die pop" style={{ animationDelay: `${120 + i * 140}ms` }}>
                  <span>{ICON[d]}</span>
                </div>
              ))}
            </div>
            {g.winKey !== 0 && <div key={`lift-${g.winKey}`} className="bu-bowl lift" />}
          </div>
        )}
      </div>

      <div className="bu-msg">{g.msg}&nbsp;</div>

      {g.phase === "done" && g.winNet > 0 && (
        <div className="bu-winpop" key={g.winKey}>
          <span className="bu-winpop-t">TRÚNG RỒI!</span>
          <span className="bu-winpop-amt mono">+{money(g.winNet)}</span>
        </div>
      )}

      {/* betting board: 2 rows × 3, like the classic mat */}
      <div className="bu-board">
        {SYMBOLS.map((s) => {
          const nDice = g.phase === "done" ? g.dice.filter((d) => d === s.k).length : 0;
          return (
            <button key={s.k} data-sym={s.k}
              className={cx("bu-tile", g.bets[s.k] > 0 && "has", drag && drag.over === s.k && "drop", nDice > 0 && "hit")}
              onClick={() => addBet(s.k)}>
              <span className="bu-tile-icon">{s.icon}</span>
              <b>{s.vn}</b>
              {nDice > 0 && <span className="bu-tile-pips">{"●".repeat(nDice)}</span>}
              {g.phase === "done" && g.lastWins?.[s.k] > 0 && (
                <span className="bu-tile-won mono">+{money(g.lastWins[s.k])}</span>
              )}
              {g.bets[s.k] > 0 && (
                <span className="bu-tile-chips" onPointerDown={(e) => { e.stopPropagation(); startDrag(e, g.bets[s.k], s.k); }}>
                  <ChipStack amt={g.bets[s.k]} />
                  {betting && <u className="bu-x" onClick={(e) => { e.stopPropagation(); clearBet(s.k); }}>✕</u>}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* chips */}
      <footer className="bu-rack">
        {CHIPS.map((c) => (
          <button key={c} className={cx("bu-chip", `c${c}`, chip === c && "sel")}
            onClick={() => setChip(c)} onPointerDown={(e) => startDrag(e, c, "rack")}>
            ${c}
          </button>
        ))}
        <span className="bu-rack-hint">tap = select · drag = place</span>
        <span className="bu-onboard">on mat <b className="mono">{money(onBoard)}</b></span>
      </footer>

      {/* dragged chip ghost */}
      {drag && (
        <div className="bu-ghost" style={{
          left: drag.x, top: drag.y,
          background: CHIP_COLOR[[100, 25, 10, 5].find((d) => d <= drag.amt) || 5],
        }}>${drag.amt}</div>
      )}

      {/* floating SHAKE */}
      {betting && !simRunning && (onBoard > 0 || (g.lastBets && sumBets(g.lastBets) > 0)) && (
        <button className="bu-shakefab" onClick={shake}>
          XÓC<small>{money(onBoard || sumBets(g.lastBets || emptyBets()))}</small>
        </button>
      )}

      {/* SIM */}
      <button className={cx("bu-simfab", simRunning && "running")}
        onClick={() => (simRunning ? simStop() : sumBets(g.bets) > 0 ? simStart("custom") : setSimOpen(true))}>
        {simRunning ? "STOP" : "SIM"}
      </button>
      {simStats && (
        <div className="bu-simstats">
          <span>{simStats.rolls} rolls{simStats.next ? ` · next ${money(simStats.next)}` : ""}</span>
          <b className={cx("mono", simStats.net >= 0 ? "pos" : "neg")}>
            {simStats.net >= 0 ? "+" : "−"}{money(Math.abs(simStats.net))}
          </b>
        </div>
      )}
      {simOpen && (
        <div className="bu-simpanel">
          <div className="bu-simpanel-title">AUTOPILOT</div>
          <button className={cx("bu-simstrat custom", simCfg.strat === "custom" && "on", !customTemplate && "off")}
            onClick={() => customTemplate && setSimCfg((c) => ({ ...c, strat: "custom" }))}>
            <b>♟ Repeat MY bets every shake</b>
            <i>{customTemplate ? `${money(sumBets(customTemplate))} per shake, same layout` : "put chips on the mat first, then pick this"}</i>
          </button>
          {[
            ["cua", "Flat bet on 🦀 Cua", "one symbol — hits ~42% of shakes, 7.87% edge"],
            ["mart", "Martingale on 🦀 Cua", "double after every miss — you know how this ends"],
          ].map(([k, lbl, sub]) => (
            <button key={k} className={cx("bu-simstrat", simCfg.strat === k && "on")}
              onClick={() => setSimCfg((c) => ({ ...c, strat: k }))}>
              <b>{lbl}</b>
              <i>{sub}</i>
            </button>
          ))}
          <div className="bu-simamts">
            <span>bet</span>
            {[5, 10, 25, 100].map((a) => (
              <button key={a} className={cx("bu-simamt", simCfg.unit === a && "on")}
                onClick={() => setSimCfg((c) => ({ ...c, unit: a }))}>
                ${a}
              </button>
            ))}
          </div>
          <div className="bu-simgo">
            <button className="bu-simcancel" onClick={() => setSimOpen(false)}>Cancel</button>
            <button className="bu-simstart" onClick={() => simStart()}>▶ START</button>
          </div>
        </div>
      )}
    </div>
  );
}

const CSS = `
.bu{
  --felt:#7a1a1a; --feltdark:#420b0b; --gold:#f2c14e; --ink:#fdf3e3; --dim:#e3b8a8;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  font-family:var(--sans); color:var(--ink); min-height:100vh; min-height:100dvh; user-select:none;
  background:radial-gradient(ellipse at 50% -10%, #a32b24, var(--felt) 45%, var(--feltdark));
  display:flex; flex-direction:column; -webkit-font-smoothing:antialiased;
}
.bu *{box-sizing:border-box;}
.bu .mono{font-family:var(--mono); font-variant-numeric:tabular-nums;}

.bu-top{display:flex; align-items:center; gap:12px; padding:10px 14px; background:rgba(0,0,0,.32);}
.bu-back{color:var(--dim); text-decoration:none; font-size:1rem;}
.bu-title{font-size:.78rem; letter-spacing:.26em; color:var(--gold); font-weight:800;}
.bu-meters{display:flex; flex-direction:column; align-items:flex-end; margin-left:auto;}
.bu-meters b{font-size:.9rem;}
.bu-meters i{font-style:normal; font-size:.52rem; text-transform:uppercase; letter-spacing:.12em; color:#caa08e;}
.bu-reset{background:transparent; border:1px solid #8f4438; color:#d8a795; border-radius:8px; padding:6px 10px; font-size:.66rem; cursor:pointer;}

.bu-hist{display:flex; gap:7px; padding:7px 12px; background:rgba(0,0,0,.24); overflow-x:auto; min-height:36px; align-items:center;}
.bu-hist-empty{font-size:.64rem; color:#caa08e;}
.bu-hist em{font-style:normal; font-size:.8rem; background:rgba(0,0,0,.3); border-radius:8px; padding:3px 7px; flex-shrink:0;}

.bu-stage{min-height:120px; display:flex; align-items:center; justify-content:center; padding:10px;}
.bu-bowlwrap{position:relative; width:130px; height:100px; display:flex; align-items:center; justify-content:center;}
.bu-plate{position:absolute; bottom:6px; width:126px; height:26px; border-radius:50%;
  background:radial-gradient(ellipse at 50% 40%, #f7e6c8, #cba76a); box-shadow:0 5px 12px rgba(0,0,0,.5);}
.bu-bowl{position:absolute; bottom:16px; width:106px; height:58px; border-radius:106px 106px 10px 10px;
  background:radial-gradient(ellipse at 34% 22%, #fdf3dd, #dcb877 45%, #a87a3e 82%, #7d5626);
  border:2px solid #7d5626; box-shadow:0 8px 14px rgba(0,0,0,.5), inset 0 -5px 8px rgba(0,0,0,.22);}
.bu-bowl::after{content:""; position:absolute; top:-7px; left:50%; transform:translateX(-50%);
  width:20px; height:11px; border-radius:8px; background:#8a5f2e; box-shadow:inset 0 2px 3px rgba(255,255,255,.35);}
.bu-bowl.shaking{animation:bu-shake .34s infinite;}
.bu-plate.jig{animation:bu-jig .34s infinite;}
@keyframes bu-shake{0%,100%{transform:translate(0,0) rotate(0);} 25%{transform:translate(-10px,-8px) rotate(-7deg);}
  50%{transform:translate(8px,-13px) rotate(5deg);} 75%{transform:translate(-6px,-4px) rotate(-4deg);}}
@keyframes bu-jig{0%,100%{transform:translate(0,0);} 30%{transform:translate(2px,1px);} 65%{transform:translate(-2px,0);}}
.bu-dicewrap{position:relative; display:flex; align-items:center; justify-content:center;}
.bu-bowl.lift{position:absolute; bottom:8px; left:50%; margin-left:-53px; pointer-events:none;
  animation:bu-lift .6s ease-in forwards;}
@keyframes bu-lift{0%{transform:translateY(0) rotate(0); opacity:1;}
  100%{transform:translateY(-110px) rotate(-14deg); opacity:0;}}
.bu-dice{display:flex; gap:14px;}
.bu-die{width:74px; height:74px; border-radius:14px; background:linear-gradient(150deg,#fdfbf4,#efe4d0);
  border:2px solid #cba76a; display:flex; align-items:center; justify-content:center; font-size:2.5rem;
  box-shadow:0 6px 14px rgba(0,0,0,.5);}
.bu-die.pop{animation:bu-pop .45s cubic-bezier(.2,1.6,.4,1) backwards;}
@keyframes bu-pop{from{transform:scale(.2) rotate(-14deg); opacity:0;} 70%{transform:scale(1.15) rotate(4deg);} to{transform:scale(1); opacity:1;}}

.bu-msg{min-height:26px; text-align:center; font-size:.86rem; color:var(--gold); font-weight:700; padding:0 12px;}

.bu-winpop{position:fixed; top:30%; left:50%; transform:translate(-50%,-50%); z-index:70; pointer-events:none;
  display:flex; flex-direction:column; align-items:center; gap:2px;
  background:rgba(35,6,6,.9); border:2px solid var(--gold); border-radius:16px; padding:14px 30px;
  animation:bu-wpop .5s cubic-bezier(.2,1.6,.4,1), bu-fade .4s ease 1.9s forwards;}
.bu-winpop-t{font-size:.72rem; letter-spacing:.3em; color:var(--gold); font-weight:900;}
.bu-winpop-amt{font-size:1.7rem; font-weight:800; color:var(--gold); text-shadow:0 0 18px rgba(242,193,78,.6);}
@keyframes bu-wpop{from{transform:translate(-50%,-50%) scale(.4); opacity:0;} 70%{transform:translate(-50%,-50%) scale(1.1);} to{transform:translate(-50%,-50%) scale(1); opacity:1;}}
@keyframes bu-fade{to{opacity:0;}}

.bu-board{display:grid; grid-template-columns:repeat(3,1fr); gap:9px; padding:6px 14px 130px; max-width:440px; margin:0 auto; width:100%;}
.bu-tile{position:relative; display:flex; flex-direction:column; align-items:center; gap:2px;
  border:2.5px solid #cba76a; border-radius:14px; background:rgba(255,244,220,.08); padding:12px 6px 10px;
  cursor:pointer; min-height:104px; color:var(--ink);}
.bu-tile-icon{font-size:2.2rem; line-height:1.1;}
.bu-tile b{font-size:.78rem; font-weight:900; letter-spacing:.06em;}
.bu-tile{transition:transform .12s, box-shadow .15s, border-color .15s;}
.bu-tile:active{transform:scale(.96);}
.bu-tile.has{background:rgba(242,193,78,.16); box-shadow:0 0 14px rgba(242,193,78,.3); border-color:var(--gold);}
.bu-tile.drop{transform:scale(1.06); border-color:#fff; background:rgba(242,193,78,.28);
  box-shadow:0 0 22px rgba(242,193,78,.65);}
.bu-tile.hit{border-color:#7de89b; background:rgba(70,190,110,.14); box-shadow:0 0 18px rgba(70,190,110,.4);
  animation:bu-hitpulse .55s ease 2;}
@keyframes bu-hitpulse{50%{box-shadow:0 0 26px rgba(70,190,110,.75);}}
.bu-tile-pips{position:absolute; top:6px; left:8px; font-size:.5rem; color:#7de89b; letter-spacing:2px;}
.bu-tile-won{position:absolute; top:4px; right:6px; font-size:.62rem; font-weight:900; color:#7de89b;
  text-shadow:0 1px 3px rgba(0,0,0,.6); animation:bu-wonpop .4s cubic-bezier(.2,1.6,.4,1);}
@keyframes bu-wonpop{from{transform:scale(.3); opacity:0;}}
.bu-tile-chips{display:flex; align-items:flex-end; gap:5px; margin-top:2px;}
.bu-x{text-decoration:none; font-style:normal; cursor:pointer; color:#ffd9d6; font-size:.6rem;
  background:rgba(0,0,0,.5); border-radius:50%; width:16px; height:16px; display:inline-flex; align-items:center; justify-content:center;}
.bu-mstack{position:relative; display:inline-block; flex-shrink:0;}
.bu-mstack i{position:absolute; left:0; border-radius:50%; border:1.5px dashed rgba(255,255,255,.65);
  box-shadow:0 1px 2px rgba(0,0,0,.5); box-sizing:border-box; display:flex; align-items:center; justify-content:center;}
.bu-mstack i em{font-style:normal; color:#fff; font-size:.44rem; font-weight:900; font-family:var(--mono);}

.bu-rack{position:fixed; left:0; right:0; bottom:0; display:flex; align-items:center; gap:9px;
  padding:8px 14px calc(14px + env(safe-area-inset-bottom)); background:rgba(30,5,5,.94);
  border-top:1px solid #8f4438; justify-content:center; flex-wrap:wrap; z-index:50;}
.bu-chip{width:42px; height:42px; border-radius:50%; font-weight:800; cursor:pointer; color:#fff;
  border:3px dashed rgba(255,255,255,.6); font-size:.66rem;}
.bu-chip.c5{background:#c0392b;} .bu-chip.c10{background:#2471a3;} .bu-chip.c25{background:#1e8449;} .bu-chip.c100{background:#111;}
.bu-chip{touch-action:none;}
.bu-chip.sel{outline:3px solid var(--gold); outline-offset:2px;}
.bu-tile-chips{touch-action:none; cursor:grab;}
.bu-rack-hint{width:100%; text-align:center; font-size:.52rem; color:#b58a7a; letter-spacing:.08em; margin-top:-2px;}
.bu-ghost{position:fixed; z-index:120; pointer-events:none; transform:translate(-50%,-50%) scale(1.25);
  width:44px; height:44px; border-radius:50%; border:3px dashed rgba(255,255,255,.7); color:#fff;
  font-weight:900; font-size:.68rem; font-family:var(--mono); display:flex; align-items:center; justify-content:center;
  box-shadow:0 10px 24px rgba(0,0,0,.55);}
.bu-onboard{font-size:.62rem; color:var(--dim);}
.bu-onboard b{color:var(--gold);}

.bu-shakefab{position:fixed; right:16px; bottom:calc(80px + env(safe-area-inset-bottom)); z-index:60;
  width:80px; height:80px; border-radius:50%; border:3px solid var(--gold);
  background:radial-gradient(circle at 35% 30%, #d4a940, #8a6c1e); color:#fff; font-weight:900;
  letter-spacing:.08em; font-size:.86rem; cursor:pointer; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:1px; box-shadow:0 6px 18px rgba(0,0,0,.55);}
.bu-shakefab small{font-size:.54rem; font-weight:700; opacity:.92;}
.bu-shakefab:active{transform:translateY(2px);}

.bu-simfab{position:fixed; left:16px; bottom:calc(80px + env(safe-area-inset-bottom)); z-index:60;
  width:58px; height:58px; border-radius:50%; border:2.5px solid #7db8ff; color:#a8ceff;
  background:radial-gradient(circle at 35% 30%, #1d3d63, #10233c); font-weight:900; font-size:.68rem;
  letter-spacing:.08em; cursor:pointer; box-shadow:0 6px 16px rgba(0,0,0,.5);}
.bu-simfab.running{border-color:#ff8c85; color:#ffd9d6;
  background:radial-gradient(circle at 35% 30%, #6e211c, #3c100d); animation:bu-spulse 1s infinite alternate;}
@keyframes bu-spulse{from{box-shadow:0 0 0 rgba(232,87,77,.5);} to{box-shadow:0 0 18px rgba(232,87,77,.7);}}
.bu-simstats{position:fixed; left:84px; bottom:calc(88px + env(safe-area-inset-bottom)); z-index:60;
  display:flex; flex-direction:column; gap:1px; background:rgba(35,6,6,.92); border:1px solid #8f4438;
  border-radius:10px; padding:6px 10px; pointer-events:none;}
.bu-simstats span{font-size:.56rem; color:var(--dim); letter-spacing:.06em;}
.bu-simstats b{font-size:.82rem; font-weight:800;}
.bu-simstats b.pos{color:#7de89b;} .bu-simstats b.neg{color:#ff8c85;}
.bu-simpanel{position:fixed; left:50%; transform:translateX(-50%); bottom:calc(14px + env(safe-area-inset-bottom));
  z-index:75; width:min(420px, calc(100vw - 24px)); background:#2c0808; border:2px solid var(--gold);
  border-radius:16px; padding:14px; display:flex; flex-direction:column; gap:8px; box-shadow:0 -8px 40px rgba(0,0,0,.6);}
.bu-simpanel-title{font-size:.62rem; letter-spacing:.24em; color:var(--gold); font-weight:900; text-align:center;}
.bu-simstrat{display:flex; flex-direction:column; gap:3px; text-align:left; padding:10px 12px;
  border:1.5px solid #8f4438; border-radius:10px; background:rgba(255,255,255,.03); color:var(--ink); cursor:pointer;}
.bu-simstrat.on{border-color:var(--gold); background:rgba(242,193,78,.1);}
.bu-simstrat.custom{border-style:dashed;} .bu-simstrat.custom.on{border-style:solid;}
.bu-simstrat.off{opacity:.5; cursor:default;}
.bu-simstrat b{font-size:.74rem; font-weight:800;}
.bu-simstrat i{font-style:normal; font-size:.58rem; color:var(--dim); line-height:1.45;}
.bu-simamts{display:flex; align-items:center; gap:7px;}
.bu-simamts > span{font-size:.58rem; color:var(--dim); letter-spacing:.08em;}
.bu-simamt{flex:1; padding:9px 2px; border:1.5px solid #8f4438; border-radius:9px; background:transparent;
  color:var(--ink); font-weight:800; font-size:.72rem; cursor:pointer; font-family:var(--mono);}
.bu-simamt.on{border-color:var(--gold); background:rgba(242,193,78,.14); color:var(--gold);}
.bu-simgo{display:flex; gap:8px;}
.bu-simcancel{flex:1; padding:11px; border:1.5px solid #8f4438; border-radius:10px; background:transparent;
  color:var(--dim); font-weight:700; font-size:.72rem; cursor:pointer;}
.bu-simstart{flex:2; padding:11px; border:2px solid var(--gold); border-radius:10px;
  background:linear-gradient(#8a6c1e,#5e4a12); color:#fff; font-weight:900; letter-spacing:.1em; font-size:.78rem; cursor:pointer;}
`;
