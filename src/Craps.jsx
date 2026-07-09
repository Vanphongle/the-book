import { useState, useEffect, useRef, useMemo } from "react";

// ─── BUBBLE CRAPS ─────────────────────────────────────────────────────────────
// A faithful, machine-style simulation of electronic bubble craps (Interblock /
// Aruze layout): horizontal screen, felt table, dice dome strip on top.
//
//   LEFT panel  — HARD BETS / HOP BETS tabs, one-roll bets beneath
//   RIGHT panel — big number boxes (Don't Come bar + 4 5 6 8 9 10) with the
//                 ON/OFF puck riding on top and PLACE / BUY / LAY fields inside;
//                 below: C · C&E · E circles │ PRESS/ACROSS/INSIDE/OUTSIDE │
//                 COME, FIELD, DON'T PASS BAR, PASS LINE, BIG 6 & 8
//
// Payouts are machine-accurate: odds 3x-4x-5x true odds; place 9:5/7:5/7:6;
// buy true odds −5% vig on win; lay against −5% vig; field 2 double / 12 double
// (triple via settings); hardways 7:1 & 9:1; hops 15:1 easy, 30:1 pair;
// props 30:1 / 15:1 / 7:1 / 4:1; Big 6/8 even money; Lucky Shooter side bet.
// Play money only (localStorage) — fully separate from The Book's data.

const LS_BANK = "the-book.craps.bank.v1";
const START_BANK = 1000;
const POINTS = [4, 5, 6, 8, 9, 10];
const CHIPS = [1, 5, 10, 25, 100];

const ODDS_PAY = { 4: 2, 5: 1.5, 6: 1.2, 8: 1.2, 9: 1.5, 10: 2 };
const LAY_PAY = { 4: 0.5, 5: 2 / 3, 6: 5 / 6, 8: 5 / 6, 9: 2 / 3, 10: 0.5 };
const PLACE_PAY = { 4: 1.8, 5: 1.4, 6: 7 / 6, 8: 7 / 6, 9: 1.4, 10: 1.8 };
const ODDS_CAP = { 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3 }; // 3x-4x-5x
const HARD_PAY = { 4: 7, 6: 9, 8: 9, 10: 7 };
const LUCKY_PAY = { 3: 1, 4: 5, 5: 25, 6: 100 }; // varies by casino
const VIG = 0.05;

// All 21 hop combinations, pairs last in each group.
const HOPS = [];
for (let lo = 1; lo <= 6; lo++) for (let hi = lo; hi <= 6; hi++) HOPS.push(`${lo}-${hi}`);

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
const chipTxt = (n) => (n % 1 === 0 ? `$${n}` : money(n));
const cx = (...a) => a.filter(Boolean).join(" ");
const rollDie = () => 1 + Math.floor(Math.random() * 6);

const emptyNums = () => ({ 4: 0, 5: 0, 6: 0, 8: 0, 9: 0, 10: 0 });
const emptyHops = () => Object.fromEntries(HOPS.map((k) => [k, 0]));
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
  big6: 0,
  big8: 0,
  hard: { 4: 0, 6: 0, 8: 0, 10: 0 },
  hop: emptyHops(),
  any7: 0,
  anyCraps: 0,
  two: 0,
  three: 0,
  eleven: 0,
  twelve: 0,
  ce: 0,
  horn: 0,
});

const sumBets = (b, lucky) =>
  b.pass + b.passOdds + b.dontPass + b.dontPassOdds + b.comeFlat + b.dontComeFlat +
  b.field + b.big6 + b.big8 +
  b.any7 + b.anyCraps + b.two + b.three + b.eleven + b.twelve + b.ce + b.horn +
  POINTS.reduce(
    (s, n) => s + b.come[n] + b.comeOdds[n] + b.dontCome[n] + b.dontComeOdds[n] + b.place[n] + b.buy[n] + b.lay[n],
    0
  ) +
  [4, 6, 8, 10].reduce((s, n) => s + b.hard[n], 0) +
  Object.values(b.hop).reduce((s, v) => s + v, 0) +
  (lucky.active || lucky.bet ? lucky.bet : 0);

// Mini chip stack — real stacked casino chips for a bet amount.
const CHIP_COLOR = { 1: "#7a7a7a", 5: "#c0392b", 10: "#2471a3", 25: "#1e8449", 100: "#151515", 500: "#6c3483" };
function MiniStack({ amt }) {
  const den = [500, 100, 25, 10, 5, 1];
  const list = [];
  let rem = Math.round(amt);
  for (const d of den) while (rem >= d && list.length < 6) { list.push(d); rem -= d; }
  const shown = list.reverse();
  const size = 18, off = 2.5;
  return (
    <span className="cr-mstack" style={{ width: size, height: size + off * Math.max(0, shown.length - 1) }}>
      {shown.map((d, i) => (
        <i key={i} style={{ background: CHIP_COLOR[d], width: size, height: size, bottom: i * off, zIndex: i }} />
      ))}
    </span>
  );
}

// Die face pips (size: css-driven).
function Die({ v, rolling, mini }) {
  const P = {
    1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
  };
  return (
    <span className={cx("cr-die", mini && "mini", rolling && "rolling")}>
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} className={cx("pip", (P[v] || []).includes(i) && "on")} />
      ))}
    </span>
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
  const [history, setHistory] = useState([]);
  const [log, setLog] = useState(["Welcome — place your bets and hit ROLL."]);
  const [lastWin, setLastWin] = useState(0);
  const [chip, setChip] = useState(5);
  const [auto, setAuto] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [fx, setFx] = useState(null); // center-screen roll overlay: {phase:"tumble"|"result", net, headline}
  const [field12Triple, setField12Triple] = useState(false);
  const [tab, setTab] = useState("hard"); // "hard" | "hop"
  const [undoStack, setUndoStack] = useState([]);
  const [prevRound, setPrevRound] = useState([]);

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

  function getBet(b, path) {
    return (Array.isArray(path) ? b[path[0]][path[1]] : b[path]) ?? 0;
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

  function isLocked(path) {
    if (path === "pass") return !!point;
    if (Array.isArray(path) && path[0] === "come") return true;
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
    for (const p of [...undoStack]) place(p.path, { amount: p.amt });
  }

  // Quick set-bet buttons (machine shortcuts).
  function pressBets() {
    if (rolling) return;
    const B = betsRef.current;
    let did = false;
    for (const n of POINTS) {
      if (B.place[n] > 0) { place(["place", n], { amount: betsRef.current.place[n] }); did = true; }
    }
    if (!did) say("Press doubles your place bets — none up yet.");
  }
  function setAcross(nums) {
    if (rolling) return;
    let did = false;
    for (const n of nums) {
      if (n === point) continue; // skip the point, like the real buttons
      place(["place", n]);
      did = true;
    }
    if (!did) say("No numbers to set.");
  }

  // ── the roll ────────────────────────────────────────────────────────────────
  const rollTimer = useRef(null);
  const fxTimer = useRef(null);
  function roll() {
    if (rolling) return;
    setRolling(true);
    setCountdown(0);
    clearTimeout(fxTimer.current);
    setFx({ phase: "tumble" });
    const anim = setInterval(() => setDice([rollDie(), rollDie()]), 90);
    rollTimer.current = setTimeout(() => {
      clearInterval(anim);
      const d1 = rollDie(), d2 = rollDie();
      setDice([d1, d2]);
      const out = resolve(d1, d2);
      setFx({ phase: "result", ...out });
      fxTimer.current = setTimeout(() => setFx(null), 1650);
      setRolling(false);
    }, 1300);
  }
  useEffect(() => () => { clearTimeout(rollTimer.current); clearTimeout(fxTimer.current); }, []);

  useEffect(() => {
    if (!auto || rolling) return;
    if (countdown <= 0) { setCountdown(12); return; }
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
    let credit = 0;
    let winnings = 0;
    const events = [];
    const orig = betsRef.current;
    // wealth (credits + everything on the board) before the roll — for the net
    const beforeWealth = bankRef.current + sumBets(orig, luckyRef.current);
    let b = JSON.parse(JSON.stringify(orig));
    let L = { ...luckyRef.current, hits: [...luckyRef.current.hits] };
    let newPoint = point;
    let mark = null;

    const pay = (label, stakeBack, win) => {
      credit += stakeBack + win;
      winnings += win;
      if (win > 0) events.push(`${label} +${money(win)}`);
    };

    // one-roll props
    if (b.field) {
      const f = total === 2 ? 2 : total === 12 ? (field12Triple ? 3 : 2)
        : [3, 4, 9, 10, 11].includes(total) ? 1 : -1;
      if (f > 0) pay("Field", 0, b.field * f);
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

    // hop bets — one roll on the exact combination; pairs 30:1, easy 15:1
    {
      const hopKey = `${Math.min(d1, d2)}-${Math.max(d1, d2)}`;
      for (const k of HOPS) {
        const amt = b.hop[k];
        if (!amt) continue;
        if (k === hopKey) {
          const [lo, hi] = k.split("-");
          pay(`Hop ${lo}·${hi}`, amt, amt * (lo === hi ? 30 : 15));
        }
        b.hop[k] = 0;
      }
    }

    // hardways
    for (const n of [4, 6, 8, 10]) {
      if (!b.hard[n]) continue;
      if (total === 7) { b.hard[n] = 0; }
      else if (total === n) {
        if (isPair) pay(`Hard ${n}`, 0, b.hard[n] * HARD_PAY[n]);
        else b.hard[n] = 0;
      }
    }
    if (total === 7 && (orig.hard[4] || orig.hard[6] || orig.hard[8] || orig.hard[10]))
      events.push("Hardways down");

    // Big 6 / Big 8 — even money, always working
    if (total === 6 && b.big6) pay("Big 6", 0, b.big6);
    if (total === 8 && b.big8) pay("Big 8", 0, b.big8);
    if (total === 7) {
      if (b.big6 || b.big8) events.push("Big 6/8 down");
      b.big6 = 0; b.big8 = 0;
    }

    // come flats placed this round
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

    // come / don't come numbers
    if (total === 7) {
      for (const n of POINTS) {
        if (b.come[n]) {
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

    // place & buy (working only with the point ON)
    if (!comeOut) {
      if (total === 7) {
        if (POINTS.some((n) => b.place[n])) events.push("Place bets down");
        if (POINTS.some((n) => b.buy[n])) events.push("Buy bets down");
        for (const n of POINTS) { b.place[n] = 0; b.buy[n] = 0; }
      } else if (POINTS.includes(total)) {
        if (b.place[total]) pay(`Place ${total}`, 0, b.place[total] * PLACE_PAY[total]);
        // buy pays true odds minus a 5% vig on the BET (charged on the win)
        if (b.buy[total]) pay(`Buy ${total}`, 0, b.buy[total] * (ODDS_PAY[total] - VIG));
      }
    }

    // lay bets (always working)
    if (total === 7) {
      for (const n of POINTS) {
        if (!b.lay[n]) continue;
        pay(`Lay ${n}`, b.lay[n], b.lay[n] * LAY_PAY[n] * (1 - VIG));
        b.lay[n] = 0;
      }
    } else if (POINTS.includes(total) && b.lay[total]) {
      b.lay[total] = 0;
      events.push(`Lay ${total} loses`);
    }

    // pass / don't pass & the point
    if (comeOut) {
      mark = "co";
      if (total === 7 || total === 11) {
        if (b.pass) pay("Pass line", 0, b.pass);
        if (b.dontPass) { b.dontPass = 0; events.push("Don't Pass loses"); }
      } else if ([2, 3, 12].includes(total)) {
        if (b.pass) { b.pass = 0; events.push("Pass line loses — craps"); }
        if (b.dontPass) {
          if (total === 12) events.push("Don't Pass pushes (bar 12)");
          else pay("Don't Pass", 0, b.dontPass);
        }
      } else {
        newPoint = total;
        mark = "point";
        events.push(`Point is ${total}`);
        if (L.active && !L.hits.includes(total)) L.hits.push(total);
      }
      if (L.bet && !L.active) {
        if ([2, 3, 12].includes(total)) { L.bet = 0; events.push("Lucky Shooter loses"); }
        else if (total === 7 || total === 11) { credit += L.bet; L.bet = 0; events.push("Lucky Shooter pushes"); }
        else { L.active = true; L.hits = [total]; events.push("Lucky Shooter is live"); }
      }
    } else {
      if (total === point) {
        mark = "made";
        events.push(`Winner — ${total}, pass pays`);
        if (b.pass) pay("Pass line", 0, b.pass);
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
    // net for the roll = wealth change (credits + board), before any bust refill
    const net = bankRef.current + sumBets(b, L) - beforeWealth;
    // busted (can't cover the smallest chip, nothing left working): auto-refill
    if (bankRef.current < CHIPS[0] && sumBets(b, L) === 0) {
      commitBank(START_BANK);
      events.push("Busted — bankroll refilled to $1,000");
    }
    setLastWin(winnings);
    setHistory((h) => [{ d1, d2, total, mark }, ...h].slice(0, 16));
    say(events.length ? events : [`${total} — no action`]);
    setPrevRound(undoStack);
    setUndoStack([]);

    const headline =
      mark === "out" ? "SEVEN OUT" :
      mark === "made" ? `WINNER — ${total}` :
      mark === "point" ? `POINT IS ${total}` :
      comeOut && (total === 7 || total === 11) ? `${total} — NATURAL` :
      comeOut && [2, 3, 12].includes(total) ? `${total} — CRAPS` :
      `${total}`;
    return { net, headline };
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

  // ── little chip on the felt ─────────────────────────────────────────────────
  const Chip = ({ amt, path, locked }) =>
    amt > 0 ? (
      <span className="cr-fchip" onClick={(e) => e.stopPropagation()}>
        <MiniStack amt={amt} />
        <b className="mono">{chipTxt(amt)}</b>
        {!locked && path && (
          <i className="cr-fx" onClick={(e) => { e.stopPropagation(); removeBet(path); }}>✕</i>
        )}
      </span>
    ) : null;

  const total = dice[0] + dice[1];

  return (
    <div className="cr">
      <style>{CSS}</style>

      {/* top strip: dome + controls + meters */}
      <header className="cr-top">
        <a className="cr-back" href="#">←</a>
        <span className="cr-title">BUBBLE CRAPS</span>
        <span className="cr-topchips">
          {CHIPS.map((c) => (
            <button key={c} className={cx("cr-chip sm", `c${c}`, chip === c && "sel")} onClick={() => setChip(c)}>
              ${c}
            </button>
          ))}
        </span>
        <span className="cr-hist">
          {history.map((h, i) => (
            <em key={i} className={cx(h.mark)}>{h.total}</em>
          ))}
        </span>
        <span className="cr-meters">
          <span><b className="mono">{money(bank)}</b><i>credits</i></span>
          <span><b className="mono">{money(onBoard)}</b><i>on board</i></span>
          <span><b className={cx("mono", lastWin > 0 && "win")}>{lastWin > 0 ? "+" + money(lastWin) : "—"}</b><i>last win</i></span>
        </span>
        <button className="cr-reset" onClick={cashReset}>Reset</button>
      </header>
      <div className="cr-log">{log[0]}</div>

      {/* machine body */}
      <div className="cr-body">
        {/* LEFT: hard / hop tabs + one-roll bets */}
        <aside className="cr-left">
          <div className="cr-tabs">
            <button className={cx(tab === "hard" && "on")} onClick={() => setTab("hard")}>HARD BETS</button>
            <button className={cx(tab === "hop" && "on")} onClick={() => setTab("hop")}>HOP BETS</button>
          </div>

          {tab === "hard" ? (
            <div className="cr-hardgrid">
              {[
                [4, 2, 2], [6, 3, 3], [8, 4, 4], [10, 5, 5],
              ].map(([n, a, bb]) => (
                <button key={n} className={cx("cr-hard", bets.hard[n] > 0 && "has")} onClick={() => place(["hard", n])}>
                  <span className="cr-hard-dice"><Die v={a} mini /><Die v={bb} mini /></span>
                  <span className="cr-hard-lbl">HARD {n}</span>
                  <span className="cr-pays">{HARD_PAY[n]} to 1</span>
                  <Chip amt={bets.hard[n]} path={["hard", n]} />
                </button>
              ))}
            </div>
          ) : (
            <div className="cr-hopgrid">
              {HOPS.map((k) => {
                const [lo, hi] = k.split("-").map(Number);
                return (
                  <button key={k} className={cx("cr-hop", bets.hop[k] > 0 && "has")} onClick={() => place(["hop", k])}>
                    <span className="cr-hard-dice"><Die v={lo} mini /><Die v={hi} mini /></span>
                    <span className="cr-pays">{lo === hi ? "30:1" : "15:1"}</span>
                    <Chip amt={bets.hop[k]} path={["hop", k]} />
                  </button>
                );
              })}
            </div>
          )}

          <div className="cr-onetitle">ONE ROLL BETS</div>
          <div className="cr-onegrid">
            {[
              ["any7", "ANY SEVEN", "4 to 1", bets.any7],
              ["anyCraps", "ANY CRAPS", "7 to 1", bets.anyCraps],
              ["two", "ACES · 2", "30 to 1", bets.two],
              ["three", "ACE DEUCE · 3", "15 to 1", bets.three],
              ["twelve", "TWELVE · 12", "30 to 1", bets.twelve],
              ["horn", "HORN", "2/12 · 3/11", bets.horn],
            ].map(([path, lbl, pays, amt]) => (
              <button key={path} className={cx("cr-one", amt > 0 && "has")} onClick={() => place(path)}>
                <span className="cr-one-lbl">{lbl}</span>
                <span className="cr-pays">{pays}</span>
                <Chip amt={amt} path={path} />
              </button>
            ))}
          </div>

          <div className="cr-luckyrow" onClick={() => place("lucky")}>
            <span className="cr-lucky-lbl">LUCKY SHOOTER</span>
            <span className="cr-lucky-lights">
              {POINTS.map((n) => (
                <em key={n} className={cx(lucky.hits.includes(n) && "hit")}>{n}</em>
              ))}
            </span>
            <Chip amt={lucky.bet} path="lucky" locked={lucky.active} />
          </div>
        </aside>

        {/* RIGHT: the felt */}
        <main className="cr-felt">
          {/* number boxes row */}
          <div className="cr-numrow">
            <button
              className={cx("cr-box cr-dcbar", bets.dontComeFlat > 0 && "has")}
              onClick={() => place("dontComeFlat")}
              disabled={!point}
            >
              <span className="cr-pucks">{!point && <span className="cr-puck off">OFF</span>}</span>
              <span className="cr-dc-lbl">DON'T COME</span>
              <Chip amt={bets.dontComeFlat} path="dontComeFlat" />
              {!point && <span className="cr-band-hint">opens when the point is ON</span>}
            </button>

            {POINTS.map((n) => (
              <div key={n} className={cx("cr-box", point === n && "ispoint")}>
                <span className="cr-pucks">{point === n && <span className="cr-puck on">ON</span>}</span>
                <div className="cr-numarea" onClick={() => bets.come[n] > 0 && place(["comeOdds", n])}>
                  <b className="cr-bignum">{n}</b>
                  {bets.dontCome[n] > 0 && (
                    <span className="cr-behind" onClick={(e) => { e.stopPropagation(); place(["dontComeOdds", n]); }}>
                      DC {chipTxt(bets.dontCome[n])}{bets.dontComeOdds[n] > 0 && `+${chipTxt(bets.dontComeOdds[n])}`}
                    </span>
                  )}
                  {bets.come[n] > 0 && (
                    <span className="cr-comechips" title="tap to add come odds">
                      COME {chipTxt(bets.come[n])}{bets.comeOdds[n] > 0 && ` +${chipTxt(bets.comeOdds[n])}`}
                    </span>
                  )}
                  {bets.lay[n] > 0 && <span className="cr-laychip">LAY {chipTxt(bets.lay[n])}<i className="cr-fx" onClick={(e) => { e.stopPropagation(); removeBet(["lay", n]); }}>✕</i></span>}
                </div>
                <div className="cr-pb">
                  <button className={cx("cr-pbf", bets.place[n] > 0 && "has")} onClick={() => place(["place", n])}>
                    PLACE
                    <Chip amt={bets.place[n]} path={["place", n]} />
                  </button>
                  <button className={cx("cr-pbf buy", bets.buy[n] > 0 && "has")} onClick={() => place(["buy", n])}>
                    BUY
                    <Chip amt={bets.buy[n]} path={["buy", n]} />
                  </button>
                </div>
                <button className="cr-layzone" onClick={() => place(["lay", n])}>LAY</button>
              </div>
            ))}
          </div>

          {/* lower felt: C/C&E/E | set-bet stack | bands */}
          <div className="cr-lower">
            <div className="cr-ce">
              <button className={cx("cr-circ", bets.anyCraps > 0 && "has")} onClick={() => place("anyCraps")}>
                C<Chip amt={bets.anyCraps} path="anyCraps" />
              </button>
              <button className={cx("cr-circ mid", bets.ce > 0 && "has")} onClick={() => place("ce")}>
                C&E<Chip amt={bets.ce} path="ce" />
              </button>
              <button className={cx("cr-circ", bets.eleven > 0 && "has")} onClick={() => place("eleven")}>
                E<Chip amt={bets.eleven} path="eleven" />
              </button>
            </div>

            <div className="cr-sets">
              <button onClick={pressBets}>PRESS</button>
              <button onClick={() => setAcross(POINTS)}>ACROSS</button>
              <button onClick={() => setAcross([5, 6, 8, 9])}>INSIDE</button>
              <button onClick={() => setAcross([4, 5, 9, 10])}>OUTSIDE</button>
            </div>

            <div className="cr-bands">
              <button
                className={cx("cr-band come", bets.comeFlat > 0 && "has")}
                onClick={() => place("comeFlat")}
                disabled={!point}
              >
                COME
                <Chip amt={bets.comeFlat} path="comeFlat" />
                {!point && <span className="cr-band-hint">opens when the point is ON</span>}
              </button>

              <button className={cx("cr-band field", bets.field > 0 && "has")} onClick={() => place("field")}>
                <span className="cr-field-lbl">FIELD</span>
                <span className="cr-field-nums">
                  <em className="circ">2</em>3 · 4 · 9 · 10 · 11<em className="circ">12</em>
                </span>
                <span className="cr-field-sub">2 pays double · 12 pays {field12Triple ? "triple" : "double"}</span>
                <Chip amt={bets.field} path="field" />
              </button>

              <button
                className={cx("cr-band dp", (bets.dontPass > 0 || bets.dontPassOdds > 0) && "has")}
                onClick={() => (point && bets.dontPass ? place("dontPassOdds") : place("dontPass"))}
                disabled={!!point && !bets.dontPass}
              >
                DON'T PASS BAR <Die v={6} mini /><Die v={6} mini />
                <Chip amt={bets.dontPass} path="dontPass" />
                {bets.dontPassOdds > 0 && <span className="cr-oddschip">ODDS {chipTxt(bets.dontPassOdds)}<i className="cr-fx" onClick={(e) => { e.stopPropagation(); removeBet("dontPassOdds"); }}>✕</i></span>}
                {point && bets.dontPass > 0 && <span className="cr-hintz">tap = lay odds</span>}
              </button>

              <button
                className={cx("cr-band pass", (bets.pass > 0 || bets.passOdds > 0) && "has")}
                onClick={() => (point && bets.pass ? place("passOdds") : place("pass"))}
                disabled={!!point && !bets.pass}
              >
                PASS LINE
                <Chip amt={bets.pass} path="pass" locked={!!point} />
                {bets.passOdds > 0 && <span className="cr-oddschip">ODDS {chipTxt(bets.passOdds)}<i className="cr-fx" onClick={(e) => { e.stopPropagation(); removeBet("passOdds"); }}>✕</i></span>}
                {point && bets.pass > 0 && <span className="cr-hintz">tap = odds {ODDS_CAP[point]}x</span>}
              </button>

              <div className="cr-bigrow">
                <button className={cx("cr-band big", bets.big6 > 0 && "has")} onClick={() => place("big6")}>
                  BIG <b>6</b>
                  <Chip amt={bets.big6} path="big6" />
                </button>
                <button className={cx("cr-band big", bets.big8 > 0 && "has")} onClick={() => place("big8")}>
                  BIG <b>8</b>
                  <Chip amt={bets.big8} path="big8" />
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* center-screen roll: tumbling dice, then the result pops */}
      {fx && (
        <div className={cx("cr-fx", fx.phase)}>
          <div className="cr-fx-dice">
            <Die v={dice[0]} rolling={fx.phase === "tumble"} />
            <Die v={dice[1]} rolling={fx.phase === "tumble"} />
          </div>
          {fx.phase === "result" && (
            <>
              <div className="cr-fx-head">{fx.headline}</div>
              {fx.net > 0.005 && <div className="cr-fx-net win">+{money(fx.net)}</div>}
              {fx.net < -0.005 && <div className="cr-fx-net lose">−{money(-fx.net)}</div>}
            </>
          )}
        </div>
      )}

      {/* floating ROLL for portrait phones (thumb zone) */}
      <button className="cr-rollfab" disabled={rolling} onClick={roll}>
        {rolling ? "…" : auto && countdown > 0 ? `${countdown}s` : "ROLL"}
      </button>

      {/* bottom rack */}
      <footer className="cr-rack">
        <label className="cr-auto">
          <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setCountdown(12); }} />
          auto-roll{auto && !rolling && <b className={cx(countdown <= 4 && "hot")}> {countdown}s</b>}
        </label>
        <span className="cr-actions">
          <button onClick={undoLast} disabled={!undoStack.length}>UNDO</button>
          <button onClick={repeatLast} disabled={!prevRound.length}>REPEAT</button>
          <button onClick={doubleBets} disabled={!undoStack.length}>DOUBLE</button>
        </span>
        <label className="cr-f12">
          <input type="checkbox" checked={field12Triple} onChange={(e) => setField12Triple(e.target.checked)} />
          field 12 ×3
        </label>
      </footer>
    </div>
  );
}

const CSS = `
.cr{
  --felt:#0d6b3a; --felt2:#0a5530; --feltdark:#07421f;
  --linec:#f3ead2; --yellow:#f7d774; --red:#e8574d; --redish:#c0392b;
  --ink:#f3ead2; --dim:#cfe3cf; --shadow:rgba(0,0,0,.45);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  font-family:var(--sans); color:var(--ink); min-height:100vh; min-height:100dvh;
  background:radial-gradient(ellipse at 50% 0%, #11291a, #0a1810 70%);
  -webkit-font-smoothing:antialiased; user-select:none;
}
.cr *{box-sizing:border-box;}
.cr .mono{font-family:var(--mono); font-variant-numeric:tabular-nums;}
.cr button{font-family:var(--sans);}

/* center-screen roll overlay */
.cr-fx{position:fixed; inset:0; z-index:80; display:flex; flex-direction:column; align-items:center;
  justify-content:center; gap:14px; background:rgba(4,12,7,.74); pointer-events:none;
  animation:cr-fxin .18s ease;}
.cr-fx.result{animation:cr-fxin .18s ease, cr-fxout .35s ease 1.25s forwards;}
@keyframes cr-fxin{from{opacity:0;} to{opacity:1;}}
@keyframes cr-fxout{to{opacity:0;}}
.cr-fx-dice{display:flex; gap:22px;}
.cr-fx .cr-die{width:88px; height:88px; border-radius:16px; padding:11px; gap:3px;
  box-shadow:0 14px 34px rgba(0,0,0,.6);}
.cr-fx .cr-die.rolling{animation:cr-fxtumble .3s infinite alternate;}
@keyframes cr-fxtumble{from{transform:translateY(-16px) rotate(-14deg);} to{transform:translateY(12px) rotate(12deg);}}
.cr-fx.result .cr-die{animation:cr-fxland .4s cubic-bezier(.2,1.5,.4,1);}
@keyframes cr-fxland{from{transform:scale(1.35); } to{transform:scale(1);}}
.cr-fx-head{font-size:1.15rem; font-weight:900; letter-spacing:.26em; color:var(--linec);
  text-shadow:0 2px 8px rgba(0,0,0,.6); animation:cr-fxpop .45s cubic-bezier(.2,1.6,.4,1);}
.cr-fx-net{font-family:var(--mono); font-size:2rem; font-weight:800;
  animation:cr-fxpop .5s cubic-bezier(.2,1.6,.4,1);}
.cr-fx-net.win{color:var(--yellow); text-shadow:0 0 24px rgba(247,215,116,.65), 0 2px 4px rgba(0,0,0,.5);}
.cr-fx-net.lose{color:var(--red); text-shadow:0 0 18px rgba(232,87,77,.5), 0 2px 4px rgba(0,0,0,.5);
  animation:cr-fxpop .5s cubic-bezier(.2,1.6,.4,1), cr-fxshake .4s ease .45s;}
@keyframes cr-fxpop{from{transform:scale(.3); opacity:0;} 70%{transform:scale(1.15);} to{transform:scale(1); opacity:1;}}
@keyframes cr-fxshake{0%,100%{transform:translateX(0);} 25%{transform:translateX(-7px);} 50%{transform:translateX(6px);} 75%{transform:translateX(-4px);}}
.cr-dome{cursor:pointer;}

.cr-topchips{display:flex; gap:6px; align-items:center; flex-shrink:0;}
.cr-chip.sm{width:36px; height:36px; font-size:.62rem; border-width:2.5px;}

.cr-rollfab{display:flex; position:fixed; right:16px; bottom:calc(18px + env(safe-area-inset-bottom));
  z-index:70; width:78px; height:78px; border-radius:50%; border:3px solid var(--yellow);
  background:radial-gradient(circle at 35% 30%, #d4a940, #8a6c1e); color:#fff; font-weight:900;
  letter-spacing:.06em; font-size:.86rem; cursor:pointer; align-items:center; justify-content:center;
  box-shadow:0 6px 18px rgba(0,0,0,.55), inset 0 -4px 0 rgba(0,0,0,.25);}
.cr-rollfab:disabled{opacity:.6;}
.cr-rollfab:active{transform:translateY(2px);}

/* ── top strip ── */
.cr-top{display:flex; align-items:center; gap:12px; padding:8px 12px; flex-wrap:nowrap;
  background:#0c1f14; border-bottom:2px solid #1c3a26; overflow-x:auto;}
.cr-back{color:var(--dim); text-decoration:none; font-size:1rem; flex-shrink:0;}
.cr-title{font-size:.72rem; letter-spacing:.2em; color:var(--yellow); font-weight:800; flex-shrink:0;}
.cr-dome{display:flex; align-items:center; gap:6px; background:radial-gradient(circle at 50% 30%, #1d3527, #0d1d13);
  border:1px solid #2c4a35; border-radius:20px; padding:5px 12px; flex-shrink:0;}
.cr-tot{font-family:var(--mono); color:var(--yellow); font-size:1.05rem; min-width:20px; text-align:center;}
.cr-tot.dim{opacity:.4;}
.cr-die{width:26px; height:26px; background:#f5f0e6; border-radius:5px; display:grid;
  grid-template-columns:repeat(3,1fr); padding:3px; gap:1px; box-shadow:0 2px 5px var(--shadow); flex-shrink:0;}
.cr-die.mini{width:15px; height:15px; border-radius:3px; padding:2px;}
.cr-die.rolling{animation:cr-b .3s infinite alternate;}
@keyframes cr-b{from{transform:translateY(-2px) rotate(-6deg);}to{transform:translateY(2px) rotate(6deg);}}
.cr-die .pip{border-radius:50%;}
.cr-die .pip.on{background:#191613;}
.cr-roll{padding:9px 20px; border-radius:10px; border:2px solid var(--yellow); flex-shrink:0;
  background:linear-gradient(#8a6c1e,#5e4a12); color:#fff; font-weight:800; letter-spacing:.1em; cursor:pointer; font-size:.85rem;}
.cr-roll:disabled{opacity:.55; cursor:wait;}
.cr-auto{display:flex; align-items:center; gap:4px; font-size:.68rem; color:var(--dim); flex-shrink:0; cursor:pointer;}
.cr-auto b{font-family:var(--mono); color:#7de89b;}
.cr-auto b.hot{color:var(--red); animation:cr-bl .5s infinite alternate;}
@keyframes cr-bl{from{opacity:1;}to{opacity:.35;}}
.cr-hist{display:flex; gap:4px; overflow:hidden; flex:1; min-width:60px;}
.cr-hist em{font-style:normal; font-family:var(--mono); font-size:.72rem; font-weight:700;
  background:#12271a; border:1px solid #24422f; border-radius:5px; padding:2px 6px; color:var(--dim); flex-shrink:0;}
.cr-hist em.out{color:var(--red); border-color:var(--red);}
.cr-hist em.made{color:#7de89b; border-color:#7de89b;}
.cr-hist em.point{color:var(--yellow); border-color:var(--yellow);}
.cr-meters{display:flex; gap:14px; flex-shrink:0;}
.cr-meters > span{display:flex; flex-direction:column; align-items:flex-end;}
.cr-meters b{font-size:.85rem;}
.cr-meters b.win{color:#7de89b;}
.cr-meters i{font-style:normal; font-size:.54rem; text-transform:uppercase; letter-spacing:.1em; color:#7fa38a;}
.cr-reset{background:transparent; border:1px solid #3a5a44; color:#7fa38a; border-radius:8px;
  padding:6px 10px; font-size:.68rem; cursor:pointer; flex-shrink:0;}
.cr-log{padding:4px 14px; font-size:.72rem; color:#a8c8ae; background:#0a1a10; min-height:24px;}

/* ── body: two panels ── */
.cr-body{display:grid; grid-template-columns:250px 1fr; gap:10px; padding:10px; min-width:820px;}
@media (max-width:840px){ .cr{overflow-x:auto;} }

/* left panel */
.cr-left{background:linear-gradient(#0e5c33,#0a4a28); border:2px solid var(--linec); border-radius:12px; padding:8px;}
.cr-tabs{display:flex; gap:6px; margin-bottom:8px;}
.cr-tabs button{flex:1; padding:8px 4px; border-radius:8px; border:1.5px solid var(--linec);
  background:transparent; color:var(--linec); font-weight:800; font-size:.62rem; letter-spacing:.06em; cursor:pointer;}
.cr-tabs button.on{background:var(--yellow); color:#241c05; border-color:var(--yellow);}
.cr-hardgrid{display:grid; grid-template-columns:1fr 1fr; gap:6px;}
.cr-hard{position:relative; display:flex; flex-direction:column; align-items:center; gap:2px; padding:7px 4px;
  border:1.5px solid var(--linec); border-radius:9px; background:rgba(0,0,0,.14); color:var(--ink); cursor:pointer;}
.cr-hard.has, .cr-hop.has, .cr-one.has{background:rgba(247,215,116,.18); border-color:var(--yellow);}
.cr-hard-dice{display:flex; gap:3px;}
.cr-hard-lbl{font-weight:800; font-size:.6rem; letter-spacing:.05em;}
.cr-pays{font-size:.54rem; color:var(--yellow);}
.cr-hopgrid{display:grid; grid-template-columns:repeat(4,1fr); gap:4px;}
.cr-hop{position:relative; display:flex; flex-direction:column; align-items:center; gap:1px; padding:5px 2px;
  border:1px solid var(--linec); border-radius:7px; background:rgba(0,0,0,.14); color:var(--ink); cursor:pointer;}
.cr-onetitle{margin:10px 0 6px; text-align:center; font-size:.6rem; letter-spacing:.18em; color:var(--yellow); font-weight:800;}
.cr-onegrid{display:grid; grid-template-columns:1fr 1fr; gap:6px;}
.cr-one{position:relative; display:flex; flex-direction:column; align-items:center; gap:2px; padding:7px 3px;
  border:1.5px solid var(--linec); border-radius:9px; background:rgba(0,0,0,.14); color:var(--ink); cursor:pointer;}
.cr-one-lbl{font-weight:800; font-size:.56rem; letter-spacing:.04em; text-align:center;}
.cr-luckyrow{display:flex; align-items:center; gap:7px; margin-top:10px; padding:7px 8px;
  border:1.5px dashed var(--yellow); border-radius:9px; cursor:pointer;}
.cr-lucky-lbl{font-size:.52rem; font-weight:800; color:var(--yellow); letter-spacing:.05em;}
.cr-lucky-lights{display:flex; gap:3px;}
.cr-lucky-lights em{font-style:normal; width:17px; height:17px; border-radius:50%; display:flex; align-items:center;
  justify-content:center; font-size:.52rem; font-family:var(--mono); background:rgba(0,0,0,.25); color:#88a890; border:1px solid #35573f;}
.cr-lucky-lights em.hit{background:var(--yellow); color:#241c05; border-color:var(--yellow); font-weight:800;}

/* right felt */
.cr-felt{background:linear-gradient(#0e6b3a,#0a5530 60%,#084525); border:2px solid var(--linec);
  border-radius:12px; padding:10px; display:flex; flex-direction:column; gap:10px;}

/* number boxes */
.cr-numrow{display:grid; grid-template-columns:1.1fr repeat(6,1fr); gap:7px; margin-top:14px;}
.cr-box{position:relative; border:2px solid var(--linec); border-radius:8px; background:rgba(255,255,255,.03);
  display:flex; flex-direction:column; min-height:104px; color:var(--ink);}
.cr-box.ispoint{box-shadow:0 0 0 3px var(--yellow); border-color:var(--yellow);}
/* puck floats on the box's top edge — no reserved gap inside */
.cr-pucks{position:absolute; top:-12px; left:0; right:0; display:flex; justify-content:center; z-index:6; pointer-events:none;}
.cr-puck{width:34px; height:22px; border-radius:11px; display:flex; align-items:center; justify-content:center;
  font-size:.58rem; font-weight:900; letter-spacing:.08em;}
.cr-puck.on{background:#f5f0e6; color:#111;}
.cr-puck.off{background:#111; color:#eee; border:1px solid #444;}
.cr-numarea{flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; cursor:pointer; position:relative;}
.cr-bignum{font-size:1.7rem; font-weight:800; font-family:Georgia,'Times New Roman',serif; line-height:1; text-shadow:0 2px 4px var(--shadow);}
.cr-behind{font-size:.5rem; background:rgba(232,87,77,.25); border:1px solid var(--red); color:#ffd9d6;
  border-radius:6px; padding:2px 5px; cursor:pointer;}
.cr-comechips{font-size:.52rem; background:rgba(247,215,116,.2); border:1px solid var(--yellow); color:var(--yellow);
  border-radius:6px; padding:2px 5px;}
.cr-laychip{font-size:.5rem; background:rgba(0,0,0,.3); border:1px solid var(--red); color:#ffd9d6; border-radius:6px; padding:2px 5px;}
.cr-pb{display:grid; grid-template-columns:1fr 1fr; border-top:1.5px solid var(--linec);}
.cr-pbf{position:relative; padding:6px 2px 7px; background:transparent; border:none; color:var(--linec);
  font-size:.54rem; font-weight:800; letter-spacing:.05em; cursor:pointer; min-height:34px;
  display:flex; flex-direction:column; align-items:center; gap:2px;}
.cr-pbf + .cr-pbf{border-left:1.5px solid var(--linec);}
.cr-pbf.buy{color:#bfe0ff;}
.cr-pbf.has{background:rgba(247,215,116,.15);}
.cr-layzone{border:none; border-top:1.5px solid var(--linec); background:rgba(0,0,0,.18); color:#e8b7b2;
  font-size:.5rem; font-weight:800; letter-spacing:.14em; padding:3px; cursor:pointer;}
.cr-dcbar{background:rgba(0,0,0,.22); cursor:pointer; align-items:center; justify-content:center; gap:5px;
  padding:4px; min-height:0;}
.cr-dcbar:disabled{opacity:.75; cursor:default; border-style:dashed;}
.cr-dc-lbl{font-size:.5rem; font-weight:800; letter-spacing:.1em; text-align:center; color:var(--dim);}
.cr-dcbar.has{background:rgba(247,215,116,.14);}
.cr-band-hint{font-size:.5rem; letter-spacing:.05em; color:var(--dim); font-weight:600; text-transform:none;}

/* lower felt */
.cr-lower{display:grid; grid-template-columns:56px 92px 1fr; gap:8px;}
.cr-ce{display:flex; flex-direction:column; gap:6px; align-items:center; justify-content:center;}
.cr-circ{position:relative; width:48px; height:48px; border-radius:50%; border:2px solid var(--linec);
  background:rgba(0,0,0,.16); color:var(--ink); font-weight:900; font-size:.8rem; cursor:pointer;
  display:flex; flex-direction:column; align-items:center; justify-content:center;}
.cr-circ.mid{border-color:var(--red); color:#ffd9d6; font-size:.62rem;}
.cr-circ.has{background:rgba(247,215,116,.2); border-color:var(--yellow);}
.cr-sets{display:flex; flex-direction:column; gap:6px;}
.cr-sets button{flex:1; border:1.5px solid var(--linec); border-radius:8px; background:rgba(0,0,0,.16);
  color:var(--ink); font-weight:800; font-size:.6rem; letter-spacing:.08em; cursor:pointer; padding:8px 2px;}
.cr-sets button:active{background:rgba(247,215,116,.2);}
.cr-bands{display:flex; flex-direction:column; gap:7px;}
.cr-band{position:relative; display:flex; align-items:center; justify-content:center; gap:10px;
  border:2px solid var(--linec); border-radius:8px; background:rgba(255,255,255,.03); color:var(--ink);
  font-weight:900; letter-spacing:.2em; cursor:pointer; padding:10px 8px; font-size:.95rem;}
.cr-band.has{background:rgba(247,215,116,.12); border-color:var(--yellow);}
.cr-band:disabled{opacity:.8; cursor:default; border-style:dashed;}
.cr-band:disabled .cr-band-hint{color:var(--yellow);}
.cr-band.come{font-size:1.25rem; padding:13px;}
.cr-band.field{flex-direction:column; gap:2px; letter-spacing:.1em; background:rgba(0,0,0,.14);}
.cr-field-lbl{font-size:1rem;}
.cr-field-nums{display:flex; align-items:center; gap:7px; font-size:.86rem; letter-spacing:.04em;}
.cr-field-nums .circ{font-style:normal; width:24px; height:24px; border-radius:50%; border:1.5px solid var(--yellow);
  color:var(--yellow); display:flex; align-items:center; justify-content:center; font-size:.74rem;}
.cr-field-sub{font-size:.52rem; letter-spacing:.08em; color:var(--dim); font-weight:600;}
.cr-band.dp{background:rgba(0,0,0,.2); font-size:.72rem; letter-spacing:.14em; gap:6px;}
.cr-band.pass{font-size:1.15rem; padding:13px; border-width:3px;}
.cr-bigrow{display:grid; grid-template-columns:1fr 1fr; gap:7px;}
.cr-band.big{font-size:.78rem; letter-spacing:.1em; padding:8px;}
.cr-band.big b{font-size:1.15rem; font-family:Georgia,serif;}
.cr-oddschip{font-size:.56rem; background:rgba(191,224,255,.15); border:1px solid #bfe0ff; color:#bfe0ff;
  border-radius:6px; padding:2px 6px; letter-spacing:.02em; display:inline-flex; gap:4px; align-items:center;}
.cr-hintz{position:absolute; right:8px; bottom:3px; font-size:.5rem; letter-spacing:.04em; color:var(--dim); font-weight:600;}

/* felt chips — mini stacks of real chips + amount */
.cr-fchip{display:inline-flex; align-items:flex-end; gap:4px; cursor:default;}
.cr-fchip b{font-size:.6rem; font-weight:800; color:var(--yellow); text-shadow:0 1px 2px rgba(0,0,0,.6);}
.cr-mstack{position:relative; display:inline-block; flex-shrink:0;}
.cr-mstack i{position:absolute; left:0; border-radius:50%; border:1.5px dashed rgba(255,255,255,.65);
  box-shadow:0 1px 2px rgba(0,0,0,.5); box-sizing:border-box;}
.cr-fx{font-style:normal; cursor:pointer; color:#cfe3cf; font-size:.6rem; background:rgba(0,0,0,.4);
  border-radius:50%; width:15px; height:15px; display:inline-flex; align-items:center; justify-content:center;}
.cr-fx:hover{color:var(--red);}

/* bottom rack */
.cr-rack{display:flex; align-items:center; gap:12px; padding:10px 110px 16px 14px; flex-wrap:wrap;}
.cr-chip{width:44px; height:44px; border-radius:50%; font-weight:800; cursor:pointer; color:#fff;
  border:3px dashed rgba(255,255,255,.6); font-size:.76rem; flex-shrink:0;}
.cr-chip.c1{background:#7a7a7a;} .cr-chip.c5{background:#c0392b;} .cr-chip.c10{background:#2471a3;}
.cr-chip.c25{background:#1e8449;} .cr-chip.c100{background:#111;}
.cr-chip.sel{outline:3px solid var(--yellow); outline-offset:2px;}
.cr-actions{display:flex; gap:6px;}
.cr-actions button{background:#122a1b; border:1.5px solid #2c4a35; color:var(--dim); border-radius:8px;
  padding:10px 13px; font-size:.66rem; font-weight:800; letter-spacing:.06em; cursor:pointer;}
.cr-actions button:disabled{opacity:.35; cursor:default;}
.cr-f12{margin-left:auto; display:flex; gap:6px; align-items:center; font-size:.68rem; color:#7fa38a; cursor:pointer;}

/* ── PORTRAIT PHONES: single-column reflow (desktop keeps the wide machine) ── */
@media (max-width:760px){
  .cr{overflow-x:hidden;}
  .cr-body{display:flex; flex-direction:column; min-width:0; gap:12px;}
  .cr-felt{order:1;}
  .cr-left{order:2;}

  /* top strip wraps; history gets its own scrollable line */
  .cr-top{flex-wrap:wrap; overflow:visible; justify-content:center; row-gap:8px;}
  .cr-hist{flex-basis:100%; order:10; overflow-x:auto; justify-content:flex-start; min-width:0;}
  .cr-meters{gap:12px;}

  /* numbers: 3 × 2 grid, Don't Come bar spans the full row above them */
  .cr-numrow{grid-template-columns:repeat(3,1fr); gap:8px;}
  /* Don't Come: a tiny one-line strip — rarely used, shouldn't dominate */
  .cr-dcbar{grid-column:1/-1; flex-direction:row; min-height:28px; justify-content:center; align-items:center;
    padding:3px 6px; gap:8px;}
  .cr-dcbar .cr-band-hint{font-size:.44rem;}
  .cr-dcbar .cr-pucks{position:static; transform:none;}
  .cr-box{min-height:104px;}
  .cr-bignum{font-size:1.8rem;}

  /* lower felt: bands full-width, then quick-set row, then C/C&E/E row */
  .cr-lower{display:flex; flex-direction:column; gap:10px;}
  .cr-bands{order:1;}
  .cr-sets{order:2; flex-direction:row; gap:7px;}
  .cr-sets button{flex:1; padding:13px 2px;}
  .cr-ce{order:3; flex-direction:row; gap:14px;}
  .cr-circ{width:56px; height:56px;}

  /* left panel content sizes for a full-width column */
  .cr-hardgrid{grid-template-columns:repeat(4,1fr);}
  .cr-onegrid{grid-template-columns:repeat(3,1fr);}
  .cr-hopgrid{grid-template-columns:repeat(5,1fr);}

  /* clearance so the floating ROLL never covers the rack */
  .cr-rack{padding-bottom:100px; padding-right:100px;}
}
`;
