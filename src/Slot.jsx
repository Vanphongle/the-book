import { useState, useEffect, useRef } from "react";
import { readJackpot, bumpJackpot, winJackpot, subscribeJackpot } from "./slotJackpot";

// ─── LUCKY 7s — 3-reel slot with a SHARED progressive jackpot ─────────────────
// Play money (localStorage) for your own bankroll; the jackpot is the one thing
// that talks to a server (its own Supabase table) so everyone feeds and can win
// the same pot. Never touches The Book's bet data.
//   • 3 reels, center payline · verified 91.8% RTP (8.2% house edge — real slot
//     territory) with a friendly 42.6% hit frequency (nearly half of spins pay)
//   • 3× 💎 on the line wins the whole progressive jackpot, then it reseeds
//   • Feeds 1% of every bet into the shared meter; realtime keeps it live

const LS_BANK = "the-book.slot.bank.v1";
const LS_NAME = "the-book.slot.name.v1";
const START_BANK = 10000;
const BETS = [25, 50, 100, 250, 500];

// symbol: [emoji, reel weight]. Same strip on all three reels.
const SYMBOLS = {
  cherry:  { e: "🍒", w: 5 },
  lemon:   { e: "🍋", w: 7 },
  bell:    { e: "🔔", w: 6 },
  melon:   { e: "🍉", w: 6 },
  star:    { e: "⭐", w: 4 },
  seven:   { e: "7️⃣", w: 3 },
  diamond: { e: "💎", w: 1 },
};
const KEYS = Object.keys(SYMBOLS);
const PAY3 = { cherry: 7, lemon: 10, bell: 18, melon: 14, star: 30, seven: 60 }; // × bet, 3 on the line
const CHERRY = { 2: 2, 1: 1 };                                                   // 2 / 1 cherries on the line
const JACKPOT_FEED = 0.01;

const STRIP = KEYS.flatMap((k) => Array(SYMBOLS[k].w).fill(k)); // weighted bag
const draw = () => STRIP[Math.floor(Math.random() * STRIP.length)];

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// evaluate the 3 center symbols → { mult, kind } (mult × bet; kind for the label)
function evalLine(c) {
  const [a, b, d] = c;
  if (a === b && b === d) {
    if (a === "diamond") return { mult: 0, kind: "JACKPOT", jackpot: true };
    return { mult: PAY3[a], kind: `Triple ${SYMBOLS[a].e}` };
  }
  const cn = c.filter((x) => x === "cherry").length;
  if (cn && CHERRY[cn]) return { mult: CHERRY[cn], kind: `${cn}× 🍒` };
  return { mult: 0, kind: "" };
}

export default function Slot() {
  const [bank, setBank] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS_BANK));
    return v > 0 ? v : START_BANK;
  });
  useEffect(() => localStorage.setItem(LS_BANK, String(Math.round(bank))), [bank]);
  const bankRef = useRef(bank);
  const pay = (d) => { bankRef.current = Math.round(bankRef.current + d); setBank(bankRef.current); };

  const [name] = useState(() => localStorage.getItem(LS_NAME) || `Guest${Math.floor(1000 + Math.random() * 9000)}`);
  useEffect(() => localStorage.setItem(LS_NAME, name), [name]);

  const [bet, setBet] = useState(50);
  const [reels, setReels] = useState([["cherry", "seven", "bell"], ["lemon", "star", "melon"], ["bell", "diamond", "cherry"]]);
  const [spinning, setSpinning] = useState([false, false, false]);
  const spinningRef = useRef([false, false, false]);
  const [result, setResult] = useState(null); // { mult, kind, win }
  const [msg, setMsg] = useState("Pull to play — good luck! 🍀");
  const [flash, setFlash] = useState(0);        // win-pop key
  const [jackWin, setJackWin] = useState(null);  // { amount } when YOU hit it
  const busyRef = useRef(false);

  // shared jackpot
  const [jackpot, setJackpot] = useState(0);
  const [jackServer, setJackServer] = useState(false);
  const [jackToast, setJackToast] = useState(""); // "Somebody won!" when the meter drops
  const jackRef = useRef(0);
  const setJack = (v) => { jackRef.current = v; setJackpot(v); };
  const prevJackRef = useRef(0);

  const [auto, setAuto] = useState(false);
  const autoRef = useRef(false);
  const aliveRef = useRef(true);
  const timers = useRef([]);
  const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.current.push(t); return t; };
  useEffect(() => () => { aliveRef.current = false; timers.current.forEach(clearTimeout); }, []);

  // load + subscribe to the shared jackpot
  useEffect(() => {
    let unsub = () => {};
    (async () => {
      const { amount, server } = await readJackpot();
      if (!aliveRef.current) return;
      setJack(amount); prevJackRef.current = amount; setJackServer(server);
      unsub = subscribeJackpot((amt) => {
        if (!aliveRef.current) return;
        if (amt < prevJackRef.current - 1) { // meter dropped → someone won it
          setJackToast(`💥 Jackpot just won! Reseeding…`);
          later(() => aliveRef.current && setJackToast(""), 5000);
        }
        prevJackRef.current = amt;
        setJack(amt);
      });
    })();
    return () => unsub();
  }, []); // eslint-disable-line

  async function spin() {
    if (busyRef.current) return;
    if (bankRef.current < bet) {
      if (bankRef.current < BETS[0]) { pay(START_BANK - bankRef.current); setMsg("Busted — refilled to $10,000."); return; }
      setBet(BETS[0]); setMsg("Lower your bet."); return;
    }
    busyRef.current = true;
    setResult(null);
    pay(-bet);

    // feed the shared jackpot (optimistic local tick; realtime corrects)
    const contrib = bet * JACKPOT_FEED;
    setJack(jackRef.current + contrib);
    prevJackRef.current = jackRef.current;
    bumpJackpot(contrib);

    const centers = [draw(), draw(), draw()];
    const finals = centers.map((c) => [draw(), c, draw()]);

    spinningRef.current = [true, true, true];
    setSpinning([true, true, true]);
    setMsg("Spinning…");
    const scramble = setInterval(() => {
      setReels((rs) => rs.map((r, i) => (spinningRef.current[i] ? [draw(), draw(), draw()] : r)));
    }, 60);

    const stop = (i, reel) => {
      spinningRef.current[i] = false;
      setSpinning((s) => s.map((v, k) => (k === i ? false : v)));
      setReels((rs) => rs.map((r, k) => (k === i ? reel : r)));
    };

    await sleep(620); if (!aliveRef.current) return clearInterval(scramble);
    stop(0, finals[0]);
    await sleep(330); if (!aliveRef.current) return clearInterval(scramble);
    stop(1, finals[1]);
    await sleep(360); if (!aliveRef.current) return clearInterval(scramble);
    stop(2, finals[2]);
    clearInterval(scramble);
    await sleep(180);
    if (!aliveRef.current) return;

    const r = evalLine(centers);
    if (r.jackpot) {
      const won = await winJackpot(name);
      pay(won);
      setResult({ mult: 0, kind: "JACKPOT", win: won });
      setJackWin({ amount: won });
      setMsg(`💎💎💎 JACKPOT! You won ${money(won)}!`);
      setFlash((f) => f + 1);
      later(() => aliveRef.current && setJackWin(null), 6000);
    } else if (r.mult > 0) {
      const win = r.mult * bet;
      pay(win);
      setResult({ mult: r.mult, kind: r.kind, win });
      setMsg(`${r.kind} — you won ${money(win)}! (${r.mult}×)`);
      setFlash((f) => f + 1);
    } else {
      setResult({ mult: 0, kind: "", win: 0 });
      setMsg("No win — spin again 🎰");
    }
    if (bankRef.current < BETS[0]) { pay(START_BANK - bankRef.current); setMsg((m) => m + " · Busted — refilled to $10,000."); }
    busyRef.current = false;
    if (autoRef.current && aliveRef.current) later(spin, 700);
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

  return (
    <div className="sl">
      <style>{CSS}</style>
      <header className="sl-top">
        <a className="sl-back" href="#">←</a>
        <span className="sl-title">LUCKY 7s</span>
        <span className="sl-meters"><b className="mono">{money(bank)}</b><i>credits</i></span>
        <button className="sl-reset" onClick={resetBank}>↺</button>
      </header>

      {/* shared progressive jackpot */}
      <div className="sl-jackpot">
        <span className="sl-jack-label">💰 PROGRESSIVE JACKPOT {jackServer ? <em className="sl-live">● shared live</em> : <em className="sl-local">local</em>}</span>
        <span className="sl-jack-amt mono">{money(jackpot)}</span>
        {jackToast && <span className="sl-jack-toast">{jackToast}</span>}
      </div>

      {/* machine */}
      <div className="sl-machine">
        <div className="sl-window">
          <div className="sl-payline" />
          {reels.map((reel, i) => (
            <div key={i} className={cx("sl-reel", spinning[i] && "spin")}>
              {reel.map((s, row) => (
                <div key={row} className={cx("sl-cell", row === 1 && "center", win && row === 1 && "won")}>
                  <span>{SYMBOLS[s].e}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        {win && (
          <div className="sl-winpop" key={flash}>
            <span className="sl-winpop-k">{result.kind}</span>
            <span className="sl-winpop-amt mono">+{money(result.win)}</span>
          </div>
        )}
      </div>

      <div className="sl-msg">{msg}&nbsp;</div>

      {/* bet + spin controls */}
      <footer className="sl-controls">
        <div className="sl-bets">
          {BETS.map((b) => (
            <button key={b} className={cx("sl-betchip", bet === b && "on")} disabled={busyRef.current}
              onClick={() => setBet(b)}>{money(b)}</button>
          ))}
        </div>
        <div className="sl-spinrow">
          <button className={cx("sl-auto", auto && "on")} onClick={toggleAuto}>{auto ? "STOP" : "AUTO"}</button>
          <button className="sl-spin" onClick={spin} disabled={busyRef.current}>
            SPIN<small>{money(bet)}</small>
          </button>
          <button className="sl-max" onClick={() => setBet(BETS[BETS.length - 1])} disabled={busyRef.current}>MAX<small>bet</small></button>
        </div>
      </footer>

      {/* paytable */}
      <details className="sl-paytable">
        <summary>Paytable · 91.8% RTP</summary>
        <div className="sl-pt-grid">
          <div className="sl-pt jack"><span>💎💎💎</span><b>JACKPOT</b></div>
          {["seven", "star", "bell", "melon", "lemon", "cherry"].map((k) => (
            <div key={k} className="sl-pt"><span>{SYMBOLS[k].e.repeat(3)}</span><b>{PAY3[k]}×</b></div>
          ))}
          <div className="sl-pt"><span>🍒🍒</span><b>2×</b></div>
          <div className="sl-pt"><span>🍒</span><b>1×</b></div>
        </div>
        <p className="sl-pt-note">Pays on the center line. 1% of every bet feeds the shared jackpot everyone plays for.</p>
      </details>

      {/* jackpot celebration */}
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
.sl{--bg:#1a0e2e;--bg2:#0e0720;--gold:#f7c948;--hot:#ff3d7f;--ink:#f3ecff;--dim:#a99bc7;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace;
  font-family:var(--sans);color:var(--ink);min-height:100vh;min-height:100dvh;user-select:none;overflow:hidden;
  background:radial-gradient(ellipse at 50% -10%,#3a1d64,var(--bg) 55%,var(--bg2));display:flex;flex-direction:column;}
.sl *{box-sizing:border-box;}
.sl .mono{font-family:var(--mono);font-variant-numeric:tabular-nums;}
.sl-top{display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(0,0,0,.3);}
.sl-back{color:var(--dim);text-decoration:none;font-size:1rem;}
.sl-title{font-size:.82rem;letter-spacing:.24em;color:var(--gold);font-weight:900;text-shadow:0 0 12px rgba(247,201,72,.5);}
.sl-meters{display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;}
.sl-meters b{font-size:.92rem;color:var(--gold);}
.sl-meters i{font-style:normal;font-size:.5rem;text-transform:uppercase;letter-spacing:.12em;color:var(--dim);}
.sl-reset{background:transparent;border:1px solid #5a4880;color:var(--dim);border-radius:8px;padding:5px 9px;font-size:.8rem;cursor:pointer;}

.sl-jackpot{margin:10px 14px 4px;padding:10px;border-radius:14px;text-align:center;position:relative;
  background:linear-gradient(135deg,#4a1d6e,#7b1f52);border:2px solid var(--gold);
  box-shadow:0 0 22px rgba(247,201,72,.35),inset 0 0 18px rgba(0,0,0,.3);}
.sl-jack-label{display:block;font-size:.56rem;letter-spacing:.14em;color:#ffe6a0;font-weight:800;}
.sl-live{font-style:normal;color:#7dff9b;font-size:.5rem;margin-left:4px;}
.sl-local{font-style:normal;color:var(--dim);font-size:.5rem;margin-left:4px;}
.sl-jack-amt{display:block;font-size:1.9rem;font-weight:900;color:var(--gold);text-shadow:0 0 18px rgba(247,201,72,.7);letter-spacing:.02em;
  animation:sl-jackglow 2.4s infinite;}
@keyframes sl-jackglow{50%{text-shadow:0 0 26px rgba(247,201,72,1),0 0 40px rgba(255,61,127,.4);}}
.sl-jack-toast{position:absolute;left:0;right:0;bottom:-22px;font-size:.6rem;color:var(--hot);font-weight:800;}

.sl-machine{position:relative;margin:14px;flex:0 0 auto;}
.sl-window{display:flex;gap:8px;padding:14px;border-radius:18px;position:relative;justify-content:center;
  background:linear-gradient(#241241,#160b2c);border:3px solid #6b4fa0;box-shadow:inset 0 4px 20px rgba(0,0,0,.6),0 8px 26px rgba(0,0,0,.5);}
.sl-payline{position:absolute;left:8px;right:8px;top:50%;height:3px;transform:translateY(-50%);z-index:3;pointer-events:none;
  background:linear-gradient(90deg,transparent,var(--hot),transparent);box-shadow:0 0 10px var(--hot);opacity:.8;}
.sl-reel{display:flex;flex-direction:column;gap:6px;background:#0c0618;border-radius:12px;padding:6px;overflow:hidden;
  box-shadow:inset 0 6px 12px rgba(0,0,0,.7),inset 0 -6px 12px rgba(0,0,0,.7);}
.sl-cell{width:76px;height:66px;display:flex;align-items:center;justify-content:center;font-size:2.7rem;
  filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));}
.sl-cell.center{background:rgba(255,255,255,.05);border-radius:8px;}
.sl-cell.won{background:rgba(247,201,72,.25);border-radius:8px;animation:sl-cellwin .5s ease infinite alternate;}
@keyframes sl-cellwin{to{background:rgba(247,201,72,.5);transform:scale(1.06);}}
.sl-reel.spin .sl-cell{animation:sl-blur .09s linear infinite;}
@keyframes sl-blur{0%{transform:translateY(-7px);filter:blur(1.5px);}100%{transform:translateY(7px);filter:blur(1.5px);}}
.sl-reel:not(.spin) .sl-cell{animation:sl-land .22s cubic-bezier(.2,1.5,.4,1);}
@keyframes sl-land{0%{transform:translateY(-14px);}60%{transform:translateY(4px);}100%{transform:translateY(0);}}

.sl-winpop{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;pointer-events:none;
  display:flex;flex-direction:column;align-items:center;gap:2px;background:rgba(20,6,30,.82);border:2px solid var(--gold);
  border-radius:14px;padding:10px 24px;animation:sl-pop .45s cubic-bezier(.2,1.6,.4,1),sl-fade .4s ease 1.6s forwards;}
.sl-winpop-k{font-size:.62rem;letter-spacing:.16em;color:#ffe6a0;font-weight:800;}
.sl-winpop-amt{font-size:1.7rem;font-weight:900;color:var(--gold);text-shadow:0 0 16px rgba(247,201,72,.7);}
@keyframes sl-pop{from{transform:translate(-50%,-50%) scale(.4);opacity:0;}70%{transform:translate(-50%,-50%) scale(1.12);}}
@keyframes sl-fade{to{opacity:0;}}

.sl-msg{text-align:center;font-size:.74rem;color:var(--gold);font-weight:600;min-height:22px;padding:0 14px;}

.sl-controls{margin-top:auto;padding:10px 14px calc(12px + env(safe-area-inset-bottom));background:rgba(0,0,0,.28);}
.sl-bets{display:flex;gap:6px;justify-content:center;margin-bottom:10px;flex-wrap:wrap;}
.sl-betchip{padding:8px 12px;border-radius:20px;border:2px solid #5a4880;background:rgba(255,255,255,.04);color:var(--ink);
  font-weight:800;font-size:.72rem;cursor:pointer;font-family:var(--mono);}
.sl-betchip.on{border-color:var(--gold);background:rgba(247,201,72,.16);color:var(--gold);}
.sl-betchip:disabled{opacity:.5;}
.sl-spinrow{display:flex;align-items:stretch;gap:10px;max-width:480px;margin:0 auto;}
.sl-spin{flex:1;padding:16px;border-radius:16px;border:none;cursor:pointer;font-weight:900;letter-spacing:.12em;font-size:1.15rem;
  color:#3a1004;background:radial-gradient(circle at 50% 20%,#ffe680,var(--gold) 55%,#d99a1e);
  box-shadow:0 6px 0 #a6720f,0 10px 20px rgba(0,0,0,.5);display:flex;flex-direction:column;align-items:center;gap:1px;}
.sl-spin small{font-size:.58rem;font-weight:700;opacity:.8;letter-spacing:.02em;}
.sl-spin:active{transform:translateY(4px);box-shadow:0 2px 0 #a6720f,0 4px 10px rgba(0,0,0,.5);}
.sl-spin:disabled{filter:grayscale(.4) brightness(.85);}
.sl-auto,.sl-max{width:66px;border-radius:14px;border:2px solid #5a4880;background:rgba(255,255,255,.04);color:var(--dim);
  font-weight:800;font-size:.72rem;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;}
.sl-auto small,.sl-max small{font-size:.5rem;font-weight:600;opacity:.8;}
.sl-max{color:var(--gold);border-color:#7a5a1e;}
.sl-auto.on{border-color:var(--hot);color:var(--hot);background:rgba(255,61,127,.14);animation:sl-autopulse 1s infinite alternate;}
@keyframes sl-autopulse{to{box-shadow:0 0 16px rgba(255,61,127,.55);}}

.sl-paytable{margin:0 14px 12px;background:rgba(0,0,0,.24);border:1px solid #3d2a63;border-radius:12px;padding:2px 12px;}
.sl-paytable summary{cursor:pointer;font-size:.66rem;color:var(--dim);padding:8px 0;letter-spacing:.05em;}
.sl-pt-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:5px 14px;padding:4px 0 8px;}
.sl-pt{display:flex;align-items:center;justify-content:space-between;font-size:.8rem;}
.sl-pt b{color:var(--gold);font-weight:800;font-size:.72rem;}
.sl-pt.jack{grid-column:1 / -1;background:rgba(247,201,72,.1);border-radius:8px;padding:4px 8px;}
.sl-pt.jack b{color:var(--hot);}
.sl-pt-note{font-size:.56rem;color:var(--dim);line-height:1.5;margin:2px 0 8px;}

.sl-jackfx{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;overflow:hidden;
  background:rgba(10,4,20,.7);pointer-events:none;animation:sl-fade .5s ease 5.4s forwards;}
.sl-jackfx-card{display:flex;flex-direction:column;align-items:center;gap:4px;padding:22px 40px;border-radius:20px;
  background:linear-gradient(135deg,#4a1d6e,#7b1f52);border:3px solid var(--gold);box-shadow:0 0 50px rgba(247,201,72,.7);
  animation:sl-pop .6s cubic-bezier(.2,1.6,.4,1);z-index:2;}
.sl-jackfx-1{font-size:1rem;letter-spacing:.2em;color:var(--gold);font-weight:900;}
.sl-jackfx-amt{font-size:2.6rem;font-weight:900;color:#fff;text-shadow:0 0 24px rgba(247,201,72,1);}
.sl-jackfx-2{font-size:.68rem;color:#ffe6a0;}
.sl-coin{position:absolute;top:-8%;font-size:1.6rem;animation:sl-drop 2.2s linear infinite;}
@keyframes sl-drop{to{transform:translateY(120vh) rotate(540deg);}}
`;
