import { useState, useEffect, useMemo } from "react";
import { fetchBets, insertBet, updateBetOutcome, deleteBet, clearBets } from "./db";

// The Book — quick settlement calculator
//   WIN       → collect the full bet amount
//   HALF WIN  → collect half the bet amount
//   HALF LOSE → pay half of the 90%  (= 45% of the bet)
//   LOSE      → pay 90% of the bet amount
// Typed amount is multiplied by 100.
// Each bet line is saved to Supabase (see src/db.js).

const PAY_RATE = 0.9;
const INPUT_MULT = 100;

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
const moneyC = (n) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");

// Returns how a bet settles: direction (collect/pay), dollar value, and if it's a half result.
function settle(outcome, amount) {
  switch (outcome) {
    case "win":
      return { dir: "collect", value: amount, half: false };
    case "halfwin":
      return { dir: "collect", value: amount * 0.5, half: true };
    case "halflose":
      return { dir: "pay", value: amount * PAY_RATE * 0.5, half: true };
    case "lose":
    default:
      return { dir: "pay", value: amount * PAY_RATE, half: false };
  }
}

export default function App() {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [confirmId, setConfirmId] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Initial load: bets from Supabase (or localStorage fallback).
  useEffect(() => {
    let alive = true;
    fetchBets()
      .then((rows) => {
        if (alive) {
          setEntries(rows);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (alive) {
          setErr("Could not load saved bets — check your Supabase connection.");
          setLoaded(true);
          console.error(e);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  // Re-pull from the source of truth after a failed write so the UI doesn't drift.
  async function resync() {
    try {
      setEntries(await fetchBets());
    } catch (e) {
      console.error(e);
    }
  }

  const a = parseFloat(amount) || 0;
  const real = a * INPUT_MULT;
  const canAdd = a > 0;

  function add(outcome) {
    if (!(a > 0)) return;
    const e = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name.trim(),
      amount: real,
      outcome,
    };
    setEntries((prev) => [e, ...prev]); // optimistic
    setName("");
    setAmount("");
    insertBet(e).catch((err) => {
      setErr("Failed to save the bet.");
      console.error(err);
      resync();
    });
  }
  function setOutcome(id, outcome) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, outcome } : e)));
    updateBetOutcome(id, outcome).catch((err) => {
      setErr("Failed to update the bet.");
      console.error(err);
      resync();
    });
  }
  function remove(id) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setConfirmId(null);
    deleteBet(id).catch((err) => {
      setErr("Failed to delete the bet.");
      console.error(err);
      resync();
    });
  }
  function clearAll() {
    setEntries([]);
    setConfirmClear(false);
    clearBets().catch((err) => {
      setErr("Failed to clear bets.");
      console.error(err);
      resync();
    });
  }

  const totals = useMemo(() => {
    let collect = 0, pay = 0;
    for (const e of entries) {
      const s = settle(e.outcome, e.amount);
      if (s.dir === "collect") collect += s.value;
      else pay += s.value;
    }
    return { collect, pay, net: collect - pay, count: entries.length };
  }, [entries]);

  const netCls = totals.net > 0 ? "bk-pos" : totals.net < 0 ? "bk-neg" : "bk-zero";
  const netSign = totals.net > 0 ? "+" : totals.net < 0 ? "−" : "";

  return (
    <div className="bk">
      <style>{CSS}</style>
      <div className="bk-wrap">
        <header className="bk-head">
          {entries.length > 0 &&
            (confirmClear ? (
              <span className="bk-clear-confirm">
                <button className="bk-cc-yes" onClick={clearAll}>clear all</button>
                <button className="bk-cc-no" onClick={() => setConfirmClear(false)}>cancel</button>
              </span>
            ) : (
              <button className="bk-clear" onClick={() => setConfirmClear(true)}>Clear</button>
            ))}
        </header>

        {err && (
          <div className="bk-err" onClick={() => setErr("")} title="Dismiss">
            {err}
          </div>
        )}

        {/* Totals */}
        <section className="bk-ticker">
          <div className={cx("bk-net", netCls)}>
            {netSign}
            {money(Math.abs(totals.net))}
          </div>
          <div className="bk-net-label">net — collect minus pay</div>
          <div className="bk-subgrid">
            <div>
              <span className="v" style={{ color: "var(--win)" }}>{money(totals.collect)}</span>
              <span className="k">to collect</span>
            </div>
            <div>
              <span className="v" style={{ color: "var(--lose)" }}>{money(totals.pay)}</span>
              <span className="k">to pay</span>
            </div>
            <div>
              <span className="v">{totals.count}</span>
              <span className="k">{totals.count === 1 ? "bet" : "bets"}</span>
            </div>
          </div>
        </section>

        {/* Add */}
        <section className="bk-form">
          <div className="bk-form-title">Add a bet</div>
          <div className="bk-row2">
            <input
              className="bk-input"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="bk-money">
              <span className="bk-prefix">$</span>
              <input
                className="bk-input mono bk-amt"
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="bk-suffix">×100</span>
            </div>
          </div>

          <div className="bk-commit">
            <button className="bk-win" disabled={!canAdd} onClick={() => add("win")}>
              <b>Win</b>
            </button>
            <button className="bk-halfwin" disabled={!canAdd} onClick={() => add("halfwin")}>
              <b>½ Win</b>
            </button>
            <button className="bk-halflose" disabled={!canAdd} onClick={() => add("halflose")}>
              <b>½ Lose</b>
            </button>
            <button className="bk-lose" disabled={!canAdd} onClick={() => add("lose")}>
              <b>Lose</b>
            </button>
          </div>
        </section>

        {/* Lines */}
        <section>
          {loaded && entries.length === 0 && (
            <div className="bk-empty">No bets yet. Add one above to settle up.</div>
          )}
          {entries.map((e) => {
            const s = settle(e.outcome, e.amount);
            const isCollect = s.dir === "collect";
            return (
              <div className="bk-entry" key={e.id}>
                <div className="bk-entry-main">
                  <div className="bk-entry-top">
                    <span className={cx("bk-dot", e.outcome)} />
                    <span className={cx("bk-name", !e.name && "empty")}>
                      {e.name || "No name"}
                    </span>
                  </div>
                  <div className="bk-entry-sub mono">bet {money(e.amount)}</div>
                </div>
                <div className="bk-entry-right">
                  <div className={cx("bk-entry-net mono", isCollect ? "bk-pos" : "bk-neg")}>
                    {money(s.value)}
                    <span className="bk-tag">
                      {s.dir}
                      {s.half ? " ½" : ""}
                    </span>
                  </div>
                  <div className="bk-entry-actions">
                    <div className="bk-seg">
                      <button
                        className={cx(e.outcome === "win" && "on-win")}
                        onClick={() => setOutcome(e.id, "win")}
                        title="Win"
                      >
                        W
                      </button>
                      <button
                        className={cx(e.outcome === "halfwin" && "on-win")}
                        onClick={() => setOutcome(e.id, "halfwin")}
                        title="Half win"
                      >
                        ½W
                      </button>
                      <button
                        className={cx(e.outcome === "halflose" && "on-lose")}
                        onClick={() => setOutcome(e.id, "halflose")}
                        title="Half lose"
                      >
                        ½L
                      </button>
                      <button
                        className={cx(e.outcome === "lose" && "on-lose")}
                        onClick={() => setOutcome(e.id, "lose")}
                        title="Lose"
                      >
                        L
                      </button>
                    </div>
                    {confirmId === e.id ? (
                      <div className="bk-confirm">
                        <button className="bk-confirm-yes" onClick={() => remove(e.id)}>delete</button>
                        <button className="bk-confirm-no" onClick={() => setConfirmId(null)}>keep</button>
                      </div>
                    ) : (
                      <button
                        className="bk-del"
                        onClick={() => setConfirmId(e.id)}
                        aria-label="Delete entry"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}

const CSS = `
.bk{
  --bg:#15120E; --panel:#1E1A13; --panel2:#251F18;
  --line:#342C21; --line2:#463c2d;
  --ink:#ECE4D5; --dim:#A89C89; --faint:#7d735f;
  --brass:#CBA24E; --brass-dim:#8a7038;
  --win:#57C07A; --lose:#E45D54;
  --win-bg:rgba(87,192,122,.12); --lose-bg:rgba(228,93,84,.12);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace;
  font-family:var(--sans); color:var(--ink); background:var(--bg);
  min-height:100%; -webkit-font-smoothing:antialiased;
}
.bk *{box-sizing:border-box;}
.bk .mono{font-family:var(--mono); font-variant-numeric:tabular-nums; font-feature-settings:"tnum" 1;}
.bk-wrap{max-width:560px; margin:0 auto; padding:22px 20px 60px;}

.bk-head{display:flex; align-items:center; justify-content:flex-end; margin-bottom:18px; min-height:30px;}
.bk-clear{font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--faint);
  background:transparent; border:1px solid var(--line); padding:6px 11px; border-radius:8px;
  cursor:pointer; font-weight:600; font-family:var(--sans); transition:all .15s;}
.bk-clear:hover{color:var(--lose); border-color:var(--lose);}
.bk-clear-confirm{display:flex; gap:6px;}
.bk-cc-yes{font-size:.7rem; font-weight:700; padding:6px 10px; border-radius:8px; border:1px solid var(--lose);
  background:var(--lose-bg); color:var(--lose); cursor:pointer; font-family:var(--sans);}
.bk-cc-no{font-size:.7rem; font-weight:600; padding:6px 10px; border-radius:8px; border:1px solid var(--line2);
  background:transparent; color:var(--dim); cursor:pointer; font-family:var(--sans);}

.bk-err{background:var(--lose-bg); border:1px solid var(--lose); color:var(--lose);
  border-radius:10px; padding:10px 14px; font-size:.82rem; margin-bottom:14px; cursor:pointer;}

.bk-ticker{border:1px solid var(--line); border-radius:16px;
  background:linear-gradient(180deg,var(--panel),var(--bg)); padding:24px 22px 20px; margin-bottom:18px;}
.bk-net{font-family:var(--mono); font-variant-numeric:tabular-nums;
  font-size:clamp(2.4rem,9vw,3.5rem); font-weight:600; letter-spacing:-.02em; line-height:1;}
.bk-pos{color:var(--win);} .bk-neg{color:var(--lose);} .bk-zero{color:var(--ink);}
.bk-net-label{font-size:.66rem; text-transform:uppercase; letter-spacing:.16em; color:var(--faint); margin-top:9px;}
.bk-subgrid{display:flex; flex-wrap:wrap; gap:16px 30px; margin-top:20px; padding-top:18px; border-top:1px solid var(--line);}
.bk-subgrid > div{display:flex; flex-direction:column; gap:3px;}
.bk-subgrid .v{font-family:var(--mono); font-size:1.05rem; color:var(--ink); font-variant-numeric:tabular-nums;}
.bk-subgrid .k{font-size:.62rem; text-transform:uppercase; letter-spacing:.12em; color:var(--faint);}

.bk-form{border:1px solid var(--line); border-radius:16px; background:var(--panel); padding:18px 18px 20px; margin-bottom:22px;}
.bk-form-title{font-size:.66rem; text-transform:uppercase; letter-spacing:.16em; color:var(--brass-dim); margin-bottom:14px; font-weight:600;}
/* 16px keeps iOS Safari from auto-zooming the page when a field is focused. */
.bk-input{width:100%; background:var(--panel2); border:1px solid var(--line2); border-radius:10px;
  color:var(--ink); padding:12px; font-size:16px; font-family:var(--sans); outline:none;
  transition:border-color .15s, box-shadow .15s;}
.bk-input::placeholder{color:var(--faint);}
.bk-input:focus{border-color:var(--brass); box-shadow:0 0 0 3px rgba(203,162,78,.16);}
.bk-row2{display:grid; grid-template-columns:1.3fr 1fr; gap:12px;}
.bk-money{position:relative;}
.bk-money .bk-prefix{position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--dim); font-family:var(--mono); pointer-events:none;}
.bk-money .bk-input{padding-left:26px;}
.bk-money .bk-amt{padding-right:48px;}
.bk-money .bk-suffix{position:absolute; right:11px; top:50%; transform:translateY(-50%);
  color:var(--brass-dim); font-family:var(--mono); font-size:.72rem; pointer-events:none; letter-spacing:.02em;}

.bk-commit{display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:16px;}
.bk-commit button{display:flex; align-items:center; justify-content:center; padding:14px 6px;
  border-radius:12px; cursor:pointer; transition:all .15s; font-family:var(--sans);}
.bk-commit button b{font-size:.9rem; font-weight:700; white-space:nowrap;}
.bk-commit button:disabled{opacity:.4; cursor:not-allowed;}
.bk-win{border:1px solid var(--win); background:var(--win-bg); color:var(--win);}
.bk-win:not(:disabled):hover{background:rgba(87,192,122,.2);}
.bk-halfwin{border:1px dashed var(--win); background:transparent; color:var(--win);}
.bk-halfwin:not(:disabled):hover{background:var(--win-bg);}
.bk-lose{border:1px solid var(--lose); background:var(--lose-bg); color:var(--lose);}
.bk-lose:not(:disabled):hover{background:rgba(228,93,84,.2);}
.bk-halflose{border:1px dashed var(--lose); background:transparent; color:var(--lose);}
.bk-halflose:not(:disabled):hover{background:var(--lose-bg);}

.bk-empty{text-align:center; color:var(--faint); font-size:.86rem; padding:34px 10px;}

.bk-entry{display:flex; justify-content:space-between; gap:12px; align-items:flex-start;
  padding:15px 2px; border-top:1px solid var(--line); animation:bk-in .2s ease;}
.bk-entry-main{min-width:0; padding-top:2px;}
.bk-entry-top{display:flex; align-items:center; gap:8px;}
.bk-dot{width:9px; height:9px; border-radius:50%; flex-shrink:0; box-sizing:border-box;}
.bk-dot.win{background:var(--win);}
.bk-dot.lose{background:var(--lose);}
.bk-dot.halfwin{border:2px solid var(--win);}
.bk-dot.halflose{border:2px solid var(--lose);}
.bk-name{font-size:.95rem; color:var(--ink); overflow-wrap:anywhere; font-weight:500;}
.bk-name.empty{color:var(--faint); font-weight:400;}
.bk-entry-sub{font-size:.74rem; color:var(--dim); margin-top:5px; padding-left:17px;}
.bk-entry-right{display:flex; flex-direction:column; align-items:flex-end; gap:9px; flex-shrink:0;}
.bk-entry-net{font-size:1.05rem; font-weight:600; white-space:nowrap; text-align:right; line-height:1.1;}
.bk-tag{display:block; font-family:var(--sans); font-size:.57rem; text-transform:uppercase;
  letter-spacing:.1em; color:var(--faint); margin-top:2px; font-weight:600;}
.bk-entry-actions{display:flex; align-items:center; gap:6px;}
.bk-seg{display:flex; border:1px solid var(--line2); border-radius:8px; overflow:hidden;}
.bk-seg button{min-width:26px; height:25px; padding:0 4px; border:none; background:var(--panel2);
  color:var(--faint); font-size:.6rem; font-weight:700; cursor:pointer; font-family:var(--sans); transition:all .12s;}
.bk-seg button + button{border-left:1px solid var(--line2);}
.bk-seg button:hover{color:var(--ink);}
.bk-seg button.on-win{background:var(--win-bg); color:var(--win);}
.bk-seg button.on-lose{background:var(--lose-bg); color:var(--lose);}
.bk-del{width:26px; height:25px; border:1px solid var(--line2); border-radius:8px; background:transparent;
  color:var(--faint); cursor:pointer; font-size:.8rem; line-height:1; transition:all .15s;}
.bk-del:hover{color:var(--lose); border-color:var(--lose);}
.bk-confirm{display:flex; gap:5px;}
.bk-confirm button{padding:5px 9px; border-radius:7px; font-size:.68rem; font-weight:700; cursor:pointer;
  border:1px solid var(--line2); font-family:var(--sans);}
.bk-confirm-yes{background:var(--lose-bg); color:var(--lose); border-color:var(--lose);}
.bk-confirm-no{background:transparent; color:var(--dim);}

@keyframes bk-in{from{opacity:0; transform:translateY(-4px);} to{opacity:1; transform:none;}}
@media (prefers-reduced-motion: reduce){
  .bk-entry{animation:none;}
  .bk-input,.bk-note,.bk-commit button,.bk-seg button,.bk-del,.bk-clear{transition:none;}
}
@media (max-width:420px){
  .bk-wrap{padding:18px 14px 50px;}
  .bk-subgrid{gap:14px 22px;}
  .bk-entry-sub{padding-left:0;}
  /* stack the amount + action controls under the name so nothing gets crushed */
  .bk-entry-right{flex-direction:row; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:8px 10px;}
  .bk-commit{gap:6px;}
  .bk-commit button{padding:14px 4px;}
  .bk-commit button b{font-size:.82rem;}
}

/* Touch devices: enlarge the small W/½W/½L/L and delete controls to comfortable
   tap targets, and stop the seg control from shrinking on narrow phones. */
@media (pointer:coarse){
  .bk-seg button{min-width:38px; height:38px; font-size:.7rem;}
  .bk-del{width:38px; height:38px; font-size:.95rem;}
  .bk-clear{padding:9px 14px;}
}
`;
