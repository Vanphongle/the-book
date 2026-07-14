import { useState, useEffect, useRef } from "react";
import { readJackpot, bumpJackpot, winJackpot, subscribeJackpot } from "./slotJackpot";

// ─── SLOTS — three machines, one shared jackpot ───────────────────────────────
// Play money (localStorage) for your bankroll; the progressive jackpot is the
// one thing that talks to a server (its own Supabase table) so everyone feeds
// and can win the SAME pot — across all three machines. Never touches The Book.
//   • Lucky 7s   — classic 3-reel, center payline (91.8% RTP)
//   • Dragon Gold — 5-reel, 243 ways-to-win, wilds (91% RTP, verified by sim)
//   • Fortune Gems — 6-reel × 4-row, 4096 ways, wilds (91% RTP)
// All tuned to ~8–9% house edge with high hit frequency so wins feel frequent.

const LS_BANK = "the-book.slot.bank.v1";
const LS_NAME = "the-book.slot.name.v1";
const LS_VAR = "the-book.slot.variation.v1";
const START_BANK = 10000;
const BETS = [25, 50, 100, 250, 500];
const JACKPOT_FEED = 0.01;

// ── machine definitions ───────────────────────────────────────────────────────
const VARIATIONS = {
  lucky7: {
    id: "lucky7", name: "Lucky 7s", tag: "3-reel classic", reels: 3, rows: 3, mechanic: "classic",
    theme: { a1: "#3a1d64", a2: "#1a0e2e", a3: "#0e0720", accent: "#f7c948", hot: "#ff3d7f" },
    emoji: { cherry: "🍒", lemon: "🍋", bell: "🔔", melon: "🍉", star: "⭐", seven: "7️⃣", diamond: "💎" },
    weights: { cherry: 5, lemon: 7, bell: 6, melon: 6, star: 4, seven: 3, diamond: 1 },
    pay3: { cherry: 7, lemon: 10, bell: 18, melon: 14, star: 30, seven: 60 },
    jackpotSym: "diamond", jackpotHow: "3× 💎 on the center line",
  },
  dragon: {
    id: "dragon", name: "Dragon Gold", tag: "5-reel · 243 ways", reels: 5, rows: 3, mechanic: "ways",
    norm: 10.084, wild: "wild",
    theme: { a1: "#6e1414", a2: "#3a0808", a3: "#1c0303", accent: "#ffcf3f", hot: "#ff5a2c" },
    emoji: { dragon: "🐉", fu: "🀄", envelope: "🧧", tiger: "🐯", coin: "🪙", lantern: "🏮", orange: "🍊", wild: "WILD" },
    weights: { dragon: 1, fu: 3, envelope: 3, tiger: 5, coin: 5, lantern: 6, orange: 6, wild: 1 },
    pays: { dragon: { 3: 5, 4: 20, 5: 80 }, fu: { 3: 4, 4: 12, 5: 40 }, envelope: { 3: 3, 4: 10, 5: 30 },
      tiger: { 3: 2, 4: 6, 5: 18 }, coin: { 3: 2, 4: 5, 5: 15 }, lantern: { 3: 1, 4: 3, 5: 10 }, orange: { 3: 1, 4: 2, 5: 8 } },
    jackpotSym: "dragon", jackpotHow: "a 🐉 on all 5 reels",
  },
  gems: {
    id: "gems", name: "Fortune Gems", tag: "6-reel · 4096 ways", reels: 6, rows: 4, mechanic: "ways",
    norm: 116.041, wild: "wild",
    theme: { a1: "#0d5a5f", a2: "#08313a", a3: "#04181e", accent: "#5ff0d0", hot: "#ff5aa8" },
    emoji: { gem: "💎", red: "🔴", purple: "🟣", blue: "🔵", green: "🟢", orange: "🟠", wild: "WILD" },
    weights: { gem: 1, red: 3, purple: 4, blue: 5, green: 6, orange: 6, wild: 1 },
    pays: { gem: { 3: 5, 4: 15, 5: 50, 6: 150 }, red: { 3: 3, 4: 8, 5: 25, 6: 80 }, purple: { 3: 2, 4: 6, 5: 15, 6: 40 },
      blue: { 3: 2, 4: 5, 5: 12, 6: 30 }, green: { 3: 1, 4: 3, 5: 8, 6: 20 }, orange: { 3: 1, 4: 2, 5: 6, 6: 15 } },
    jackpotSym: "gem", jackpotHow: "a 💎 on all 6 reels",
  },
};
// precompute weighted strips + draw + pay symbols
for (const v of Object.values(VARIATIONS)) {
  v.strip = Object.entries(v.weights).flatMap(([k, w]) => Array(w).fill(k));
  v.paySymbols = Object.keys(v.weights).filter((k) => k !== v.wild);
}
const drawFrom = (v) => v.strip[Math.floor(Math.random() * v.strip.length)];

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// grid[reel][row] of symbol keys
function spinGrid(v) {
  const g = [];
  for (let r = 0; r < v.reels; r++) { const col = []; for (let row = 0; row < v.rows; row++) col.push(drawFrom(v)); g.push(col); }
  return g;
}

// evaluate → { mult (× bet), jackpot, kind, winCells:Set("r-row") }
function evaluate(g, v) {
  if (v.mechanic === "classic") {
    const c = [g[0][1], g[1][1], g[2][1]]; // center line
    const cells = new Set(["0-1", "1-1", "2-1"]);
    if (c[0] === c[1] && c[1] === c[2]) {
      if (c[0] === v.jackpotSym) return { mult: 0, jackpot: true, kind: "JACKPOT", winCells: cells };
      return { mult: v.pay3[c[0]], jackpot: false, kind: `Triple ${v.emoji[c[0]]}`, winCells: cells };
    }
    const cn = c.filter((x) => x === "cherry").length;
    if (cn === 2) return { mult: 2, jackpot: false, kind: "2× 🍒", winCells: new Set(c.map((x, i) => x === "cherry" ? `${i}-1` : null).filter(Boolean)) };
    if (cn === 1) return { mult: 1, jackpot: false, kind: "1× 🍒", winCells: new Set(c.map((x, i) => x === "cherry" ? `${i}-1` : null).filter(Boolean)) };
    return { mult: 0, jackpot: false, kind: "", winCells: new Set() };
  }
  // ways-to-win
  let all = true;
  for (let r = 0; r < v.reels; r++) if (!g[r].includes(v.jackpotSym)) { all = false; break; }
  if (all) return { mult: 0, jackpot: true, kind: "JACKPOT", winCells: new Set() };
  let M = 0, best = null;
  const winCells = new Set();
  for (const s of v.paySymbols) {
    let ways = 1, len = 0;
    const cells = [];
    for (let r = 0; r < v.reels; r++) {
      const hits = [];
      g[r].forEach((x, row) => { if (x === s || x === v.wild) hits.push(`${r}-${row}`); });
      if (hits.length === 0) break;
      ways *= hits.length; len++; cells.push(...hits);
    }
    if (len >= 3 && v.pays[s] && v.pays[s][len]) {
      const p = v.pays[s][len] * ways;
      M += p;
      cells.forEach((c) => winCells.add(c));
      if (!best || p > best.p) best = { p, s, len, ways };
    }
  }
  const mult = M / v.norm;
  const kind = best ? `${best.len}× ${v.emoji[best.s]}${best.ways > 1 ? ` · ${best.ways} ways` : ""}` : "";
  return { mult, jackpot: false, kind, winCells };
}

export default function Slot() {
  const [bank, setBank] = useState(() => {
    const val = parseFloat(localStorage.getItem(LS_BANK));
    return val > 0 ? val : START_BANK;
  });
  useEffect(() => localStorage.setItem(LS_BANK, String(Math.round(bank))), [bank]);
  const bankRef = useRef(bank);
  const pay = (d) => { bankRef.current = Math.round(bankRef.current + d); setBank(bankRef.current); };

  const [name] = useState(() => localStorage.getItem(LS_NAME) || `Guest${Math.floor(1000 + Math.random() * 9000)}`);
  useEffect(() => localStorage.setItem(LS_NAME, name), [name]);

  const [varId, setVarId] = useState(() => (VARIATIONS[localStorage.getItem(LS_VAR)] ? localStorage.getItem(LS_VAR) : "lucky7"));
  useEffect(() => localStorage.setItem(LS_VAR, varId), [varId]);
  const v = VARIATIONS[varId];

  const [bet, setBet] = useState(50);
  const [grid, setGrid] = useState(() => spinGrid(VARIATIONS[varId]));
  const [spinning, setSpinning] = useState([]);
  const spinningRef = useRef([]);
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState("Pull to play — good luck! 🍀");
  const [flash, setFlash] = useState(0);
  const [jackWin, setJackWin] = useState(null);

  const [jackpot, setJackpot] = useState(0);
  const [jackServer, setJackServer] = useState(false);
  const [jackToast, setJackToast] = useState("");
  const jackRef = useRef(0);
  const setJack = (val) => { jackRef.current = val; setJackpot(val); };
  const prevJackRef = useRef(0);

  const [auto, setAuto] = useState(false);
  const autoRef = useRef(false);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const timers = useRef([]);
  const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.current.push(t); return t; };
  useEffect(() => () => { aliveRef.current = false; timers.current.forEach(clearTimeout); }, []);

  useEffect(() => {
    let unsub = () => {};
    (async () => {
      const { amount, server } = await readJackpot();
      if (!aliveRef.current) return;
      setJack(amount); prevJackRef.current = amount; setJackServer(server);
      unsub = subscribeJackpot((amt) => {
        if (!aliveRef.current) return;
        if (amt < prevJackRef.current - 1) { setJackToast("💥 Jackpot just won! Reseeding…"); later(() => aliveRef.current && setJackToast(""), 5000); }
        prevJackRef.current = amt; setJack(amt);
      });
    })();
    return () => unsub();
  }, []); // eslint-disable-line

  function switchVariation(id) {
    if (busyRef.current) return;
    autoRef.current = false; setAuto(false);
    setVarId(id);
    setGrid(spinGrid(VARIATIONS[id]));
    setResult(null);
    setMsg(`${VARIATIONS[id].name} — ${VARIATIONS[id].tag}`);
  }

  async function spin() {
    if (busyRef.current) return;
    const V = VARIATIONS[varId];
    if (bankRef.current < bet) {
      if (bankRef.current < BETS[0]) { pay(START_BANK - bankRef.current); setMsg("Busted — refilled to $10,000."); return; }
      setBet(BETS[0]); setMsg("Lower your bet."); return;
    }
    busyRef.current = true;
    setResult(null);
    pay(-bet);
    const contrib = bet * JACKPOT_FEED;
    setJack(jackRef.current + contrib); prevJackRef.current = jackRef.current; bumpJackpot(contrib);

    const finalGrid = spinGrid(V);
    spinningRef.current = Array(V.reels).fill(true);
    setSpinning([...spinningRef.current]);
    setMsg("Spinning…");
    const scramble = setInterval(() => {
      setGrid((g) => g.map((col, r) => (spinningRef.current[r] ? col.map(() => drawFrom(V)) : col)));
    }, 60);
    const stopReel = (r) => {
      spinningRef.current[r] = false;
      setSpinning((s) => s.map((val, k) => (k === r ? false : val)));
      setGrid((g) => g.map((col, k) => (k === r ? finalGrid[k] : col)));
    };
    await sleep(560);
    for (let r = 0; r < V.reels; r++) {
      if (!aliveRef.current) { clearInterval(scramble); return; }
      stopReel(r);
      await sleep(160 + (r === 0 ? 60 : 0));
    }
    clearInterval(scramble);
    await sleep(170);
    if (!aliveRef.current) return;

    const res = evaluate(finalGrid, V);
    if (res.jackpot) {
      const won = await winJackpot(name);
      pay(won);
      setResult({ win: won, jackpot: true, winCells: res.winCells });
      setJackWin({ amount: won });
      setMsg(`${V.emoji[V.jackpotSym].repeat(3)} JACKPOT! You won ${money(won)}!`);
      setFlash((f) => f + 1);
      later(() => aliveRef.current && setJackWin(null), 6000);
    } else if (res.mult > 0) {
      const winAmt = Math.max(1, Math.round(res.mult * bet));
      pay(winAmt);
      setResult({ win: winAmt, kind: res.kind, winCells: res.winCells });
      setMsg(`${res.kind} — you won ${money(winAmt)}!`);
      setFlash((f) => f + 1);
    } else {
      setResult({ win: 0, winCells: new Set() });
      setMsg("No win — spin again 🎰");
    }
    if (bankRef.current < BETS[0]) { pay(START_BANK - bankRef.current); setMsg((m) => m + " · Busted — refilled to $10,000."); }
    busyRef.current = false;
    if (autoRef.current && aliveRef.current) later(spin, 720);
  }

  function toggleAuto() {
    const next = !autoRef.current;
    autoRef.current = next; setAuto(next);
    if (next && !busyRef.current) spin();
  }
  function resetBank() {
    if (busyRef.current) return;
    if (!window.confirm("Reset your play bankroll to $10,000?")) return;
    pay(START_BANK - bankRef.current); setMsg("Fresh $10,000.");
  }

  const win = result && result.win > 0;
  const winCells = (result && result.winCells) || new Set();
  const cell = v.reels <= 3 ? 74 : v.reels === 5 ? 58 : 48;
  const fs = v.reels <= 3 ? 2.6 : v.reels === 5 ? 2 : 1.7;
  const t = v.theme;

  return (
    <div className="sl" style={{ "--a1": t.a1, "--a2": t.a2, "--a3": t.a3, "--accent": t.accent, "--hot": t.hot }}>
      <style>{CSS}</style>
      <header className="sl-top">
        <a className="sl-back" href="#">←</a>
        <span className="sl-title">SLOTS</span>
        <span className="sl-meters"><b className="mono">{money(bank)}</b><i>credits</i></span>
        <button className="sl-reset" onClick={resetBank}>↺</button>
      </header>

      {/* machine picker */}
      <div className="sl-tabs">
        {Object.values(VARIATIONS).map((m) => (
          <button key={m.id} className={cx("sl-tab", varId === m.id && "on")}
            disabled={busyRef.current} onClick={() => switchVariation(m.id)}>
            <b>{m.name}</b><i>{m.tag}</i>
          </button>
        ))}
      </div>

      {/* shared jackpot */}
      <div className="sl-jackpot">
        <span className="sl-jack-label">💰 SHARED JACKPOT {jackServer ? <em className="sl-live">● live</em> : <em className="sl-local">local</em>}</span>
        <span className="sl-jack-amt mono">{money(jackpot)}</span>
        {jackToast && <span className="sl-jack-toast">{jackToast}</span>}
      </div>

      {/* machine */}
      <div className="sl-machine">
        <div className="sl-window" style={{ gap: v.reels > 3 ? 5 : 8 }}>
          {v.mechanic === "classic" && <div className="sl-payline" />}
          {grid.map((col, r) => (
            <div key={r} className={cx("sl-reel", spinning[r] && "spin")} style={{ gap: v.rows > 3 ? 4 : 6, padding: v.reels > 3 ? 5 : 6 }}>
              {col.map((s, row) => {
                const wild = s === v.wild;
                const won = win && winCells.has(`${r}-${row}`);
                return (
                  <div key={row} className={cx("sl-cell", won && "won", wild && "wild")}
                    style={{ width: cell, height: cell * 0.88, fontSize: `${fs}rem` }}>
                    <span>{wild ? "W" : v.emoji[s]}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {win && (
          <div className="sl-winpop" key={flash}>
            <span className="sl-winpop-k">{result.jackpot ? "JACKPOT" : result.kind}</span>
            <span className="sl-winpop-amt mono">+{money(result.win)}</span>
          </div>
        )}
      </div>

      <div className="sl-msg">{msg}&nbsp;</div>

      <footer className="sl-controls">
        <div className="sl-bets">
          {BETS.map((b) => (
            <button key={b} className={cx("sl-betchip", bet === b && "on")} disabled={busyRef.current}
              onClick={() => setBet(b)}>{money(b)}</button>
          ))}
        </div>
        <div className="sl-spinrow">
          <button className={cx("sl-auto", auto && "on")} onClick={toggleAuto}>{auto ? "STOP" : "AUTO"}</button>
          <button className="sl-spin" onClick={spin} disabled={busyRef.current}>SPIN<small>{money(bet)}</small></button>
          <button className="sl-max" onClick={() => setBet(BETS[BETS.length - 1])} disabled={busyRef.current}>MAX<small>bet</small></button>
        </div>
      </footer>

      {/* paytable */}
      <details className="sl-paytable">
        <summary>{v.name} paytable · 91% RTP · {v.mechanic === "ways" ? `${Math.pow(v.rows, v.reels).toLocaleString()} ways` : "center line"}</summary>
        <div className="sl-pt-grid">
          <div className="sl-pt jack"><span>{v.emoji[v.jackpotSym].repeat(3)}</span><b>JACKPOT</b></div>
          {v.mechanic === "classic"
            ? [...["seven", "star", "bell", "melon", "lemon", "cherry"].map((k) => [v.emoji[k].repeat(3), `${v.pay3[k]}×`]), ["🍒🍒", "2×"], ["🍒", "1×"]]
                .map(([a, b], i) => <div key={i} className="sl-pt"><span>{a}</span><b>{b}</b></div>)
            : v.paySymbols.map((k) => (
                <div key={k} className="sl-pt"><span>{v.emoji[k]}</span>
                  <b>{Object.entries(v.pays[k]).map(([n, x]) => `${n}:${x}`).join("  ")}</b></div>
              ))}
        </div>
        <p className="sl-pt-note">
          {v.mechanic === "ways"
            ? `Match from the left on adjacent reels — any row. W is WILD (any symbol). More matching reels & rows = more ways = bigger pay. `
            : "Pays on the center line. "}
          Jackpot: {v.jackpotHow}. 1% of every bet across all machines feeds the shared jackpot.
        </p>
      </details>

      {jackWin && (
        <div className="sl-jackfx">
          <div className="sl-jackfx-card">
            <span className="sl-jackfx-1">💎 JACKPOT 💎</span>
            <span className="sl-jackfx-amt mono">{money(jackWin.amount)}</span>
            <span className="sl-jackfx-2">paid to your credits!</span>
          </div>
          {Array.from({ length: 28 }, (_, i) => (
            <i key={i} className="sl-coin" style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 7) * 120}ms` }}>🪙</i>
          ))}
        </div>
      )}
    </div>
  );
}

const CSS = `
.sl{--ink:#f3ecff;--dim:#a99bc7;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace;
  font-family:var(--sans);color:var(--ink);min-height:100vh;min-height:100dvh;user-select:none;overflow:hidden;
  background:radial-gradient(ellipse at 50% -10%,var(--a1),var(--a2) 55%,var(--a3));display:flex;flex-direction:column;}
.sl *{box-sizing:border-box;}
.sl .mono{font-family:var(--mono);font-variant-numeric:tabular-nums;}
.sl-top{display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(0,0,0,.3);}
.sl-back{color:var(--dim);text-decoration:none;font-size:1rem;}
.sl-title{font-size:.82rem;letter-spacing:.24em;color:var(--accent);font-weight:900;}
.sl-meters{display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;}
.sl-meters b{font-size:.92rem;color:var(--accent);}
.sl-meters i{font-style:normal;font-size:.5rem;text-transform:uppercase;letter-spacing:.12em;color:var(--dim);}
.sl-reset{background:transparent;border:1px solid #5a4880;color:var(--dim);border-radius:8px;padding:5px 9px;font-size:.8rem;cursor:pointer;}

.sl-tabs{display:flex;gap:6px;padding:8px 14px 2px;}
.sl-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 4px;border-radius:11px;cursor:pointer;
  border:1.5px solid transparent;background:rgba(255,255,255,.05);color:var(--dim);line-height:1.15;}
.sl-tab b{font-size:.66rem;font-weight:800;}
.sl-tab i{font-style:normal;font-size:.48rem;opacity:.85;}
.sl-tab.on{border-color:var(--accent);background:rgba(255,255,255,.1);color:var(--ink);box-shadow:0 0 12px rgba(0,0,0,.3);}
.sl-tab:disabled{opacity:.6;}

.sl-jackpot{margin:8px 14px 4px;padding:9px;border-radius:14px;text-align:center;position:relative;
  background:linear-gradient(135deg,rgba(255,255,255,.14),rgba(0,0,0,.25));border:2px solid var(--accent);
  box-shadow:0 0 20px rgba(0,0,0,.4),inset 0 0 16px rgba(0,0,0,.3);}
.sl-jack-label{display:block;font-size:.54rem;letter-spacing:.14em;color:var(--ink);font-weight:800;opacity:.9;}
.sl-live{font-style:normal;color:#7dff9b;font-size:.5rem;margin-left:4px;}
.sl-local{font-style:normal;color:var(--dim);font-size:.5rem;margin-left:4px;}
.sl-jack-amt{display:block;font-size:1.8rem;font-weight:900;color:var(--accent);text-shadow:0 0 16px rgba(255,255,255,.3);
  animation:sl-jackglow 2.4s infinite;}
@keyframes sl-jackglow{50%{text-shadow:0 0 26px var(--accent);}}
.sl-jack-toast{position:absolute;left:0;right:0;bottom:-20px;font-size:.58rem;color:var(--hot);font-weight:800;}

.sl-machine{position:relative;margin:12px 10px;display:flex;justify-content:center;}
.sl-window{display:flex;padding:12px;border-radius:16px;position:relative;justify-content:center;
  background:linear-gradient(rgba(255,255,255,.08),rgba(0,0,0,.35));border:3px solid rgba(255,255,255,.22);
  box-shadow:inset 0 4px 20px rgba(0,0,0,.6),0 8px 24px rgba(0,0,0,.5);}
.sl-payline{position:absolute;left:8px;right:8px;top:50%;height:3px;transform:translateY(-50%);z-index:3;pointer-events:none;
  background:linear-gradient(90deg,transparent,var(--hot),transparent);box-shadow:0 0 10px var(--hot);opacity:.85;}
.sl-reel{display:flex;flex-direction:column;background:rgba(6,4,14,.75);border-radius:10px;overflow:hidden;
  box-shadow:inset 0 6px 12px rgba(0,0,0,.7),inset 0 -6px 12px rgba(0,0,0,.7);}
.sl-cell{display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));transition:background .2s;}
.sl-cell.wild span{font-size:.7em;font-weight:900;color:#3a1004;background:radial-gradient(circle at 50% 30%,#fff2b0,var(--accent));
  width:82%;height:82%;border-radius:8px;display:flex;align-items:center;justify-content:center;letter-spacing:.02em;
  box-shadow:0 0 10px var(--accent);}
.sl-cell.won{background:rgba(255,255,255,.28);border-radius:8px;animation:sl-cellwin .5s ease infinite alternate;}
@keyframes sl-cellwin{to{background:rgba(255,255,255,.5);transform:scale(1.05);}}
.sl-reel.spin .sl-cell{animation:sl-blur .09s linear infinite;}
@keyframes sl-blur{0%{transform:translateY(-6px);filter:blur(1.4px);}100%{transform:translateY(6px);filter:blur(1.4px);}}
.sl-reel:not(.spin) .sl-cell{animation:sl-land .22s cubic-bezier(.2,1.5,.4,1);}
@keyframes sl-land{0%{transform:translateY(-12px);}60%{transform:translateY(3px);}100%{transform:translateY(0);}}

.sl-winpop{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;pointer-events:none;
  display:flex;flex-direction:column;align-items:center;gap:2px;background:rgba(10,4,20,.82);border:2px solid var(--accent);
  border-radius:14px;padding:9px 22px;animation:sl-pop .45s cubic-bezier(.2,1.6,.4,1),sl-fade .4s ease 1.5s forwards;}
.sl-winpop-k{font-size:.6rem;letter-spacing:.12em;color:var(--ink);font-weight:800;}
.sl-winpop-amt{font-size:1.6rem;font-weight:900;color:var(--accent);text-shadow:0 0 14px var(--accent);}
@keyframes sl-pop{from{transform:translate(-50%,-50%) scale(.4);opacity:0;}70%{transform:translate(-50%,-50%) scale(1.12);}}
@keyframes sl-fade{to{opacity:0;}}

.sl-msg{text-align:center;font-size:.72rem;color:var(--accent);font-weight:600;min-height:20px;padding:0 14px;}

.sl-controls{margin-top:auto;padding:9px 14px calc(12px + env(safe-area-inset-bottom));background:rgba(0,0,0,.28);}
.sl-bets{display:flex;gap:6px;justify-content:center;margin-bottom:9px;flex-wrap:wrap;}
.sl-betchip{padding:7px 12px;border-radius:20px;border:2px solid #5a4880;background:rgba(255,255,255,.04);color:var(--ink);
  font-weight:800;font-size:.7rem;cursor:pointer;font-family:var(--mono);}
.sl-betchip.on{border-color:var(--accent);background:rgba(255,255,255,.12);color:var(--accent);}
.sl-betchip:disabled{opacity:.5;}
.sl-spinrow{display:flex;align-items:stretch;gap:10px;max-width:480px;margin:0 auto;}
.sl-spin{flex:1;padding:15px;border-radius:16px;border:none;cursor:pointer;font-weight:900;letter-spacing:.12em;font-size:1.1rem;
  color:#2a0e02;background:radial-gradient(circle at 50% 20%,#fff2c0,var(--accent) 55%,rgba(0,0,0,.2));
  box-shadow:0 6px 0 rgba(0,0,0,.35),0 10px 20px rgba(0,0,0,.5);display:flex;flex-direction:column;align-items:center;gap:1px;}
.sl-spin small{font-size:.56rem;font-weight:700;opacity:.8;}
.sl-spin:active{transform:translateY(4px);box-shadow:0 2px 0 rgba(0,0,0,.35);}
.sl-spin:disabled{filter:grayscale(.4) brightness(.85);}
.sl-auto,.sl-max{width:64px;border-radius:14px;border:2px solid #5a4880;background:rgba(255,255,255,.04);color:var(--dim);
  font-weight:800;font-size:.7rem;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;}
.sl-auto small,.sl-max small{font-size:.48rem;font-weight:600;opacity:.8;}
.sl-max{color:var(--accent);border-color:rgba(255,255,255,.25);}
.sl-auto.on{border-color:var(--hot);color:var(--hot);background:rgba(255,90,168,.14);animation:sl-autopulse 1s infinite alternate;}
@keyframes sl-autopulse{to{box-shadow:0 0 16px var(--hot);}}

.sl-paytable{margin:0 14px 12px;background:rgba(0,0,0,.24);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:2px 12px;}
.sl-paytable summary{cursor:pointer;font-size:.64rem;color:var(--dim);padding:8px 0;letter-spacing:.04em;}
.sl-pt-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:5px 14px;padding:4px 0 8px;}
.sl-pt{display:flex;align-items:center;justify-content:space-between;font-size:.82rem;gap:6px;}
.sl-pt b{color:var(--accent);font-weight:700;font-size:.62rem;font-family:var(--mono);white-space:nowrap;}
.sl-pt.jack{grid-column:1 / -1;background:rgba(255,255,255,.08);border-radius:8px;padding:4px 8px;}
.sl-pt.jack b{color:var(--hot);}
.sl-pt-note{font-size:.55rem;color:var(--dim);line-height:1.5;margin:2px 0 8px;}

.sl-jackfx{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;overflow:hidden;
  background:rgba(10,4,20,.7);pointer-events:none;animation:sl-fade .5s ease 5.4s forwards;}
.sl-jackfx-card{display:flex;flex-direction:column;align-items:center;gap:4px;padding:22px 40px;border-radius:20px;
  background:linear-gradient(135deg,var(--a1),var(--a2));border:3px solid var(--accent);box-shadow:0 0 50px var(--accent);
  animation:sl-pop .6s cubic-bezier(.2,1.6,.4,1);z-index:2;}
.sl-jackfx-1{font-size:1rem;letter-spacing:.2em;color:var(--accent);font-weight:900;}
.sl-jackfx-amt{font-size:2.5rem;font-weight:900;color:#fff;text-shadow:0 0 24px var(--accent);}
.sl-jackfx-2{font-size:.66rem;color:var(--ink);}
.sl-coin{position:absolute;top:-8%;font-size:1.6rem;animation:sl-drop 2.2s linear infinite;}
@keyframes sl-drop{to{transform:translateY(120vh) rotate(540deg);}}
`;
