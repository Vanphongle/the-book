import { useState, useEffect, useRef, useMemo } from "react";

// ─── BUBBLE CRAPS ─────────────────────────────────────────────────────────────
// A faithful simulation of an electronic "bubble craps" machine (Interblock /
// Aruze style): two dice bounced in a dome, a betting countdown timer, and the
// full touchscreen bet menu of a live table.
//
// Implemented exactly like the machines:
//   • Pass / Don't Pass (bar 12) with free odds — 3x-4x-5x caps, true-odds pays
//   • Come / Don't Come with odds (come odds OFF on the come-out, like standard)
//   • Place 4 5 6 8 9 10 (9:5, 7:5, 7:6) — working only while the point is ON
//   • Field (2 pays double; 12 double, or triple via settings)
//   • Hardways (7:1 on 4/10, 9:1 on 6/8) — stay up until made or sevened out
//   • One-roll props: Any 7 (4:1), Any Craps (7:1), 2 & 12 (30:1), 3 & 11 (15:1),
//     C&E (3:1 / 7:1), Horn (6.75:1 / 3:1)
//   • Lucky Shooter side bet (Interblock) — unique point numbers rolled before a
//     seven-out (paytable varies by casino; one common table used here)
//   • Roll history strip, point puck ON/OFF, chip rack, Repeat / Double / Clear,
//     auto-roll timer with color countdown, play-money bankroll (localStorage)
//
// 100% separate from The Book's data — nothing here touches Supabase.

const LS_BANK = "the-book.craps.bank.v1";
const START_BANK = 1000;
const POINTS = [4, 5, 6, 8, 9, 10];
const CHIPS = [1, 5, 10, 25, 100];

// True odds paid on pass/come odds, and place-bet rates.
const ODDS_PAY = { 4: 2, 5: 1.5, 6: 1.2, 8: 1.2, 9: 1.5, 10: 2 };
const LAY_PAY = { 4: 0.5, 5: 2 / 3, 6: 5 / 6, 8: 5 / 6, 9: 2 / 3, 10: 0.5 };
const PLACE_PAY = { 4: 1.8, 5: 1.4, 6: 7 / 6, 8: 7 / 6, 9: 1.4, 10: 1.8 };
const ODDS_CAP = { 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3 }; // 3x-4x-5x
const HARD_PAY = { 4: 7, 6: 9, 8: 9, 10: 7 };
// Lucky Shooter — one commonly seen paytable (varies by casino).
const LUCKY_PAY = { 3: 1, 4: 5, 5: 25, 6: 100 };

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const rollDie = () => 1 + Math.floor(Math.random() * 6);

const emptyNums = () => ({ 4: 0, 5: 0, 6: 0, 8: 0, 9: 0, 10: 0 });
const emptyBets = () => ({
  pass: 0,
  passOdds: 0,
  dontPass: 0,
  dontPassOdds: 0,
  comeFlat: 0,
  dontComeFlat: 0,
  come: emptyNums(),
  comeOdds: emptyNums(),
  dontCome: emptyNums(),
  dontComeOdds: emptyNums(),
  place: emptyNums(),
  buy: emptyNums(),
  lay: emptyNums(),
  field: 0,
  hard: { 4: 0, 6: 0, 8: 0, 10: 0 },
  any7: 0,
  anyCraps: 0,
  two: 0,
  three: 0,
  eleven: 0,
  twelve: 0,
  ce: 0,
  horn: 0,
});

const VIG = 0.05; // 5% commission on buy/lay wins

const sumBets = (b, lucky) =>
  b.pass + b.passOdds + b.dontPass + b.dontPassOdds + b.comeFlat + b.dontComeFlat +
  b.field + b.any7 + b.anyCraps + b.two + b.three + b.eleven + b.twelve + b.ce + b.horn +
  POINTS.reduce(
    (s, n) => s + b.come[n] + b.comeOdds[n] + b.dontCome[n] + b.dontComeOdds[n] + b.place[n] + b.buy[n] + b.lay[n],
    0
  ) +
  [4, 6, 8, 10].reduce((s, n) => s + b.hard[n], 0) +
  (lucky.active || lucky.bet ? lucky.bet : 0);

// Die face pips.
function Die({ v, rolling }) {
  const P = {
    1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
  };
  return (
    <div className={cx("cr-die", rolling && "rolling")}>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={cx("pip", (P[v] || []).includes(i) && "on")} />
      ))}
    </div>
  );
}

export default function Craps() {
  const [bank, setBank] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS_BANK));
    return v > 0 ? v : START_BANK;
  });
  const [bets, setBets] = useState(emptyBets);
  const [lucky, setLucky] = useState({ bet: 0, active: false, hits: [] });
  const [point, setPoint] = useState(null);
  const [dice, setDice] = useState([3, 4]);
  const [rolling, setRolling] = useState(false);
  const [history, setHistory] = useState([]); // {d1,d2,total,mark}
  const [log, setLog] = useState(["Welcome — place your bets and hit ROLL."]);
  const [lastWin, setLastWin] = useState(0);
  const [chip, setChip] = useState(5);
  const [auto, setAuto] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [field12Triple, setField12Triple] = useState(false);
  const [undoStack, setUndoStack] = useState([]); // placements since last roll
  const [prevRound, setPrevRound] = useState([]); // placements of previous round (for Repeat)

  // Refs mirror bank/bets/lucky so several placements in one tick (Repeat,
  // Double) validate against up-to-date values instead of stale state.
  const bankRef = useRef(bank);
  const betsRef = useRef(bets);
  const luckyRef = useRef(lucky);
  useEffect(() => localStorage.setItem(LS_BANK, String(bank)), [bank]);
  const commitBank = (v) => { bankRef.current = v; setBank(v); };
  const commitBets = (b) => { betsRef.current = b; setBets(b); };
  const commitLucky = (l) => { luckyRef.current = l; setLucky(l); };

  const onBoard = useMemo(() => sumBets(bets, lucky), [bets, lucky]);

  const say = (msgs) =>
    setLog((prev) => [...(Array.isArray(msgs) ? msgs : [msgs]), ...prev].slice(0, 6));

  // ── placing bets ────────────────────────────────────────────────────────────
  // path: string key, or ["come", n] style tuple for nested maps.
  function getBet(b, path) {
    return Array.isArray(path) ? b[path[0]][path[1]] : b[path];
  }
  function setBet(b, path, v) {
    if (Array.isArray(path)) return { ...b, [path[0]]: { ...b[path[0]], [path[1]]: v } };
    return { ...b, [path]: v };
  }

  function place(path, opts = {}) {
    if (rolling) return;
    const B = betsRef.current;
    const amt = opts.amount ?? chip;
    if (amt <= 0 || bankRef.current < amt) return say("Not enough credits.");
    // legality checks
    if (path === "pass" && point) return say("Pass line only before the come-out.");
    if (path === "dontPass" && point) return say("Don't Pass only before the come-out.");
    if ((path === "comeFlat" || path === "dontComeFlat") && !point)
      return say("Come bets only while the point is ON.");
    if (path === "passOdds") {
      if (!point || !B.pass) return say("Need a pass line bet and a point.");
      const cap = B.pass * ODDS_CAP[point];
      if (B.passOdds + amt > cap) return say(`Max odds ${ODDS_CAP[point]}x (${money(cap)}).`);
    }
    if (path === "dontPassOdds") {
      if (!point || !B.dontPass) return say("Need a Don't Pass bet and a point.");
      if (B.dontPassOdds + amt > B.dontPass * 6) return say("Max lay odds 6x.");
    }
    if (Array.isArray(path) && path[0] === "comeOdds") {
      const n = path[1];
      if (!B.come[n]) return say("No come bet on that number.");
      const cap = B.come[n] * ODDS_CAP[n];
      if (B.comeOdds[n] + amt > cap) return say(`Max odds ${ODDS_CAP[n]}x (${money(cap)}).`);
    }
    if (Array.isArray(path) && path[0] === "dontComeOdds") {
      const n = path[1];
      if (!B.dontCome[n]) return say("No don't come bet on that number.");
      if (B.dontComeOdds[n] + amt > B.dontCome[n] * 6) return say("Max lay odds 6x.");
    }
    if (path === "lucky") {
      if (point || luckyRef.current.active) return say("Lucky Shooter only before a new come-out.");
      commitBank(bankRef.current - amt);
      commitLucky({ ...luckyRef.current, bet: luckyRef.current.bet + amt });
      setUndoStack((u) => [...u, { path: "lucky", amt }]);
      return;
    }
    commitBank(bankRef.current - amt);
    commitBets(setBet(B, path, getBet(B, path) + amt));
    setUndoStack((u) => [...u, { path, amt }]);
  }

  // Which bets are locked (contract bets that can't come down).
  function isLocked(path) {
    if (path === "pass" || path === "passOdds") return !!point && path === "pass";
    if (Array.isArray(path) && path[0] === "come") return true; // traveled come flats stay
    if (path === "lucky") return lucky.active;
    return false;
  }

  function removeBet(path) {
    if (rolling || isLocked(path)) return;
    if (path === "lucky") {
      const l = luckyRef.current;
      if (l.bet && !l.active) {
        commitBank(bankRef.current + l.bet);
        commitLucky({ ...l, bet: 0 });
      }
      return;
    }
    const amt = getBet(betsRef.current, path);
    if (!amt) return;
    let B = setBet(betsRef.current, path, 0);
    let back = amt;
    // taking down a Don't Pass flat also returns its lay odds (no orphan odds)
    if (path === "dontPass" && B.dontPassOdds) {
      back += B.dontPassOdds;
      B = setBet(B, "dontPassOdds", 0);
    }
    commitBank(bankRef.current + back);
    commitBets(B);
  }

  function undoLast() {
    if (rolling || !undoStack.length) return;
    const last = undoStack[undoStack.length - 1];
    if (last.path === "lucky") {
      const l = luckyRef.current;
      if (l.active) return;
      commitLucky({ ...l, bet: Math.max(0, l.bet - last.amt) });
    } else {
      if (isLocked(last.path)) return;
      const B = betsRef.current;
      commitBets(setBet(B, last.path, Math.max(0, getBet(B, last.path) - last.amt)));
    }
    commitBank(bankRef.current + last.amt);
    setUndoStack((u) => u.slice(0, -1));
  }

  function repeatLast() {
    if (rolling || !prevRound.length) return;
    for (const p of prevRound) place(p.path, { amount: p.amt });
  }

  function doubleBets() {
    if (rolling) return;
    for (const p of undoStack) place(p.path, { amount: p.amt });
  }

  // ── the roll ────────────────────────────────────────────────────────────────
  const rollTimer = useRef(null);
  function roll() {
    if (rolling) return;
    setRolling(true);
    setCountdown(0);
    // dice bounce animation
    const anim = setInterval(() => setDice([rollDie(), rollDie()]), 90);
    rollTimer.current = setTimeout(() => {
      clearInterval(anim);
      const d1 = rollDie(), d2 = rollDie();
      setDice([d1, d2]);
      resolve(d1, d2);
      setRolling(false);
    }, 1400);
  }
  useEffect(() => () => clearTimeout(rollTimer.current), []);

  // auto-roll countdown
  useEffect(() => {
    if (!auto || rolling) return;
    if (countdown <= 0) {
      setCountdown(12);
      return;
    }
    const t = setTimeout(() => {
      if (countdown === 1) roll();
      else setCountdown((c) => c - 1);
    }, 1000);
    return () => clearTimeout(t);
  }, [auto, rolling, countdown]); // eslint-disable-line

  function resolve(d1, d2) {
    const total = d1 + d2;
    const isPair = d1 === d2;
    const comeOut = point == null;
    let credit = 0; // returned stakes + winnings
    let winnings = 0; // pure winnings for the banner
    const events = [];
    const orig = betsRef.current;
    let b = JSON.parse(JSON.stringify(orig));
    let L = { ...luckyRef.current, hits: [...luckyRef.current.hits] };
    let newPoint = point;
    let mark = null;

    const pay = (label, stakeBack, win) => {
      credit += stakeBack + win;
      winnings += win;
      if (win > 0) events.push(`${label} +${money(win)}`);
    };

    // ── one-roll props ──
    if (b.field) {
      const f = total === 2 ? 2 : total === 12 ? (field12Triple ? 3 : 2)
        : [3, 4, 9, 10, 11].includes(total) ? 1 : -1;
      if (f > 0) pay("Field", 0, b.field * f); // bet stays up
      else { events.push("Field loses"); b.field = 0; }
    }
    const oneRoll = (key, hit, mult, label) => {
      if (!b[key]) return;
      if (hit) pay(label, b[key], b[key] * mult);
      b[key] = 0;
    };
    oneRoll("any7", total === 7, 4, "Any 7");
    oneRoll("anyCraps", [2, 3, 12].includes(total), 7, "Any Craps");
    oneRoll("two", total === 2, 30, "Aces");
    oneRoll("twelve", total === 12, 30, "Midnight");
    oneRoll("three", total === 3, 15, "Ace-Deuce");
    oneRoll("eleven", total === 11, 15, "Yo");
    // C&E: split bet — craps side nets 3:1 on the total, yo side nets 7:1.
    if (b.ce) {
      if ([2, 3, 12].includes(total)) pay("C&E (craps)", b.ce, b.ce * 3);
      else if (total === 11) pay("C&E (yo)", b.ce, b.ce * 7);
      b.ce = 0;
    }
    if (b.horn) {
      if (total === 2 || total === 12) pay("Horn", b.horn, b.horn * 6.75);
      else if (total === 3 || total === 11) pay("Horn", b.horn, b.horn * 3);
      b.horn = 0;
    }

    // ── hardways ──
    for (const n of [4, 6, 8, 10]) {
      if (!b.hard[n]) continue;
      if (total === 7) { b.hard[n] = 0; }
      else if (total === n) {
        if (isPair) pay(`Hard ${n}`, 0, b.hard[n] * HARD_PAY[n]); // stays up
        else b.hard[n] = 0; // easy way — down
      }
    }
    if (total === 7 && (orig.hard[4] || orig.hard[6] || orig.hard[8] || orig.hard[10]))
      events.push("Hardways down");

    // ── come flats placed this round (act like their own come-out) ──
    if (b.comeFlat) {
      if (total === 7 || total === 11) pay("Come", b.comeFlat, b.comeFlat);
      else if ([2, 3, 12].includes(total)) events.push("Come loses");
      else { b.come[total] += b.comeFlat; events.push(`Come to the ${total}`); }
      b.comeFlat = 0;
    }
    if (b.dontComeFlat) {
      if (total === 2 || total === 3) pay("Don't Come", b.dontComeFlat, b.dontComeFlat);
      else if (total === 12) { credit += b.dontComeFlat; events.push("Don't Come pushes (bar 12)"); }
      else if (total === 7 || total === 11) events.push("Don't Come loses");
      else { b.dontCome[total] += b.dontComeFlat; events.push(`Don't Come behind the ${total}`); }
      b.dontComeFlat = 0;
    }

    // ── come / don't come numbers ──
    if (total === 7) {
      for (const n of POINTS) {
        if (b.come[n]) {
          // flat loses; odds off on the come-out → returned, else lost
          if (comeOut && b.comeOdds[n]) { credit += b.comeOdds[n]; events.push(`Come odds ${n} returned (off)`); }
          b.come[n] = 0; b.comeOdds[n] = 0;
        }
        if (b.dontCome[n]) {
          pay(`Don't Come ${n}`, b.dontCome[n], b.dontCome[n]);
          if (b.dontComeOdds[n]) pay(`DC odds ${n}`, b.dontComeOdds[n], b.dontComeOdds[n] * LAY_PAY[n]);
          b.dontCome[n] = 0; b.dontComeOdds[n] = 0;
        }
      }
    } else if (POINTS.includes(total)) {
      if (b.come[total]) {
        pay(`Come ${total}`, b.come[total], b.come[total]);
        if (b.comeOdds[total]) {
          if (comeOut) { credit += b.comeOdds[total]; events.push(`Come odds ${total} returned (off)`); }
          else pay(`Come odds ${total}`, b.comeOdds[total], b.comeOdds[total] * ODDS_PAY[total]);
        }
        b.come[total] = 0; b.comeOdds[total] = 0;
      }
      if (b.dontCome[total]) { b.dontCome[total] = 0; b.dontComeOdds[total] = 0; events.push(`Don't Come ${total} loses`); }
    }

    // ── place & buy bets (working only with the point ON) ──
    if (!comeOut) {
      if (total === 7) {
        if (POINTS.some((n) => b.place[n])) events.push("Place bets down");
        if (POINTS.some((n) => b.buy[n])) events.push("Buy bets down");
        for (const n of POINTS) { b.place[n] = 0; b.buy[n] = 0; }
      } else if (POINTS.includes(total)) {
        if (b.place[total]) pay(`Place ${total}`, 0, b.place[total] * PLACE_PAY[total]); // stays up
        if (b.buy[total]) {
          // true odds minus the 5% vig on the win; bet stays up
          const win = b.buy[total] * ODDS_PAY[total] * (1 - VIG);
          pay(`Buy ${total}`, 0, win);
        }
      }
    }

    // ── lay bets (always working, even on the come-out) ──
    if (total === 7) {
      for (const n of POINTS) {
        if (!b.lay[n]) continue;
        const win = b.lay[n] * LAY_PAY[n] * (1 - VIG); // true odds against − 5% vig
        pay(`Lay ${n}`, b.lay[n], win); // paid and taken down
        b.lay[n] = 0;
      }
    } else if (POINTS.includes(total) && b.lay[total]) {
      b.lay[total] = 0;
      events.push(`Lay ${total} loses`);
    }

    // ── pass / don't pass & the point ──
    if (comeOut) {
      mark = "co";
      if (total === 7 || total === 11) {
        if (b.pass) pay("Pass line", 0, b.pass); // stays up
        if (b.dontPass) { b.dontPass = 0; events.push("Don't Pass loses"); }
      } else if ([2, 3, 12].includes(total)) {
        if (b.pass) { b.pass = 0; events.push("Pass line loses — craps"); }
        if (b.dontPass) {
          if (total === 12) events.push("Don't Pass pushes (bar 12)");
          else pay("Don't Pass", 0, b.dontPass); // stays up
        }
      } else {
        newPoint = total;
        mark = "point";
        events.push(`Point is ${total}`);
        // an already-live Lucky Shooter also counts a fresh come-out point
        if (L.active && !L.hits.includes(total)) L.hits.push(total);
      }
      // Lucky Shooter come-out
      if (L.bet && !L.active) {
        if ([2, 3, 12].includes(total)) { L.bet = 0; events.push("Lucky Shooter loses"); }
        else if (total === 7 || total === 11) { credit += L.bet; L.bet = 0; events.push("Lucky Shooter pushes"); }
        else { L.active = true; L.hits = [total]; events.push("Lucky Shooter is live"); }
      }
    } else {
      if (total === point) {
        mark = "made";
        events.push(`Winner — ${total}, pass pays`);
        if (b.pass) pay("Pass line", 0, b.pass); // flat stays for next come-out
        if (b.passOdds) { pay("Pass odds", b.passOdds, b.passOdds * ODDS_PAY[point]); b.passOdds = 0; }
        if (b.dontPass) { b.dontPass = 0; b.dontPassOdds = 0; events.push("Don't Pass loses"); }
        newPoint = null;
        if (L.active && !L.hits.includes(total)) L.hits.push(total);
      } else if (total === 7) {
        mark = "out";
        events.push("Seven out");
        if (b.pass) { b.pass = 0; }
        if (b.passOdds) { b.passOdds = 0; }
        if (b.dontPass) {
          pay("Don't Pass", 0, b.dontPass);
          if (b.dontPassOdds) { pay("DP odds", b.dontPassOdds, b.dontPassOdds * LAY_PAY[point]); b.dontPassOdds = 0; }
        }
        newPoint = null;
        // Lucky Shooter settles on the seven-out
        if (L.active) {
          const h = L.hits.length;
          const mult = LUCKY_PAY[Math.min(h, 6)] && h >= 3 ? LUCKY_PAY[Math.min(h, 6)] : 0;
          if (mult > 0) pay(`Lucky Shooter (${h} hits)`, L.bet, L.bet * mult);
          else events.push(`Lucky Shooter loses (${h} hit${h === 1 ? "" : "s"})`);
          L = { bet: 0, active: false, hits: [] };
        }
      } else {
        if (L.active && POINTS.includes(total) && !L.hits.includes(total)) {
          L.hits.push(total);
          events.push(`Lucky Shooter hit: ${total}`);
        }
      }
    }

    commitBets(b);
    commitLucky(L);
    setPoint(newPoint);
    if (credit > 0) commitBank(bankRef.current + credit);
    setLastWin(winnings);
    setHistory((h) => [{ d1, d2, total, mark }, ...h].slice(0, 18));
    say(events.length ? events : [`${total} — no action`]);
    setPrevRound(undoStack);
    setUndoStack([]);
  }

  function cashReset() {
    if (rolling) return;
    if (!window.confirm("Reset play bankroll to $1,000? Bets on the board are cleared.")) return;
    commitBets(emptyBets());
    commitLucky({ bet: 0, active: false, hits: [] });
    setPoint(null);
    commitBank(START_BANK);
    setUndoStack([]);
    setPrevRound([]);
    say("Fresh bankroll. Good luck!");
  }

  // ── bet cell UI helper ──────────────────────────────────────────────────────
  const Cell = ({ label, sub, path, amt, tone, disabled, wide }) => (
    <div
      className={cx("cr-cell", tone, disabled && "disabled", wide && "wide", amt > 0 && "has")}
      onClick={() => !disabled && place(path)}
    >
      <div className="cr-cell-label">{label}</div>
      {sub && <div className="cr-cell-sub">{sub}</div>}
      {amt > 0 && (
        <div className="cr-chipamt">
          {money(amt)}
          {!isLocked(path) && (
            <button
              className="cr-x"
              onClick={(e) => { e.stopPropagation(); removeBet(path); }}
              aria-label={`Remove ${label}`}
            >✕</button>
          )}
        </div>
      )}
    </div>
  );

  const total = dice[0] + dice[1];

  return (
    <div className="cr">
      <style>{CSS}</style>
      <div className="cr-wrap">
        <header className="cr-head">
          <a className="cr-back" href="#">← The Book</a>
          <span className="cr-title">BUBBLE CRAPS</span>
          <button className="cr-reset" onClick={cashReset}>Reset</button>
        </header>

        {/* Dome */}
        <section className="cr-dome">
          <div className="cr-bubble">
            <Die v={dice[0]} rolling={rolling} />
            <Die v={dice[1]} rolling={rolling} />
            <div className={cx("cr-total", rolling && "dim")}>{rolling ? "…" : total}</div>
          </div>
          <div className="cr-dome-side">
            <div className={cx("cr-puck", point ? "on" : "off")}>
              {point ? <><b>{point}</b><span>ON</span></> : <span>OFF</span>}
            </div>
            <button className="cr-roll" disabled={rolling} onClick={roll}>
              {rolling ? "ROLLING…" : "ROLL"}
            </button>
            <label className="cr-auto">
              <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setCountdown(12); }} />
              auto
            </label>
            {auto && !rolling && (
              <div className={cx("cr-timer", countdown <= 4 && "hot")}>{countdown}s</div>
            )}
          </div>
        </section>

        {/* Roll history */}
        <div className="cr-hist">
          {history.length === 0 && <span className="cr-hist-empty">roll history</span>}
          {history.map((h, i) => (
            <span key={i} className={cx("cr-hist-item", h.mark)}>
              {h.total}
              {h.mark === "point" && <em>P</em>}
              {h.mark === "out" && <em>7o</em>}
              {h.mark === "made" && <em>★</em>}
            </span>
          ))}
        </div>

        {/* Status */}
        <section className="cr-status">
          <div><span className="v mono">{money(bank)}</span><span className="k">credits</span></div>
          <div><span className="v mono">{money(onBoard)}</span><span className="k">on board</span></div>
          <div>
            <span className={cx("v mono", lastWin > 0 && "win")}>{lastWin > 0 ? `+${money(lastWin)}` : money(0)}</span>
            <span className="k">last win</span>
          </div>
        </section>
        <div className="cr-log">{log.map((m, i) => <div key={i} className={cx(i === 0 && "new")}>{m}</div>)}</div>

        {/* Chips + actions */}
        <section className="cr-rack">
          {CHIPS.map((c) => (
            <button key={c} className={cx("cr-chip", `c${c}`, chip === c && "sel")} onClick={() => setChip(c)}>
              ${c}
            </button>
          ))}
          <span className="cr-actions">
            <button onClick={undoLast} disabled={!undoStack.length}>Undo</button>
            <button onClick={repeatLast} disabled={!prevRound.length}>Repeat</button>
            <button onClick={doubleBets} disabled={!undoStack.length}>Double</button>
          </span>
        </section>

        {/* Line bets */}
        <section className="cr-zone">
          <h2>Line bets</h2>
          <div className="cr-grid2">
            <Cell label="PASS LINE" sub="pays 1:1" path="pass" amt={bets.pass} tone="pass" disabled={!!point && !bets.pass} />
            <Cell label="DON'T PASS" sub="1:1 · bar 12" path="dontPass" amt={bets.dontPass} tone="dont" disabled={!!point && !bets.dontPass} />
            <Cell
              label="PASS ODDS" sub={point ? `${ODDS_CAP[point]}x max · true odds` : "point required"}
              path="passOdds" amt={bets.passOdds} tone="odds" disabled={!point || !bets.pass}
            />
            <Cell
              label="LAY ODDS" sub={point ? "6x max · lays the point" : "point required"}
              path="dontPassOdds" amt={bets.dontPassOdds} tone="odds" disabled={!point || !bets.dontPass}
            />
          </div>
        </section>

        {/* Come area */}
        <section className="cr-zone">
          <h2>Come / Don't Come {point ? "" : "(point must be ON)"}</h2>
          <div className="cr-grid2">
            <Cell label="COME" sub="next roll is its come-out" path="comeFlat" amt={bets.comeFlat} tone="pass" disabled={!point} />
            <Cell label="DON'T COME" sub="bar 12" path="dontComeFlat" amt={bets.dontComeFlat} tone="dont" disabled={!point} />
          </div>
          <div className="cr-nums">
            {POINTS.map((n) => (
              <div key={n} className={cx("cr-num", point === n && "ispoint")}>
                <div className="cr-num-title">{n}</div>
                {bets.come[n] > 0 && (
                  <button className="cr-mini pass" onClick={() => place(["comeOdds", n])}>
                    C {money(bets.come[n])}{bets.comeOdds[n] > 0 && ` +${money(bets.comeOdds[n])}`}
                    <em>+odds</em>
                  </button>
                )}
                {bets.dontCome[n] > 0 && (
                  <button className="cr-mini dont" onClick={() => place(["dontComeOdds", n])}>
                    DC {money(bets.dontCome[n])}{bets.dontComeOdds[n] > 0 && ` +${money(bets.dontComeOdds[n])}`}
                    <em>+odds</em>
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="cr-note">Come odds are OFF on the come-out (returned if the 7 wins for the pass).</div>
        </section>

        {/* Place / Buy / Lay */}
        <section className="cr-zone">
          <h2>Place · Buy · Lay {point ? "(place/buy working)" : "(place/buy off until point is ON · lay always works)"}</h2>
          <div className="cr-nums">
            {POINTS.map((n) => {
              const placeRate = n === 4 || n === 10 ? "9:5" : n === 5 || n === 9 ? "7:5" : "7:6";
              const buyRate = n === 4 || n === 10 ? "2:1" : n === 5 || n === 9 ? "3:2" : "6:5";
              const layRate = n === 4 || n === 10 ? "1:2" : n === 5 || n === 9 ? "2:3" : "5:6";
              const row = (kind, label, rate, amt) => (
                <button className={cx("cr-pbl", kind, amt > 0 && "has")} onClick={() => place([kind, n])}>
                  <span className="cr-pbl-k">{label}</span>
                  <span className="cr-pbl-r">{rate}</span>
                  {amt > 0 && (
                    <span className="cr-pbl-amt">
                      {money(amt)}
                      <i className="cr-x" onClick={(e) => { e.stopPropagation(); removeBet([kind, n]); }}>✕</i>
                    </span>
                  )}
                </button>
              );
              return (
                <div key={n} className={cx("cr-num cr-pblcol", point === n && "ispoint")}>
                  <div className="cr-num-title">{n}</div>
                  {row("place", "PLACE", placeRate, bets.place[n])}
                  {row("buy", "BUY", `${buyRate}−5%`, bets.buy[n])}
                  {row("lay", "LAY", `${layRate}−5%`, bets.lay[n])}
                </div>
              );
            })}
          </div>
          <div className="cr-note">
            Buy pays true odds with a 5% vig taken on the win — better than Place on the 4 &amp; 10;
            Place (7:6) beats Buy on the 6 &amp; 8. Lay bets win when the 7 rolls before the number
            and are always working.
          </div>
        </section>

        {/* Field */}
        <section className="cr-zone">
          <Cell
            label="FIELD — 2 · 3 · 4 · 9 · 10 · 11 · 12"
            sub={`one roll · 2 pays double · 12 pays ${field12Triple ? "TRIPLE" : "double"}`}
            path="field" amt={bets.field} tone="field" wide
          />
        </section>

        {/* Hardways */}
        <section className="cr-zone">
          <h2>Hardways (stay up until made easy or seven-out)</h2>
          <div className="cr-grid4">
            {[4, 6, 8, 10].map((n) => (
              <Cell key={n} label={`HARD ${n}`} sub={`${HARD_PAY[n]}:1`} path={["hard", n]} amt={bets.hard[n]} tone="hard" />
            ))}
          </div>
        </section>

        {/* Props */}
        <section className="cr-zone">
          <h2>One-roll propositions</h2>
          <div className="cr-grid4">
            <Cell label="ANY 7" sub="4:1" path="any7" amt={bets.any7} tone="prop" />
            <Cell label="ANY CRAPS" sub="7:1" path="anyCraps" amt={bets.anyCraps} tone="prop" />
            <Cell label="ACES (2)" sub="30:1" path="two" amt={bets.two} tone="prop" />
            <Cell label="12" sub="30:1" path="twelve" amt={bets.twelve} tone="prop" />
            <Cell label="ACE-DEUCE (3)" sub="15:1" path="three" amt={bets.three} tone="prop" />
            <Cell label="YO (11)" sub="15:1" path="eleven" amt={bets.eleven} tone="prop" />
            <Cell label="C & E" sub="craps 3:1 · yo 7:1" path="ce" amt={bets.ce} tone="prop" />
            <Cell label="HORN" sub="2/12 6.75:1 · 3/11 3:1" path="horn" amt={bets.horn} tone="prop" />
          </div>
        </section>

        {/* Lucky Shooter */}
        <section className="cr-zone">
          <h2>Lucky Shooter (side bet)</h2>
          <div
            className={cx("cr-lucky", lucky.active && "live")}
            onClick={() => place("lucky")}
          >
            <div className="cr-lucky-top">
              <span>bet before a new come-out · unique point numbers rolled before the seven-out</span>
              {lucky.bet > 0 && (
                <span className="cr-chipamt">
                  {money(lucky.bet)}
                  {!lucky.active && (
                    <button className="cr-x" onClick={(e) => { e.stopPropagation(); removeBet("lucky"); }}>✕</button>
                  )}
                </span>
              )}
            </div>
            <div className="cr-lucky-lights">
              {POINTS.map((n) => (
                <span key={n} className={cx("light", lucky.hits.includes(n) && "hit")}>{n}</span>
              ))}
            </div>
            <div className="cr-lucky-pays">3 hits 1:1 · 4 hits 5:1 · 5 hits 25:1 · 6 hits 100:1 <i>(paytable varies by casino)</i></div>
          </div>
        </section>

        {/* Settings */}
        <section className="cr-zone cr-settings">
          <label><input type="checkbox" checked={field12Triple} onChange={(e) => setField12Triple(e.target.checked)} /> Field 12 pays triple</label>
          <span className="cr-note">Play money only · odds 3x-4x-5x · place bets off on come-out, like the real machines.</span>
        </section>
      </div>
    </div>
  );
}

const CSS = `
.cr{
  --bg:#0d1410; --panel:#13201a; --panel2:#1a2b22; --line:#24382d; --line2:#33513f;
  --ink:#e9f0e4; --dim:#9fb3a0; --faint:#6b8070;
  --brass:#cba24e; --red:#e45d54; --green:#57c07a; --blue:#5aa7d6;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  font-family:var(--sans); background:var(--bg); color:var(--ink); min-height:100vh;
  -webkit-font-smoothing:antialiased;
}
.cr *{box-sizing:border-box;}
.cr .mono{font-family:var(--mono); font-variant-numeric:tabular-nums;}
.cr-wrap{max-width:600px; margin:0 auto; padding:16px 14px 70px;}
.cr-head{display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;}
.cr-back{color:var(--dim); text-decoration:none; font-size:.82rem;}
.cr-back:hover{color:var(--brass);}
.cr-title{font-size:.85rem; letter-spacing:.22em; color:var(--brass); font-weight:800;}
.cr-reset{background:transparent; border:1px solid var(--line2); color:var(--faint); border-radius:8px;
  padding:6px 11px; font-size:.72rem; cursor:pointer;}
.cr-reset:hover{color:var(--red); border-color:var(--red);}

/* dome */
.cr-dome{display:flex; gap:14px; align-items:stretch;}
.cr-bubble{flex:1; position:relative; display:flex; gap:18px; align-items:center; justify-content:center;
  background:radial-gradient(ellipse at 50% 30%, #21362a, #101a14 75%);
  border:2px solid var(--line2); border-radius:50% / 42%; min-height:150px;
  box-shadow:inset 0 14px 34px rgba(255,255,255,.05), inset 0 -18px 30px rgba(0,0,0,.5);}
.cr-die{width:52px; height:52px; background:#f5f0e6; border-radius:10px; display:grid;
  grid-template-columns:repeat(3,1fr); padding:7px; gap:2px;
  box-shadow:0 6px 14px rgba(0,0,0,.55), inset 0 -3px 0 rgba(0,0,0,.15);}
.cr-die.rolling{animation:cr-bounce .35s infinite alternate;}
@keyframes cr-bounce{from{transform:translateY(-9px) rotate(-7deg);} to{transform:translateY(7px) rotate(8deg);}}
.cr-die .pip{border-radius:50%; background:transparent;}
.cr-die .pip.on{background:#1c1a17;}
.cr-total{position:absolute; bottom:10px; right:22px; font-family:var(--mono); font-size:1.5rem;
  font-weight:700; color:var(--brass);}
.cr-total.dim{opacity:.35;}
.cr-dome-side{display:flex; flex-direction:column; gap:8px; align-items:center; justify-content:center; width:92px;}
.cr-puck{width:56px; height:56px; border-radius:50%; display:flex; flex-direction:column; align-items:center;
  justify-content:center; font-family:var(--sans); line-height:1;}
.cr-puck.on{background:#f5f0e6; color:#111;}
.cr-puck.on b{font-size:1.15rem;}
.cr-puck.on span{font-size:.55rem; font-weight:800; letter-spacing:.1em;}
.cr-puck.off{background:#171717; color:#888; border:2px solid #333; font-size:.6rem; font-weight:800; letter-spacing:.1em;}
.cr-roll{width:100%; padding:12px 4px; border-radius:12px; border:1px solid var(--brass);
  background:rgba(203,162,78,.2); color:var(--brass); font-weight:800; letter-spacing:.08em; cursor:pointer; font-size:.9rem;}
.cr-roll:disabled{opacity:.5; cursor:wait;}
.cr-roll:not(:disabled):hover{background:rgba(203,162,78,.32);}
.cr-auto{display:flex; align-items:center; gap:5px; font-size:.72rem; color:var(--dim); cursor:pointer;}
.cr-timer{font-family:var(--mono); font-size:.85rem; color:var(--green); font-weight:700;}
.cr-timer.hot{color:var(--red); animation:cr-blink .5s infinite alternate;}
@keyframes cr-blink{from{opacity:1;} to{opacity:.4;}}

/* history */
.cr-hist{display:flex; gap:6px; overflow-x:auto; padding:10px 2px; min-height:40px;}
.cr-hist-empty{color:var(--faint); font-size:.72rem;}
.cr-hist-item{position:relative; min-width:30px; height:30px; flex-shrink:0; display:flex; align-items:center;
  justify-content:center; background:var(--panel2); border:1px solid var(--line2); border-radius:8px;
  font-family:var(--mono); font-size:.85rem; font-weight:700;}
.cr-hist-item.out{border-color:var(--red); color:var(--red);}
.cr-hist-item.made{border-color:var(--green); color:var(--green);}
.cr-hist-item.point{border-color:var(--brass); color:var(--brass);}
.cr-hist-item em{position:absolute; top:-7px; right:-5px; font-size:.52rem; font-style:normal; background:var(--bg); padding:0 2px;}

/* status + log */
.cr-status{display:flex; gap:22px; padding:10px 4px 4px;}
.cr-status > div{display:flex; flex-direction:column; gap:2px;}
.cr-status .v{font-size:1.02rem; font-weight:600;}
.cr-status .v.win{color:var(--green);}
.cr-status .k{font-size:.6rem; text-transform:uppercase; letter-spacing:.12em; color:var(--faint);}
.cr-log{padding:6px 4px 2px; font-size:.74rem; color:var(--faint); min-height:52px;}
.cr-log .new{color:var(--ink);}

/* chip rack */
.cr-rack{display:flex; gap:8px; align-items:center; padding:10px 0 4px; flex-wrap:wrap;}
.cr-chip{width:46px; height:46px; border-radius:50%; font-weight:800; cursor:pointer; color:#fff;
  border:3px dashed rgba(255,255,255,.55); font-size:.8rem;}
.cr-chip.c1{background:#7a7a7a;} .cr-chip.c5{background:#c0392b;} .cr-chip.c10{background:#2471a3;}
.cr-chip.c25{background:#1e8449;} .cr-chip.c100{background:#111;}
.cr-chip.sel{outline:3px solid var(--brass); outline-offset:2px;}
.cr-actions{margin-left:auto; display:flex; gap:6px;}
.cr-actions button{background:var(--panel2); border:1px solid var(--line2); color:var(--dim);
  border-radius:8px; padding:9px 12px; font-size:.74rem; font-weight:700; cursor:pointer;}
.cr-actions button:disabled{opacity:.35; cursor:default;}
.cr-actions button:not(:disabled):hover{color:var(--ink);}

/* zones + cells */
.cr-zone{margin-top:16px;}
.cr-zone h2{font-size:.64rem; text-transform:uppercase; letter-spacing:.16em; color:var(--brass); margin:0 0 8px;}
.cr-grid2{display:grid; grid-template-columns:1fr 1fr; gap:8px;}
.cr-grid4{display:grid; grid-template-columns:repeat(4,1fr); gap:8px;}
.cr-cell{position:relative; border:1px solid var(--line2); border-radius:11px; background:var(--panel);
  padding:11px 10px 12px; cursor:pointer; user-select:none; transition:all .12s; min-height:58px;}
.cr-cell:hover{border-color:var(--brass);}
.cr-cell.disabled{opacity:.4; cursor:default;}
.cr-cell.disabled:hover{border-color:var(--line2);}
.cr-cell.has{border-color:var(--brass); background:var(--panel2);}
.cr-cell.wide{text-align:center;}
.cr-cell-label{font-size:.78rem; font-weight:800; letter-spacing:.03em;}
.cr-cell-sub{font-size:.62rem; color:var(--faint); margin-top:3px;}
.cr-cell.pass .cr-cell-label{color:var(--green);}
.cr-cell.dont .cr-cell-label{color:var(--red);}
.cr-cell.odds .cr-cell-label{color:var(--blue);}
.cr-cell.field .cr-cell-label{color:var(--brass);}
.cr-chipamt{display:inline-flex; align-items:center; gap:6px; margin-top:7px; background:rgba(203,162,78,.16);
  border:1px solid var(--brass); color:var(--brass); border-radius:20px; padding:3px 9px;
  font-family:var(--mono); font-size:.74rem; font-weight:700;}
.cr-x{background:transparent; border:none; color:var(--faint); cursor:pointer; font-size:.7rem; padding:0;}
.cr-x:hover{color:var(--red);}

/* come numbers */
.cr-nums{display:grid; grid-template-columns:repeat(6,1fr); gap:6px; margin-top:8px;}
.cr-num{border:1px solid var(--line2); border-radius:10px; background:var(--panel); padding:7px 4px; text-align:center; min-height:64px;}
.cr-num.ispoint{border-color:var(--brass); box-shadow:0 0 0 1px var(--brass);}
.cr-num-title{font-family:var(--mono); font-weight:800; font-size:1.05rem;}
.cr-mini{display:block; width:100%; margin-top:5px; border-radius:7px; border:1px solid var(--line2);
  background:var(--panel2); font-size:.56rem; padding:4px 2px; cursor:pointer; color:var(--ink); line-height:1.35;}
.cr-mini em{display:block; font-style:normal; color:var(--faint); font-size:.5rem;}
.cr-mini.pass{border-color:var(--green);}
.cr-mini.dont{border-color:var(--red);}
.cr-pblcol{min-height:0; padding:7px 4px 8px;}
.cr-pbl{display:flex; flex-wrap:wrap; align-items:center; gap:2px 4px; width:100%; margin-top:4px;
  border:1px solid var(--line2); border-radius:7px; background:var(--panel2); color:var(--ink);
  font-size:.55rem; padding:4px 4px; cursor:pointer; line-height:1.3; justify-content:center;}
.cr-pbl .cr-pbl-k{font-weight:800; letter-spacing:.03em;}
.cr-pbl .cr-pbl-r{color:var(--faint);}
.cr-pbl.place{border-color:var(--line2);}
.cr-pbl.buy{border-color:#3a5f7a;}
.cr-pbl.buy .cr-pbl-k{color:var(--blue);}
.cr-pbl.lay{border-color:#6e3a3a;}
.cr-pbl.lay .cr-pbl-k{color:var(--red);}
.cr-pbl.has{border-color:var(--brass); background:rgba(203,162,78,.12);}
.cr-pbl-amt{display:inline-flex; gap:4px; align-items:center; width:100%; justify-content:center;
  font-family:var(--mono); font-weight:700; color:var(--brass); font-size:.6rem;}
.cr-pbl-amt .cr-x{font-style:normal;}
.cr-note{font-size:.64rem; color:var(--faint); margin-top:8px; line-height:1.5;}

/* lucky shooter */
.cr-lucky{border:1px dashed var(--brass); border-radius:12px; background:var(--panel); padding:12px; cursor:pointer;}
.cr-lucky.live{border-style:solid; box-shadow:0 0 0 1px var(--brass);}
.cr-lucky-top{display:flex; justify-content:space-between; gap:10px; align-items:center; font-size:.66rem; color:var(--dim);}
.cr-lucky-lights{display:flex; gap:8px; margin:10px 0 8px;}
.cr-lucky-lights .light{width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  border:1px solid var(--line2); background:var(--panel2); font-family:var(--mono); font-weight:700; color:var(--faint);}
.cr-lucky-lights .light.hit{background:rgba(203,162,78,.25); border-color:var(--brass); color:var(--brass);}
.cr-lucky-pays{font-size:.62rem; color:var(--faint);}
.cr-lucky-pays i{opacity:.75;}

/* settings */
.cr-settings{display:flex; flex-direction:column; gap:8px; border-top:1px solid var(--line); padding-top:14px;}
.cr-settings label{display:flex; gap:8px; align-items:center; font-size:.76rem; color:var(--dim); cursor:pointer;}

@media (max-width:430px){
  .cr-grid4{grid-template-columns:repeat(2,1fr);}
  .cr-nums{grid-template-columns:repeat(3,1fr);}
  .cr-dome-side{width:84px;}
}
`;
