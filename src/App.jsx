import { useState, useEffect, useMemo } from "react";
import { fetchBets, insertBet, updateBetOutcome, deleteBet, clearBets } from "./db";

// The Book — quick settlement calculator
//   WIN       → collect the full bet amount
//   HALF WIN  → collect half the bet amount
//   HALF LOSE → pay half of the 90%  (= 45% of the bet)
//   LOSE      → pay 90% of the bet amount
//   PENDING   → saved but not settled yet (counts for nothing until you pick)
// Typed amount is multiplied by the chosen ×1 / ×10 / ×100 at save time.
// Each bet line is saved to Supabase (see src/db.js).

const PAY_RATE = 0.9;
const MULTS = [1, 10, 100];

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");

// Returns how a bet settles: direction (collect/pay/pending), dollar value, and if it's a half result.
function settle(outcome, amount) {
  switch (outcome) {
    case "win":
      return { dir: "collect", value: amount, half: false };
    case "halfwin":
      return { dir: "collect", value: amount * 0.5, half: true };
    case "halflose":
      return { dir: "pay", value: amount * PAY_RATE * 0.5, half: true };
    case "lose":
      return { dir: "pay", value: amount * PAY_RATE, half: false };
    case "pending":
    default:
      return { dir: "pending", value: 0, half: false };
  }
}

const OUTCOMES = [
  { key: "win", label: "Win", tone: "win" },
  { key: "halfwin", label: "½ Win", tone: "win" },
  { key: "halflose", label: "½ Lose", tone: "lose" },
  { key: "lose", label: "Lose", tone: "lose" },
];

export default function App() {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [mult, setMult] = useState(100);
  const [showEarnings, setShowEarnings] = useState(false);
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
  const real = a * mult;
  const canAdd = a > 0;

  // Save the bet first; it starts unsettled and you pick the outcome on its card.
  function save() {
    if (!(a > 0)) return;
    const e = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name.trim(),
      amount: real,
      outcome: "pending",
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
    let collect = 0, pay = 0, pending = 0;
    for (const e of entries) {
      const s = settle(e.outcome, e.amount);
      if (s.dir === "collect") collect += s.value;
      else if (s.dir === "pay") pay += s.value;
      else pending += 1;
    }
    return { collect, pay, net: collect - pay, count: entries.length, pending };
  }, [entries]);

  const netCls = totals.net > 0 ? "bk-pos" : totals.net < 0 ? "bk-neg" : "bk-zero";
  const netSign = totals.net > 0 ? "+" : totals.net < 0 ? "−" : "";

  return (
    <div className="bk">
      <style>{CSS}</style>
      <div className="bk-wrap">
        <header className="bk-head">
          <span className="bk-title">The Book</span>
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

        {/* Earnings — collapsed by default so the book is the focus */}
        <section className="bk-earnings">
          <button
            className="bk-earn-toggle"
            onClick={() => setShowEarnings((v) => !v)}
            aria-expanded={showEarnings}
          >
            <span className="bk-earn-label">
              {showEarnings ? "Hide earnings" : "Show earnings"}
            </span>
            <span className="bk-earn-peek">
              <span className={cx("mono bk-earn-net", netCls)}>
                {netSign}
                {money(Math.abs(totals.net))}
              </span>
              <span className="bk-chev">{showEarnings ? "▾" : "▸"}</span>
            </span>
          </button>

          {showEarnings && (
            <div className="bk-ticker">
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
                {totals.pending > 0 && (
                  <div>
                    <span className="v" style={{ color: "var(--brass)" }}>{totals.pending}</span>
                    <span className="k">unsettled</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Add */}
        <section className="bk-form">
          <div className="bk-form-title">Add a bet</div>
          <input
            className="bk-input"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <div className="bk-field-row">
            <div className="bk-mult" role="group" aria-label="Amount multiplier">
              {MULTS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={cx(mult === m && "on")}
                  onClick={() => setMult(m)}
                >
                  ×{m}
                </button>
              ))}
            </div>
            <div className="bk-money">
              <span className="bk-prefix">$</span>
              <input
                className="bk-input mono bk-amt"
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
              />
              <span className="bk-suffix">×{mult}</span>
            </div>
          </div>

          <div className="bk-preview">
            {canAdd ? <>bet amount = <span className="mono">{money(real)}</span></> : <>&nbsp;</>}
          </div>

          <button className="bk-save" disabled={!canAdd} onClick={save}>
            Save bet
          </button>
        </section>

        {/* Lines */}
        <section>
          {loaded && entries.length === 0 && (
            <div className="bk-empty">No bets yet. Add one above to start the book.</div>
          )}
          {entries.map((e) => {
            const s = settle(e.outcome, e.amount);
            const pending = s.dir === "pending";
            const isCollect = s.dir === "collect";
            return (
              <div className={cx("bk-entry", pending && "is-pending")} key={e.id}>
                <div className="bk-entry-head">
                  <span className={cx("bk-dot", e.outcome)} />
                  <span className={cx("bk-name", !e.name && "empty")}>
                    {e.name || "No name"}
                  </span>
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

                <div className="bk-entry-meta">
                  <span className="bk-entry-sub mono">bet {money(e.amount)}</span>
                  {pending ? (
                    <span className="bk-entry-net bk-pending mono">
                      —<span className="bk-tag">not settled</span>
                    </span>
                  ) : (
                    <span className={cx("bk-entry-net mono", isCollect ? "bk-pos" : "bk-neg")}>
                      {money(s.value)}
                      <span className="bk-tag">
                        {s.dir}
                        {s.half ? " ½" : ""}
                      </span>
                    </span>
                  )}
                </div>

                <div className="bk-outcomes">
                  {OUTCOMES.map((o) => (
                    <button
                      key={o.key}
                      className={cx(
                        e.outcome === o.key && (o.tone === "win" ? "on-win" : "on-lose")
                      )}
                      onClick={() => setOutcome(e.id, o.key)}
                    >
                      {o.label}
                    </button>
                  ))}
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

.bk-head{display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; min-height:30px;}
.bk-title{font-size:.8rem; text-transform:uppercase; letter-spacing:.18em; color:var(--brass); font-weight:700;}
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

/* Earnings (collapsible) */
.bk-earnings{margin-bottom:18px;}
.bk-earn-toggle{width:100%; display:flex; align-items:center; justify-content:space-between;
  background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:13px 16px;
  cursor:pointer; font-family:var(--sans); transition:border-color .15s;}
.bk-earn-toggle:hover{border-color:var(--line2);}
.bk-earn-label{font-size:.68rem; text-transform:uppercase; letter-spacing:.14em; color:var(--dim); font-weight:600;}
.bk-earn-peek{display:flex; align-items:center; gap:10px;}
.bk-earn-net{font-size:1.05rem; font-weight:600;}
.bk-chev{color:var(--faint); font-size:.7rem;}

.bk-ticker{border:1px solid var(--line); border-top:none; border-radius:0 0 16px 16px;
  background:linear-gradient(180deg,var(--panel),var(--bg)); padding:22px 22px 20px; margin-top:-1px;
  animation:bk-in .18s ease;}
.bk-net{font-family:var(--mono); font-variant-numeric:tabular-nums;
  font-size:clamp(2.2rem,8vw,3.2rem); font-weight:600; letter-spacing:-.02em; line-height:1;}
.bk-pos{color:var(--win);} .bk-neg{color:var(--lose);} .bk-zero{color:var(--ink);}
.bk-net-label{font-size:.66rem; text-transform:uppercase; letter-spacing:.16em; color:var(--faint); margin-top:9px;}
.bk-subgrid{display:flex; flex-wrap:wrap; gap:16px 30px; margin-top:20px; padding-top:18px; border-top:1px solid var(--line);}
.bk-subgrid > div{display:flex; flex-direction:column; gap:3px;}
.bk-subgrid .v{font-family:var(--mono); font-size:1.05rem; color:var(--ink); font-variant-numeric:tabular-nums;}
.bk-subgrid .k{font-size:.62rem; text-transform:uppercase; letter-spacing:.12em; color:var(--faint);}

/* Add form */
.bk-form{border:1px solid var(--line); border-radius:16px; background:var(--panel); padding:18px 18px 20px; margin-bottom:22px;}
.bk-form-title{font-size:.66rem; text-transform:uppercase; letter-spacing:.16em; color:var(--brass-dim); margin-bottom:14px; font-weight:600;}
/* 16px keeps iOS Safari from auto-zooming the page when a field is focused. */
.bk-input{width:100%; background:var(--panel2); border:1px solid var(--line2); border-radius:10px;
  color:var(--ink); padding:12px; font-size:16px; font-family:var(--sans); outline:none;
  transition:border-color .15s, box-shadow .15s;}
.bk-input::placeholder{color:var(--faint);}
.bk-input:focus{border-color:var(--brass); box-shadow:0 0 0 3px rgba(203,162,78,.16);}

.bk-field-row{display:grid; grid-template-columns:auto 1fr; gap:12px; margin-top:12px;}
.bk-mult{display:flex; border:1px solid var(--line2); border-radius:10px; overflow:hidden; background:var(--panel2);}
.bk-mult button{padding:0 13px; min-width:48px; border:none; background:transparent; color:var(--dim);
  font-family:var(--mono); font-size:.84rem; font-weight:600; cursor:pointer; transition:all .12s;}
.bk-mult button + button{border-left:1px solid var(--line2);}
.bk-mult button:hover{color:var(--ink);}
.bk-mult button.on{background:rgba(203,162,78,.16); color:var(--brass);}
.bk-money{position:relative;}
.bk-money .bk-prefix{position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--dim); font-family:var(--mono); pointer-events:none;}
.bk-money .bk-input{padding-left:26px;}
.bk-money .bk-amt{padding-right:48px;}
.bk-money .bk-suffix{position:absolute; right:11px; top:50%; transform:translateY(-50%);
  color:var(--brass-dim); font-family:var(--mono); font-size:.72rem; pointer-events:none; letter-spacing:.02em;}

.bk-preview{font-size:.74rem; color:var(--dim); margin:10px 2px 14px; min-height:1em;}
.bk-preview .mono{color:var(--ink);}
.bk-save{width:100%; padding:14px; border-radius:12px; cursor:pointer; font-family:var(--sans);
  font-size:.92rem; font-weight:700; letter-spacing:.02em;
  border:1px solid var(--brass); background:rgba(203,162,78,.16); color:var(--brass); transition:all .15s;}
.bk-save:not(:disabled):hover{background:rgba(203,162,78,.26);}
.bk-save:disabled{opacity:.4; cursor:not-allowed;}

.bk-empty{text-align:center; color:var(--faint); font-size:.86rem; padding:34px 10px;}

/* Bet card */
.bk-entry{border:1px solid var(--line); border-radius:14px; background:var(--panel);
  padding:14px 15px; margin-bottom:10px; animation:bk-in .2s ease;}
.bk-entry.is-pending{border-color:var(--brass-dim); border-style:dashed;}
.bk-entry-head{display:flex; align-items:flex-start; gap:9px;}
.bk-dot{width:9px; height:9px; border-radius:50%; flex-shrink:0; box-sizing:border-box; margin-top:6px;}
.bk-dot.win{background:var(--win);}
.bk-dot.lose{background:var(--lose);}
.bk-dot.halfwin{border:2px solid var(--win);}
.bk-dot.halflose{border:2px solid var(--lose);}
.bk-dot.pending{border:2px solid var(--brass-dim);}
.bk-name{flex:1; min-width:0; font-size:.98rem; color:var(--ink); overflow-wrap:anywhere; font-weight:500; line-height:1.35;}
.bk-name.empty{color:var(--faint); font-weight:400;}

.bk-entry-meta{display:flex; align-items:baseline; justify-content:space-between; gap:12px;
  margin:9px 0 13px; padding-left:18px;}
.bk-entry-sub{font-size:.76rem; color:var(--dim);}
.bk-entry-net{font-size:1.1rem; font-weight:600; white-space:nowrap; text-align:right; line-height:1.1;}
.bk-entry-net.bk-pending{color:var(--faint);}
.bk-tag{display:inline-block; font-family:var(--sans); font-size:.57rem; text-transform:uppercase;
  letter-spacing:.1em; color:var(--faint); margin-left:7px; font-weight:600;}

.bk-outcomes{display:grid; grid-template-columns:repeat(4,1fr); gap:7px;}
.bk-outcomes button{padding:11px 4px; border-radius:10px; cursor:pointer; font-family:var(--sans);
  font-size:.82rem; font-weight:700; white-space:nowrap;
  border:1px solid var(--line2); background:var(--panel2); color:var(--dim); transition:all .13s;}
.bk-outcomes button:hover{color:var(--ink); border-color:var(--faint);}
.bk-outcomes button.on-win{border-color:var(--win); background:var(--win-bg); color:var(--win);}
.bk-outcomes button.on-lose{border-color:var(--lose); background:var(--lose-bg); color:var(--lose);}

.bk-del{width:30px; height:30px; flex-shrink:0; border:1px solid var(--line2); border-radius:8px; background:transparent;
  color:var(--faint); cursor:pointer; font-size:.85rem; line-height:1; transition:all .15s;}
.bk-del:hover{color:var(--lose); border-color:var(--lose);}
.bk-confirm{display:flex; gap:5px; flex-shrink:0;}
.bk-confirm button{padding:6px 10px; border-radius:7px; font-size:.68rem; font-weight:700; cursor:pointer;
  border:1px solid var(--line2); font-family:var(--sans);}
.bk-confirm-yes{background:var(--lose-bg); color:var(--lose); border-color:var(--lose);}
.bk-confirm-no{background:transparent; color:var(--dim);}

@keyframes bk-in{from{opacity:0; transform:translateY(-4px);} to{opacity:1; transform:none;}}
@media (prefers-reduced-motion: reduce){
  .bk-entry,.bk-ticker{animation:none;}
  .bk-input,.bk-save,.bk-outcomes button,.bk-mult button,.bk-del,.bk-clear,.bk-earn-toggle{transition:none;}
}
@media (max-width:420px){
  .bk-wrap{padding:18px 14px 50px;}
  .bk-subgrid{gap:14px 22px;}
  .bk-outcomes button{font-size:.78rem; padding:11px 2px;}
  .bk-mult button{min-width:42px; padding:0 9px;}
}

/* Touch devices: comfortable tap targets. */
@media (pointer:coarse){
  .bk-outcomes button{padding:13px 4px;}
  .bk-mult button{padding:12px 11px;}
  .bk-del{width:38px; height:38px; font-size:.95rem;}
  .bk-clear{padding:9px 14px;}
}
`;
