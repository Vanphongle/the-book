import { useState, useEffect, useRef } from "react";

// ─── TEXAS HOLD'EM (No-Limit, 6-max cash) ─────────────────────────────────────
// You + 5 bots, phone-first, play money only (localStorage) — nothing here
// touches The Book's Supabase data.
//   • Full NL betting engine: blinds, button rotation, min-raise, all-in + side pots
//   • 7-card evaluator for showdown
//   • Bots think with Monte-Carlo equity (deal out the unknowns a few hundred
//     times, count wins) + pot odds. Three table levels:
//       🐟 Fish  — loose-passive calling station, no fold discipline
//       🎯 Reg   — tight-aggressive, position-aware, uses pot odds
//       🦈 Shark — equity every street, semi-bluffs draws, balanced bluffs
//   • $50/$100 blinds, everyone sits $10,000 (100bb); bust auto-refills to $10k

const LS_BANK = "the-book.poker.bank.v1";
const LS_LEVEL = "the-book.poker.level.v1";
const START_STACK = 10000;
const SB = 50, BB = 100;
const SEATS = 6;
const BOT_NAMES = ["Bảo", "Long", "Hùng", "Trang", "Khoa"];

const SUIT_TXT = ["♠", "♥", "♦", "♣"];
const isRed = (s) => s === 1 || s === 2;
const rankTxt = (r) => (r <= 9 ? String(r) : { 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" }[r]);
const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const roundTo = (x, step) => Math.max(step, Math.round(x / step) * step);

// ── deck ──────────────────────────────────────────────────────────────────────
function freshDeck() {
  const d = [];
  for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ── 5-card ranker → packed comparable integer (higher = better) ────────────────
const CAT_UNIT = 15 ** 5; // 759375
const CAT_NAME = ["High Card", "Pair", "Two Pair", "Trips", "Straight", "Flush", "Full House", "Quads", "Straight Flush"];
function rank5(cs) {
  const ranks = [cs[0].r, cs[1].r, cs[2].r, cs[3].r, cs[4].r].sort((a, b) => b - a);
  const s0 = cs[0].s;
  const flush = cs[1].s === s0 && cs[2].s === s0 && cs[3].s === s0 && cs[4].s === s0;
  const uniq = [...new Set(ranks)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // wheel A-2-3-4-5
  }
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const groups = Object.keys(cnt)
    .map((r) => [cnt[r], +r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const pat = groups.map((g) => g[0]).join("");
  const kick = groups.map((g) => g[1]);
  let cat, ord;
  if (straightHigh && flush) { cat = 8; ord = [straightHigh]; }
  else if (pat === "41") { cat = 7; ord = [kick[0], kick[1]]; }
  else if (pat === "32") { cat = 6; ord = [kick[0], kick[1]]; }
  else if (flush) { cat = 5; ord = ranks; }
  else if (straightHigh) { cat = 4; ord = [straightHigh]; }
  else if (pat === "311") { cat = 3; ord = [kick[0], kick[1], kick[2]]; }
  else if (pat === "221") { cat = 2; ord = [kick[0], kick[1], kick[2]]; }
  else if (pat === "2111") { cat = 1; ord = [kick[0], kick[1], kick[2], kick[3]]; }
  else { cat = 0; ord = ranks; }
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 15 + (ord[i] || 0);
  return v;
}
// all C(7,5)=21 index combos
const C21 = (() => {
  const out = [];
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) for (let c = b + 1; c < 7; c++)
    for (let d = c + 1; d < 7; d++) for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
  return out;
})();
function best7(seven) {
  let best = 0;
  for (const idx of C21) {
    const v = rank5([seven[idx[0]], seven[idx[1]], seven[idx[2]], seven[idx[3]], seven[idx[4]]]);
    if (v > best) best = v;
  }
  return best;
}
const catOf = (v) => Math.floor(v / CAT_UNIT);

// ── Monte-Carlo equity: hero vs nOpp random hands, completing the board ────────
function equity(hole, board, nOpp, iters) {
  if (nOpp <= 0) return 1;
  const used = new Set([...hole, ...board].map((c) => c.r * 4 + c.s));
  const pool = [];
  for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) if (!used.has(r * 4 + s)) pool.push({ r, s });
  const need = 5 - board.length;
  let score = 0;
  for (let it = 0; it < iters; it++) {
    // partial Fisher-Yates on a copy for the cards we need this iter
    const deck = pool;
    const take = need + nOpp * 2;
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(rnd() * (deck.length - i));
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    const fullBoard = board.concat(deck.slice(0, need));
    const heroV = best7([hole[0], hole[1], ...fullBoard]);
    let ties = 0, beaten = false;
    for (let o = 0; o < nOpp; o++) {
      const oh = [deck[need + o * 2], deck[need + o * 2 + 1]];
      const ov = best7([oh[0], oh[1], ...fullBoard]);
      if (ov > heroV) { beaten = true; break; }
      if (ov === heroV) ties++;
    }
    if (!beaten) score += ties ? 1 / (ties + 1) : 1;
  }
  return score / iters;
}

// ── preflop hand score (fast, avoids a slow multiway MC every preflop) ─────────
function preflopScore(hole) {
  const hi = Math.max(hole[0].r, hole[1].r), lo = Math.min(hole[0].r, hole[1].r);
  const pair = hole[0].r === hole[1].r, suited = hole[0].s === hole[1].s, gap = hi - lo - 1;
  let s;
  if (pair) { s = 5 + (hi - 2) * 0.9; if (hi >= 10) s += 1; }
  else {
    s = (hi - 2) * 0.5 + (lo - 2) * 0.25;
    if (suited) s += 2;
    if (gap === 0) s += 2; else if (gap === 1) s += 1; else if (gap >= 3) s -= 1;
    if (hi === 14) s += 1;
    if (hi >= 13 && lo >= 10) s += 1;
  }
  return s;
}

// ── side-pot builder from each player's total contribution ─────────────────────
function buildPots(players) {
  const contribs = players.map((p) => ({ p, amt: p.totalCommitted })).filter((c) => c.amt > 0);
  const pots = [];
  while (contribs.some((c) => c.amt > 0)) {
    const min = Math.min(...contribs.filter((c) => c.amt > 0).map((c) => c.amt));
    // everyone still owing chips at this layer contributes `min`; not-yet-folded
    // contributors to this layer are eligible to win it
    const layer = contribs.filter((c) => c.amt > 0);
    const amount = min * layer.length;
    const eligible = layer.filter((c) => !c.p.folded).map((c) => c.p);
    for (const c of layer) c.amt -= min;
    pots.push({ amount, eligible: eligible.length ? eligible : layer.map((c) => c.p) });
  }
  // merge consecutive pots with identical eligibility for cleaner display
  const merged = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    const same = last && last.eligible.length === pot.eligible.length && last.eligible.every((p) => pot.eligible.includes(p));
    if (same) last.amount += pot.amount;
    else merged.push({ ...pot });
  }
  return merged;
}

// ── AI table levels ────────────────────────────────────────────────────────────
const LEVELS = {
  fish: { key: "fish", icon: "🐟", label: "Fish", tag: "loose-passive",
    iters: 60, noise: 0.10, usePotOdds: false, callFloor: 0.24, raiseAt: 0.80, betAt: 0.60, bluff: 0.0,
    size: 0.5, pfRaise: 12, pfCall: 3.5 },
  reg: { key: "reg", icon: "🎯", label: "Reg", tag: "tight-aggressive",
    iters: 120, noise: 0.05, usePotOdds: true, margin: 0.03, raiseAt: 0.66, betAt: 0.55, bluff: 0.06,
    size: 0.66, pfRaise: 8.5, pfCall: 6.5 },
  shark: { key: "shark", icon: "🦈", label: "Shark", tag: "thinking player",
    iters: 180, noise: 0.02, usePotOdds: true, margin: -0.01, raiseAt: 0.58, betAt: 0.50, bluff: 0.14,
    size: 0.75, pfRaise: 8, pfCall: 6, semibluff: true },
};

// decide a bot action. returns { action:'fold'|'check'|'call'|'raise', to } (to = raise-to total this street)
function botDecision(G, i, fast) {
  const p = G.players[i];
  const T = LEVELS[G.level];
  const toCall = G.currentBet - p.committedThisStreet;
  const canCheck = toCall <= 0;
  const pot = G.pot;
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const activeOpp = G.players.filter((q) => !q.folded && q !== p).length;
  const preflop = G.board.length === 0;
  const seatsFromBtn = (i - G.button + SEATS) % SEATS; // 0=button-ish ordering
  const late = seatsFromBtn >= SEATS - 2;

  // ---- preflop: score-gated ----
  if (preflop) {
    const s = preflopScore(p.hole) + (late ? 1 : 0) + (rnd() - 0.5) * 1.2;
    const openTo = roundTo(BB * (2.5 + rnd()), 10) + p.committedThisStreet * 0; // ~3bb open
    if (s >= T.pfRaise) {
      const target = G.currentBet <= BB ? Math.max(G.currentBet + G.minRaise, roundTo(BB * 3, 10))
        : roundTo(G.currentBet * 2.6, 10);
      return { action: "raise", to: Math.min(target, p.committedThisStreet + p.stack) };
    }
    if (canCheck) return { action: "check" };
    if (s >= T.pfCall && toCall <= p.stack) return { action: "call" };
    // fish still peels cheap flops
    if (!T.usePotOdds && toCall <= BB * 1.5 && s >= 2.5) return { action: "call" };
    return { action: "fold" };
  }

  // ---- postflop: Monte-Carlo equity ----
  let e = equity(p.hole, G.board, activeOpp, fast ? Math.min(70, T.iters) : T.iters);
  e = clamp(e + (rnd() - 0.5) * T.noise, 0, 1);
  const betSize = () => {
    const raw = roundTo(pot * (T.size * (0.85 + rnd() * 0.4)), 10);
    return clamp(raw, BB, p.stack) ;
  };
  const raiseTarget = () => {
    const raw = roundTo(G.currentBet + Math.max(G.minRaise, pot * T.size), 10);
    return clamp(raw, G.currentBet + G.minRaise, p.committedThisStreet + p.stack);
  };
  const bluffRoll = rnd() < T.bluff;
  // draw detection for semibluff (shark): decent equity but not made
  const drawy = T.semibluff && e > 0.34 && e < 0.52;

  if (canCheck) {
    if (e >= T.raiseAt || (e >= T.betAt && rnd() < 0.8) || bluffRoll || (drawy && rnd() < 0.5)) {
      const to = Math.min(p.committedThisStreet + betSize(), p.committedThisStreet + p.stack);
      return { action: "raise", to };
    }
    return { action: "check" };
  }
  // facing a bet
  if (e >= T.raiseAt) return { action: "raise", to: raiseTarget() };
  const need = T.usePotOdds ? potOdds + (T.margin || 0) : T.callFloor;
  if (e >= need && toCall <= p.stack) {
    if (drawy && rnd() < 0.35) return { action: "raise", to: raiseTarget() }; // semibluff raise
    return { action: "call" };
  }
  if (bluffRoll && toCall <= pot * 0.6 && p.stack > toCall * 3) return { action: "raise", to: raiseTarget() };
  return { action: "fold" };
}

// ── card face ───────────────────────────────────────────────────────────────
function Card({ c, small, back, dealt }) {
  if (back) return <span className={cx("pk-card back", small && "sm", dealt && "dealt")} />;
  return (
    <span className={cx("pk-card", small && "sm", isRed(c.s) && "red", dealt && "dealt")}>
      <b>{rankTxt(c.r)}</b>
      <i>{SUIT_TXT[c.s]}</i>
    </span>
  );
}

const SEAT_POS = [
  { x: 50, y: 90 }, { x: 12, y: 70 }, { x: 12, y: 30 },
  { x: 50, y: 11 }, { x: 88, y: 30 }, { x: 88, y: 70 },
];

export default function Poker() {
  const [bank, setBank] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS_BANK));
    return v > 0 ? v : START_STACK;
  });
  const [level, setLevel] = useState(() => localStorage.getItem(LS_LEVEL) || "reg");
  useEffect(() => localStorage.setItem(LS_LEVEL, level), [level]);

  const G = useRef(null);
  if (!G.current) {
    G.current = {
      players: Array.from({ length: SEATS }, (_, i) => ({
        seat: i, name: i === 0 ? "You" : BOT_NAMES[i - 1], isHuman: i === 0,
        stack: i === 0 ? bank : START_STACK, hole: [], folded: true, allIn: false,
        committedThisStreet: 0, totalCommitted: 0, hasActed: false, lastAction: "", rebuys: 0,
      })),
      level, button: Math.floor(rnd() * SEATS), deck: [], board: [], pot: 0,
      street: "idle", currentBet: 0, minRaise: BB, actor: -1, phase: "idle",
      handNo: 0, msg: "Tap DEAL to start.", results: null, winFx: 0, revealAll: false,
    };
  }
  const g = G.current;
  g.level = level;

  const [tick, setTick] = useState(0);
  const aliveRef = useRef(true);
  const timers = useRef([]);
  useEffect(() => () => { aliveRef.current = false; timers.current.forEach(clearTimeout); }, []);
  const rr = () => { if (aliveRef.current) setTick((t) => t + 1); };
  const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.current.push(t); return t; };

  const [sim, setSim] = useState(false);
  const simRef = useRef(false);
  const [betAmt, setBetAmt] = useState(BB * 2);

  const syncBank = () => { const v = Math.round(g.players[0].stack); setBank(v); localStorage.setItem(LS_BANK, String(v)); };

  // ── money ──
  function commit(p, amt) {
    amt = Math.min(amt, p.stack);
    p.stack -= amt; p.committedThisStreet += amt; p.totalCommitted += amt; g.pot += amt;
    if (p.stack <= 0) { p.stack = 0; p.allIn = true; }
    return amt;
  }

  // ── deal a new hand ──
  function startHand() {
    // refill busted stacks
    for (const p of g.players) {
      if (p.stack < BB) {
        if (p.isHuman) p.rebuys++;
        p.stack = START_STACK;
      }
    }
    g.button = (g.button + 1) % SEATS;
    g.deck = freshDeck();
    g.board = [];
    g.pot = 0;
    g.currentBet = 0;
    g.minRaise = BB;
    g.street = "preflop";
    g.results = null;
    g.revealAll = false;
    g.handNo++;
    for (const p of g.players) {
      p.hole = [g.deck.pop(), g.deck.pop()];
      p.folded = false; p.allIn = false;
      p.committedThisStreet = 0; p.totalCommitted = 0; p.hasActed = false; p.lastAction = "";
    }
    // blinds
    const sbSeat = (g.button + 1) % SEATS, bbSeat = (g.button + 2) % SEATS;
    commit(g.players[sbSeat], SB); g.players[sbSeat].lastAction = "SB";
    commit(g.players[bbSeat], BB); g.players[bbSeat].lastAction = "BB";
    g.currentBet = BB;
    g.actor = (g.button + 3) % SEATS; // UTG
    g.phase = "betting";
    g.msg = "";
    syncBank();
    rr();
  }

  // find next player who still needs to act, from seat `from` clockwise
  function nextActor(from) {
    for (let k = 0; k < SEATS; k++) {
      const idx = (from + k) % SEATS;
      const p = g.players[idx];
      if (!p.folded && !p.allIn && !p.hasActed) return idx;
    }
    return -1;
  }
  const firstActiveLeftOfButton = () => {
    for (let k = 1; k <= SEATS; k++) {
      const idx = (g.button + k) % SEATS;
      const p = g.players[idx];
      if (!p.folded && !p.allIn) return idx;
    }
    return -1;
  };

  function applyAction(i, action, to) {
    const p = g.players[i];
    if (action === "fold") { p.folded = true; p.hasActed = true; p.lastAction = "Fold"; }
    else if (action === "check") { p.hasActed = true; p.lastAction = "Check"; }
    else if (action === "call") {
      const pay = commit(p, g.currentBet - p.committedThisStreet);
      p.hasActed = true; p.lastAction = p.allIn ? "All-in" : `Call ${money(pay)}`;
    } else { // bet or raise
      const target = Math.min(to, p.committedThisStreet + p.stack);
      const oldBet = g.currentBet;
      const raiseSize = target - oldBet;
      commit(p, target - p.committedThisStreet);
      if (target > oldBet) {
        if (raiseSize >= g.minRaise) {
          g.minRaise = raiseSize;
          for (const q of g.players) if (q !== p && !q.folded && !q.allIn) q.hasActed = false; // reopen
        }
        g.currentBet = target;
      }
      p.hasActed = true;
      p.lastAction = p.allIn ? "All-in" : oldBet === 0 ? `Bet ${money(target)}` : `Raise ${money(target)}`;
    }
    g.lastActor = i;
  }

  async function afterAction() {
    const live = g.players.filter((p) => !p.folded);
    if (live.length === 1) { await endByFold(live[0]); return; }
    const nxt = nextActor((g.lastActor + 1) % SEATS);
    if (nxt !== -1) { g.actor = nxt; g.phase = "betting"; rr(); maybeSchedule(); return; }
    await closeStreet();
  }

  async function closeStreet() {
    g.actor = -1;
    while (true) {
      if (g.street === "river") { await showdown(); return; }
      g.phase = "dealing"; rr();
      await sleep(simRef.current ? 160 : 620);
      if (!aliveRef.current) return;
      if (g.street === "preflop") { g.board = [g.deck.pop(), g.deck.pop(), g.deck.pop()]; g.street = "flop"; }
      else if (g.street === "flop") { g.board = [...g.board, g.deck.pop()]; g.street = "turn"; }
      else { g.board = [...g.board, g.deck.pop()]; g.street = "river"; }
      for (const p of g.players) { p.committedThisStreet = 0; p.hasActed = false; if (!p.folded && !p.allIn) p.lastAction = ""; }
      g.currentBet = 0; g.minRaise = BB;
      const actors = g.players.filter((p) => !p.folded && !p.allIn);
      if (actors.length >= 2) {
        g.actor = firstActiveLeftOfButton();
        g.phase = "betting"; rr(); maybeSchedule(); return;
      }
      rr();
      await sleep(simRef.current ? 160 : 520); // all-in run-out
    }
  }

  function award(pots) {
    const results = [];
    for (const pot of pots) {
      let best = -1, winners = [];
      for (const p of pot.eligible) {
        const v = best7([p.hole[0], p.hole[1], ...g.board]);
        if (v > best) { best = v; winners = [p]; }
        else if (v === best) winners.push(p);
      }
      const share = Math.floor(pot.amount / winners.length / 10) * 10;
      let paid = 0;
      for (const w of winners) { w.stack += share; paid += share; }
      winners[0].stack += pot.amount - paid; // odd chips to first winner
      results.push({ winners: winners.map((w) => w.seat), amount: pot.amount, cat: catOf(best) });
    }
    return results;
  }

  async function showdown() {
    g.phase = "showdown";
    g.revealAll = true;
    const pots = buildPots(g.players);
    const res = award(pots);
    const names = res.map((r) => `${r.winners.map((s) => g.players[s].name).join(" & ")} — ${CAT_NAME[r.cat]}`);
    g.results = res;
    g.msg = `Showdown · ${names.join(" · ")}`;
    g.winFx++;
    syncBank();
    rr();
    scheduleNext(simRef.current ? 900 : 4200);
  }

  async function endByFold(winner) {
    g.phase = "showdown";
    winner.stack += g.pot;
    g.results = [{ winners: [winner.seat], amount: g.pot, cat: -1 }];
    g.msg = `${winner.name} wins ${money(g.pot)} — everyone folded.`;
    g.winFx++;
    syncBank();
    rr();
    scheduleNext(simRef.current ? 700 : 2600);
  }

  function scheduleNext(ms) {
    later(() => { if (aliveRef.current && (g.phase === "showdown")) startHand(); }, ms);
  }

  // ── drive bot turns ──
  function maybeSchedule() {
    if (g.phase !== "betting") return;
    const p = g.players[g.actor];
    if (!p || (p.isHuman && !simRef.current)) return;
    const delay = simRef.current ? 130 : 620 + Math.floor(rnd() * 260);
    later(async () => {
      if (!aliveRef.current || g.phase !== "betting" || g.actor < 0) return;
      const cur = g.players[g.actor];
      if (!cur || (cur.isHuman && !simRef.current)) return;
      const dec = botDecision(g, g.actor, simRef.current);
      applyAction(g.actor, dec.action, dec.to);
      rr();
      await sleep(simRef.current ? 60 : 260);
      if (aliveRef.current) await afterAction();
    }, delay);
  }
  // kick the loop whenever it becomes a bot's turn (or sim auto-plays you)
  useEffect(() => {
    if (g.phase === "betting") {
      const p = g.players[g.actor];
      if (p && (!p.isHuman || simRef.current)) maybeSchedule();
    }
  }, [tick]); // eslint-disable-line

  // ── human actions ──
  const me = g.players[0];
  const myTurn = g.phase === "betting" && g.actor === 0 && !simRef.current;
  const toCall = g.currentBet - (me?.committedThisStreet || 0);
  const canCheck = toCall <= 0;
  const minRaiseTo = g.currentBet + g.minRaise;
  const maxRaiseTo = (me?.committedThisStreet || 0) + (me?.stack || 0);

  async function human(action, to) {
    if (!myTurn) return;
    applyAction(0, action, to);
    rr();
    await sleep(120);
    await afterAction();
  }
  useEffect(() => { // keep slider in range when it becomes your turn
    if (myTurn) setBetAmt(clamp(Math.max(betAmt, minRaiseTo), minRaiseTo, maxRaiseTo));
  }, [myTurn]); // eslint-disable-line

  function newTable() {
    timers.current.forEach(clearTimeout); timers.current = [];
    simRef.current = false; setSim(false);
    for (const p of g.players) { p.stack = p.isHuman ? bank : START_STACK; p.folded = true; p.lastAction = ""; }
    g.phase = "idle"; g.street = "idle"; g.board = []; g.pot = 0; g.results = null; g.actor = -1;
    g.msg = "Tap DEAL to start.";
    rr();
  }
  function resetBank() {
    if (g.phase === "betting" || g.phase === "dealing") return;
    if (!window.confirm("Reset your stack to $10,000?")) return;
    g.players[0].stack = START_STACK; syncBank();
    g.msg = "Fresh $10,000 stack."; rr();
  }
  function toggleSim() {
    if (simRef.current) { simRef.current = false; setSim(false); return; }
    simRef.current = true; setSim(true);
    if (g.phase === "idle" || g.phase === "showdown") startHand();
    else maybeSchedule();
  }

  const potStreet = g.players.reduce((s, p) => s + p.committedThisStreet, 0);
  const potPrev = g.pot - potStreet;

  return (
    <div className="pk">
      <style>{CSS}</style>
      <header className="pk-top">
        <a className="pk-back" href="#">←</a>
        <span className="pk-title">HOLD'EM</span>
        <div className="pk-levels">
          {Object.values(LEVELS).map((L) => (
            <button key={L.key} className={cx("pk-lvl", level === L.key && "on")}
              onClick={() => setLevel(L.key)} title={L.tag}>
              {L.icon}<u>{L.label}</u>
            </button>
          ))}
        </div>
        <span className="pk-meters"><b className="mono">{money(bank)}</b><i>your stack</i></span>
        <button className="pk-reset" onClick={resetBank}>↺</button>
      </header>

      {/* table */}
      <div className="pk-table">
        <div className="pk-felt" />
        {/* community + pot */}
        <div className="pk-center">
          <div className="pk-pot">
            {g.pot > 0 && <span className="pk-pot-amt mono">POT {money(g.pot)}</span>}
          </div>
          <div className="pk-board">
            {g.board.map((c, i) => <Card key={i} c={c} dealt />)}
            {g.phase === "dealing" && <span className="pk-dealing">•••</span>}
          </div>
        </div>

        {/* seats */}
        {g.players.map((p, i) => {
          const pos = SEAT_POS[i];
          const isBtn = i === g.button;
          const active = g.phase === "betting" && g.actor === i;
          const wonSeat = g.results && g.results.some((r) => r.winners.includes(i));
          const showCards = p.isHuman || g.revealAll;
          const inHand = g.phase !== "idle" && !p.folded;
          return (
            <div key={i} className={cx("pk-seat", `s${i}`, p.folded && "folded", active && "active", wonSeat && "won")}
              style={{ left: `${pos.x}%`, top: `${pos.y}%` }}>
              {inHand && (
                <div className="pk-cards">
                  {p.hole.map((c, k) => <Card key={k} c={c} small back={!showCards} />)}
                </div>
              )}
              <div className="pk-plate">
                <span className="pk-name">
                  {!p.isHuman && <em className="pk-badge">{LEVELS[level].icon}</em>}
                  {p.name}{isBtn && <i className="pk-dealer">D</i>}
                </span>
                <span className="pk-stack mono">{money(p.stack)}</span>
                {p.lastAction && g.phase !== "idle" && <span className="pk-last">{p.lastAction}</span>}
              </div>
              {p.committedThisStreet > 0 && (
                <span className={cx("pk-bet", i === 0 ? "up" : "down")}>
                  <i className="pk-betchip" /> <b className="mono">{money(p.committedThisStreet)}</b>
                </span>
              )}
            </div>
          );
        })}

        {g.winFx > 0 && g.results && g.phase === "showdown" && (
          <div className="pk-winbanner" key={g.winFx}>
            {g.results[0].cat >= 0 ? CAT_NAME[g.results[0].cat] : "Uncontested"}
          </div>
        )}
      </div>

      <div className="pk-msg">{g.msg}&nbsp;</div>

      {/* action bar */}
      <footer className="pk-actions">
        {g.phase === "idle" || (g.phase === "showdown" && !simRef.current) ? (
          <div className="pk-startrow">
            <button className="pk-deal" onClick={startHand}>
              {g.handNo === 0 ? "DEAL" : "NEXT HAND"}<small>{LEVELS[level].icon} {LEVELS[level].label} table · {money(BB / 2)}/{money(BB)}</small>
            </button>
          </div>
        ) : myTurn ? (
          <div className="pk-actrow">
            <div className="pk-btns">
              <button className="pk-act fold" onClick={() => human("fold")}>Fold</button>
              {canCheck
                ? <button className="pk-act check" onClick={() => human("check")}>Check</button>
                : <button className="pk-act call" onClick={() => human("call")}>
                    Call<small>{money(Math.min(toCall, me.stack))}</small>
                  </button>}
              {maxRaiseTo > g.currentBet && me.stack > toCall && (
                <button className="pk-act raise" onClick={() => human("raise", clamp(betAmt, minRaiseTo, maxRaiseTo))}>
                  {g.currentBet === 0 ? "Bet" : "Raise"}<small>{money(clamp(betAmt, minRaiseTo, maxRaiseTo))}</small>
                </button>
              )}
            </div>
            {maxRaiseTo > minRaiseTo && (
              <div className="pk-slider">
                <input type="range" min={minRaiseTo} max={maxRaiseTo} step={10}
                  value={clamp(betAmt, minRaiseTo, maxRaiseTo)} onChange={(e) => setBetAmt(+e.target.value)} />
                <div className="pk-quick">
                  {[["½ pot", g.pot * 0.5], ["¾", g.pot * 0.75], ["pot", g.pot], ["all-in", maxRaiseTo]].map(([lbl, v]) => (
                    <button key={lbl} onClick={() => setBetAmt(clamp(lbl === "all-in" ? maxRaiseTo : roundTo(g.currentBet + v, 10), minRaiseTo, maxRaiseTo))}>{lbl}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="pk-waiting">{simRef.current ? "sim running…" : "waiting…"}</div>
        )}
      </footer>

      {/* SIM */}
      <button className={cx("pk-simfab", sim && "on")} onClick={toggleSim}>{sim ? "STOP" : "SIM"}</button>
      <button className="pk-newtable" onClick={newTable}>⟳ table</button>
    </div>
  );
}

const CSS = `
.pk{--felt:#0f5132;--feltdk:#08351f;--rail:#3a2417;--gold:#f2c14e;--ink:#f2ede2;--dim:#9db8a6;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace;
  font-family:var(--sans);color:var(--ink);min-height:100vh;min-height:100dvh;user-select:none;
  background:radial-gradient(ellipse at 50% 0%,#146b43,#0a3d25 55%,#062417);display:flex;flex-direction:column;overflow:hidden;}
.pk *{box-sizing:border-box;}
.pk .mono{font-family:var(--mono);font-variant-numeric:tabular-nums;}
.pk-top{display:flex;align-items:center;gap:8px;padding:9px 12px;background:rgba(0,0,0,.34);z-index:5;}
.pk-back{color:var(--dim);text-decoration:none;font-size:1rem;}
.pk-title{font-size:.74rem;letter-spacing:.24em;color:var(--gold);font-weight:800;}
.pk-levels{display:flex;gap:4px;margin-left:auto;}
.pk-lvl{display:flex;flex-direction:column;align-items:center;gap:0;background:rgba(255,255,255,.05);border:1.5px solid transparent;
  border-radius:9px;padding:3px 7px;cursor:pointer;color:var(--dim);line-height:1.1;}
.pk-lvl u{text-decoration:none;font-size:.5rem;letter-spacing:.05em;}
.pk-lvl.on{border-color:var(--gold);color:var(--ink);background:rgba(242,193,78,.14);}
.pk-meters{display:flex;flex-direction:column;align-items:flex-end;}
.pk-meters b{font-size:.82rem;color:var(--gold);}
.pk-meters i{font-style:normal;font-size:.48rem;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);}
.pk-reset{background:transparent;border:1px solid #4b6b57;color:var(--dim);border-radius:8px;padding:5px 8px;font-size:.8rem;cursor:pointer;}

.pk-table{position:relative;flex:1;margin:6px 8px;min-height:0;}
.pk-felt{position:absolute;inset:6% 3%;border-radius:44% / 40%;background:radial-gradient(ellipse at 50% 40%,#1a7a4e,var(--felt) 60%,var(--feltdk));
  border:10px solid #24160d;box-shadow:inset 0 0 40px rgba(0,0,0,.5),0 8px 24px rgba(0,0,0,.5);}
.pk-center{position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:7px;z-index:2;}
.pk-pot{min-height:16px;}
.pk-pot-amt{font-size:.66rem;font-weight:800;color:var(--gold);background:rgba(0,0,0,.4);padding:3px 10px;border-radius:20px;letter-spacing:.05em;}
.pk-board{display:flex;gap:4px;min-height:52px;align-items:center;}
.pk-dealing{color:var(--gold);letter-spacing:3px;animation:pk-blink 1s infinite;}
@keyframes pk-blink{50%{opacity:.3;}}

.pk-card{width:34px;height:48px;border-radius:5px;background:linear-gradient(155deg,#fff,#eee);display:inline-flex;
  flex-direction:column;align-items:center;justify-content:center;color:#16202e;box-shadow:0 2px 5px rgba(0,0,0,.4);border:1px solid #cbb78f;}
.pk-card b{font-size:.9rem;font-weight:800;line-height:1;}
.pk-card i{font-style:normal;font-size:.82rem;line-height:1;}
.pk-card.red{color:#c0392b;}
.pk-card.sm{width:26px;height:37px;}
.pk-card.sm b{font-size:.66rem;} .pk-card.sm i{font-size:.6rem;}
.pk-card.back{background:repeating-linear-gradient(45deg,#2e5280 0 5px,#27456b 5px 10px);border:1px solid rgba(255,255,255,.35);}
.pk-card.back.sm{background:repeating-linear-gradient(45deg,#2e5280 0 4px,#27456b 4px 8px);}
.pk-card.dealt{animation:pk-deal .3s ease backwards;}
@keyframes pk-deal{from{transform:translateY(-18px) scale(.7);opacity:0;}}

.pk-seat{position:absolute;transform:translate(-50%,-50%);width:96px;display:flex;flex-direction:column;align-items:center;gap:2px;z-index:3;transition:opacity .25s;}
.pk-seat.folded{opacity:.4;}
.pk-cards{display:flex;gap:2px;}
.pk-plate{display:flex;flex-direction:column;align-items:center;background:rgba(6,20,14,.9);border:1px solid #3c5a48;
  border-radius:10px;padding:3px 8px;min-width:78px;}
.pk-seat.active .pk-plate{border-color:var(--gold);box-shadow:0 0 12px rgba(242,193,78,.6);animation:pk-pulse 1.1s infinite;}
@keyframes pk-pulse{50%{box-shadow:0 0 18px rgba(242,193,78,.85);}}
.pk-seat.won .pk-plate{border-color:#7de89b;box-shadow:0 0 16px rgba(125,232,155,.7);}
.pk-name{font-size:.6rem;font-weight:700;display:flex;align-items:center;gap:3px;}
.pk-badge{font-style:normal;font-size:.62rem;}
.pk-dealer{font-style:normal;background:#fff;color:#111;font-size:.46rem;font-weight:900;width:12px;height:12px;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;margin-left:2px;}
.pk-stack{font-size:.64rem;color:var(--gold);font-weight:700;}
.pk-last{font-size:.5rem;color:var(--dim);letter-spacing:.03em;max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pk-bet{position:absolute;display:flex;align-items:center;gap:3px;font-size:.56rem;font-weight:700;color:var(--ink);white-space:nowrap;}
.pk-bet.down{top:100%;margin-top:2px;} .pk-bet.up{bottom:100%;margin-bottom:2px;}
.pk-betchip{width:11px;height:11px;border-radius:50%;background:#c0392b;border:1.5px dashed rgba(255,255,255,.7);display:inline-block;}

.pk-winbanner{position:absolute;left:50%;top:70%;transform:translate(-50%,-50%);z-index:8;pointer-events:none;
  background:rgba(6,26,16,.92);border:2px solid var(--gold);color:var(--gold);font-weight:900;letter-spacing:.1em;
  padding:8px 22px;border-radius:14px;font-size:.9rem;animation:pk-pop .5s cubic-bezier(.2,1.6,.4,1);}
@keyframes pk-pop{from{transform:translate(-50%,-50%) scale(.4);opacity:0;}}

.pk-msg{min-height:20px;text-align:center;font-size:.66rem;color:var(--dim);padding:2px 12px;}

.pk-actions{padding:8px 12px calc(12px + env(safe-area-inset-bottom));background:rgba(6,20,14,.6);min-height:74px;z-index:5;}
.pk-startrow,.pk-actrow{max-width:520px;margin:0 auto;}
.pk-deal{width:100%;padding:13px;border-radius:13px;border:2px solid var(--gold);cursor:pointer;
  background:linear-gradient(#1a7a4e,#0f5132);color:#fff;font-weight:900;letter-spacing:.14em;font-size:.94rem;
  display:flex;flex-direction:column;align-items:center;gap:2px;}
.pk-deal small{font-weight:600;letter-spacing:.02em;font-size:.56rem;opacity:.85;}
.pk-btns{display:flex;gap:8px;}
.pk-act{flex:1;padding:12px 4px;border-radius:11px;border:2px solid;cursor:pointer;font-weight:800;font-size:.86rem;
  display:flex;flex-direction:column;align-items:center;gap:1px;background:rgba(255,255,255,.05);color:var(--ink);}
.pk-act small{font-weight:700;font-size:.58rem;opacity:.9;}
.pk-act.fold{border-color:#a04a3f;color:#ffb3aa;}
.pk-act.check,.pk-act.call{border-color:#3f88c5;color:#a9d4f5;}
.pk-act.raise{border-color:var(--gold);color:var(--gold);background:rgba(242,193,78,.12);}
.pk-act:active{transform:translateY(1px);}
.pk-slider{margin-top:9px;display:flex;flex-direction:column;gap:6px;}
.pk-slider input[type=range]{width:100%;accent-color:var(--gold);}
.pk-quick{display:flex;gap:6px;}
.pk-quick button{flex:1;padding:6px 2px;border-radius:8px;border:1px solid #4b6b57;background:transparent;color:var(--dim);
  font-size:.6rem;font-weight:700;cursor:pointer;}
.pk-quick button:active{border-color:var(--gold);color:var(--gold);}
.pk-waiting{text-align:center;color:var(--dim);font-size:.7rem;padding:16px;}

.pk-simfab{position:fixed;left:14px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:40;width:54px;height:54px;
  border-radius:50%;border:2.5px solid #7db8ff;color:#a8ceff;background:radial-gradient(circle at 35% 30%,#1d3d63,#10233c);
  font-weight:900;font-size:.66rem;cursor:pointer;box-shadow:0 6px 16px rgba(0,0,0,.5);}
.pk-simfab.on{border-color:#ff8c85;color:#ffd9d6;background:radial-gradient(circle at 35% 30%,#6e211c,#3c100d);animation:pk-spulse 1s infinite alternate;}
@keyframes pk-spulse{to{box-shadow:0 0 18px rgba(232,87,77,.7);}}
.pk-newtable{position:fixed;right:14px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:40;
  border:1px solid #4b6b57;background:rgba(6,20,14,.85);color:var(--dim);border-radius:20px;padding:8px 12px;font-size:.62rem;cursor:pointer;}
`;
