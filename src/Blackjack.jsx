import { useState, useRef, useEffect } from "react";

// ─── BLACKJACK ────────────────────────────────────────────────────────────────
// Casino-standard blackjack, modeled on the common Vegas shoe game:
//   • 6-deck shoe (setting: 1/2/6/8), cut card at ~75% penetration, reshuffle
//   • Dealer PEEKS for blackjack on A/10 up; HITS soft 17 (setting: stand S17)
//   • Blackjack pays 3:2 (setting: 6:5), insurance 2:1 when dealer shows an ace
//   • Split up to 4 hands, double any first two cards, double after split,
//     split aces get ONE card each (21 ≠ blackjack), late surrender
// Real card faces with deal + hole-card flip animations. Play money only
// (localStorage) — nothing here touches The Book's data.

const LS_BANK = "the-book.blackjack.bank.v1";
const START_BANK = 1000;
const CHIPS = [5, 10, 25, 100, 500];

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const VAL = (r) => (r === "A" ? 11 : ["J", "Q", "K"].includes(r) ? 10 : Number(r));

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRed = (s) => s === "♥" || s === "♦";

// ── side bets (common casino paytables — vary slightly by house) ─────────────
// Match the Dealer (6-deck): each of your two cards matching the dealer's
// upcard rank pays 4:1 unsuited, 11:1 suited (both cards can match).
// Perfect Pairs: mixed 6:1 · colored 12:1 · perfect 25:1.
// 21+3 (your two + dealer up): flush 5:1 · straight 10:1 · trips 30:1 ·
// straight flush 40:1 · suited trips 100:1.
function scorePairs(a, b) {
  if (a.r !== b.r) return null;
  if (a.s === b.s) return { mult: 25, label: "Perfect pair 25:1" };
  if (isRed(a.s) === isRed(b.s)) return { mult: 12, label: "Colored pair 12:1" };
  return { mult: 6, label: "Mixed pair 6:1" };
}
function scoreMatch(pc, up) {
  let mult = 0;
  const parts = [];
  for (const c of pc) {
    if (c.r !== up.r) continue;
    if (c.s === up.s) { mult += 11; parts.push("suited 11:1"); }
    else { mult += 4; parts.push("match 4:1"); }
  }
  return mult ? { mult, label: parts.join(" + ") } : null;
}
function score21p3(a, b, up) {
  const cards = [a, b, up];
  const suited = cards.every((c) => c.s === a.s);
  const trips = cards.every((c) => c.r === a.r);
  const order = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const idx = cards.map((c) => order.indexOf(c.r)).sort((x, y) => x - y);
  const run = (v) => v[1] === v[0] + 1 && v[2] === v[1] + 1;
  const straight = run(idx) || (idx[0] === 0 && idx[1] === 11 && idx[2] === 12); // A-2-3 … Q-K-A
  if (trips && suited) return { mult: 100, label: "Suited trips 100:1" };
  if (straight && suited) return { mult: 40, label: "Straight flush 40:1" };
  if (trips) return { mult: 30, label: "Three of a kind 30:1" };
  if (straight) return { mult: 10, label: "Straight 10:1" };
  if (suited) return { mult: 5, label: "Flush 5:1" };
  return null;
}

function newShoe(decks) {
  const shoe = [];
  for (let d = 0; d < decks; d++)
    for (const s of SUITS) for (const r of RANKS) shoe.push({ r, s });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { total += VAL(c.r); if (c.r === "A") aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}
const isBJ = (h) => h.cards.length === 2 && !h.fromSplit && handValue(h.cards).total === 21;

// ─── card face ──────────────────────────────────────────────────────────────
// One face at a time — no 3D double-faced flip, so no z-fighting artifacts on
// iOS. The hole card mounts its front with a flip-in animation when revealed.
function Card({ c, hidden, fresh }) {
  const red = c && (c.s === "♥" || c.s === "♦");
  return (
    <div className={cx("bj-card", fresh && "fresh")}>
      {hidden ? (
        <div className="bj-face bj-back"><i /></div>
      ) : (
        <div className={cx("bj-face bj-front", red && "red", c?.wasHidden && "flipin")}>
          <span className="bj-idx">{c?.r}<em>{c?.s}</em></span>
          <span className="bj-pip">{c?.s}</span>
          <span className="bj-idx flip2">{c?.r}<em>{c?.s}</em></span>
        </div>
      )}
    </div>
  );
}

// A real-looking stack of casino chips for a given amount (denoms colored like
// the rack; stack grows upward as the bet grows).
const CHIP_COLOR = { 1: "#7a7a7a", 5: "#c0392b", 10: "#2471a3", 25: "#1e8449", 100: "#151515", 500: "#6c3483" };
function ChipStack({ amt, small }) {
  const den = [500, 100, 25, 10, 5, 1];
  const list = [];
  let rem = Math.round(amt);
  for (const d of den) while (rem >= d && list.length < 10) { list.push(d); rem -= d; }
  const shown = list.reverse(); // big denominations on top of the stack
  const size = small ? 24 : 40;
  const off = small ? 3 : 4.5;
  const h = size + off * Math.max(0, shown.length - 1);
  return (
    <span className="bj-cstack" style={{ width: size, height: h }}>
      {shown.map((d, i) => (
        <i key={i} className="bj-cchip"
          style={{ background: CHIP_COLOR[d], width: size, height: size, bottom: i * off, zIndex: i }}>
          {i === shown.length - 1 && <em>${d}</em>}
        </i>
      ))}
    </span>
  );
}

// ── basic strategy (multi-deck, DAS, late surrender; H17/S17 aware) ─────────
// Returns "hit" | "stand" | "double" | "split" | "surrender".
// opts: {canDouble, canSplit, canSurr, h17, count (deviations on), tc}
function bestMove(hand, up, opts) {
  const cards = hand.cards;
  const v = handValue(cards);
  const d = VAL(up.r); // 2..11 (A = 11)
  const isPair = cards.length === 2 && VAL(cards[0].r) === VAL(cards[1].r);
  const pairOf8 = isPair && VAL(cards[0].r) === 8;

  // counting deviations — Illustrious 18 (subset) + Fab 4 surrenders
  let skip15v10Surr = false;
  if (opts.count) {
    const tc = opts.tc;
    const hard = !v.soft;
    // Fab 4 surrender indices
    if (opts.canSurr && hard) {
      if (v.total === 14 && d === 10 && tc >= 3) return "surrender";
      if (v.total === 15 && d === 9 && tc >= 2) return "surrender";
      if (v.total === 15 && d === 10 && tc < 0) skip15v10Surr = true; // take the hit instead
    }
    // stands
    if (hard && v.total === 16 && d === 10 && tc > 0 && !isPair) return "stand";
    if (hard && v.total === 16 && d === 9 && tc >= 4) return "stand";
    if (hard && v.total === 15 && d === 10 && tc >= 4 && !opts.canSurr) return "stand";
    if (hard && v.total === 12 && d === 3 && tc >= 2) return "stand";
    if (hard && v.total === 12 && d === 2 && tc >= 3) return "stand";
    // negative-count hits (forced play at bad counts)
    if (hard && v.total === 12 && d === 4 && tc < 0) return "hit";
    if (hard && v.total === 13 && d === 2 && tc < -1) return "hit";
    if (hard && v.total === 13 && d === 3 && tc < -2) return "hit";
    // doubles
    if (opts.canDouble && hard) {
      if (v.total === 11 && d === 11 && tc >= 1) return "double";
      if (v.total === 10 && d === 10 && tc >= 4) return "double";
      if (v.total === 10 && d === 11 && tc >= 3) return "double";
      if (v.total === 9 && d === 2 && tc >= 1) return "double";
      if (v.total === 9 && d === 7 && tc >= 3) return "double";
    }
    // the famous 10,10 splits vs 5/6 at high counts
    if (isPair && VAL(cards[0].r) === 10 && opts.canSplit) {
      if (d === 6 && tc >= 4) return "split";
      if (d === 5 && tc >= 5) return "split";
    }
  }

  // late surrender
  if (opts.canSurr && !v.soft) {
    if (v.total === 16 && !pairOf8 && [9, 10, 11].includes(d)) return "surrender";
    if (v.total === 15 && ((d === 10 && !skip15v10Surr) || (opts.h17 && d === 11))) return "surrender";
    if (opts.h17 && pairOf8 && d === 11) return "surrender"; // 8,8 vs A (H17)
    if (opts.h17 && v.total === 17 && d === 11) return "surrender";
  }

  // pairs
  if (isPair && opts.canSplit) {
    const p = VAL(cards[0].r);
    if (p === 11 || p === 8) return "split";
    if (p === 9) return [7, 10, 11].includes(d) ? "stand" : "split";
    if (p === 7) return d <= 7 ? "split" : "hit";
    if (p === 6) return d <= 6 ? "split" : "hit";
    if (p === 4) return d === 5 || d === 6 ? "split" : "hit";
    if (p === 3 || p === 2) return d <= 7 ? "split" : "hit";
    // 5s and 10s play as totals
  }

  const dbl = opts.canDouble;
  if (v.soft) {
    const t = v.total;
    if (t >= 20) return "stand";
    if (t === 19) return dbl && opts.h17 && d === 6 ? "double" : "stand";
    if (t === 18) {
      if (d >= 2 && d <= 6) return dbl ? "double" : "stand";
      if (d === 7 || d === 8) return "stand";
      return "hit";
    }
    if (t === 17) return dbl && d >= 3 && d <= 6 ? "double" : "hit";
    if (t === 15 || t === 16) return dbl && d >= 4 && d <= 6 ? "double" : "hit";
    return dbl && (d === 5 || d === 6) ? "double" : "hit"; // soft 13-14
  }
  const t = v.total;
  if (t >= 17) return "stand";
  if (t >= 13) return d <= 6 ? "stand" : "hit";
  if (t === 12) return d >= 4 && d <= 6 ? "stand" : "hit";
  if (t === 11) return dbl ? (d === 11 && !opts.h17 ? "hit" : "double") : "hit";
  if (t === 10) return dbl && d <= 9 ? "double" : "hit";
  if (t === 9) return dbl && d >= 3 && d <= 6 ? "double" : "hit";
  return "hit";
}

// counter's bet spread (units by true count)
const spreadUnits = (tc) => (tc <= 0 ? 1 : tc < 2 ? 2 : tc < 3 ? 4 : tc < 4 ? 8 : 12);

export default function Blackjack() {
  const [bank, setBank] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS_BANK));
    return v > 0 ? v : START_BANK;
  });
  useEffect(() => localStorage.setItem(LS_BANK, String(bank)), [bank]);
  const bankRef = useRef(bank);
  const payBank = (d) => { bankRef.current += d; setBank(bankRef.current); };

  // settings
  const [decks, setDecks] = useState(6);
  const [h17, setH17] = useState(true);      // dealer hits soft 17 (Vegas default)
  const [pay32, setPay32] = useState(true);  // blackjack pays 3:2 (else 6:5)

  // authoritative game object lives in a ref (async animation sequences mutate
  // it step by step); a tick forces re-render after each mutation.
  const G = useRef({
    shoe: newShoe(6),
    discards: [], // cards seen since the last shuffle (for the count)
    phase: "bet", // bet | dealing | insurance | player | dealer | done
    dealer: { cards: [], hidden: true },
    hands: [], // {cards, bet, doubled, done, busted, surrendered, fromSplit, splitAces, result}
    active: 0,
    lastBet: 0,
    freshIds: new Set(),
    msg: "Place your bet.",
  });
  const [tick, setTick] = useState(0);
  const rr = () => { if (aliveRef.current) setTick((t) => t + 1); };

  // ── SIM autopilot state ──
  const [simOpen, setSimOpen] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [simCfg, setSimCfg] = useState({ strat: "basic", unit: 10, sides: false });
  const [simStats, setSimStats] = useState(null); // {hands, net}
  const simRef = useRef({ running: false, busy: false, hands: 0, startBank: 0, startRefill: 0 });
  const refillAddRef = useRef(0);
  const [bet, setBet] = useState(0);
  const [chip, setChip] = useState(25);
  const [sides, setSides] = useState({ match: 0, pairs: 0, plus3: 0 });
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const [showCount, setShowCount] = useState(false);

  const g = G.current;
  const cardsLeft = g.shoe.length;
  const cutCard = Math.floor(52 * decks * 0.25);

  // ── shoe / counting info (Hi-Lo: 2-6 = +1 · 7-9 = 0 · 10s and aces = −1) ──
  // The hidden hole card is NOT counted until revealed — true to real practice.
  const hiLo = (c) =>
    ["2", "3", "4", "5", "6"].includes(c.r) ? 1 : ["10", "J", "Q", "K", "A"].includes(c.r) ? -1 : 0;
  let running = 0;
  for (const c of g.discards || []) running += hiLo(c);
  for (const h of g.hands) for (const c of h.cards) running += hiLo(c);
  g.dealer.cards.forEach((c, i) => { if (!(g.dealer.hidden && i === 1)) running += hiLo(c); });
  const shoeTotal = 52 * decks;
  const dealtCount = shoeTotal - cardsLeft;
  const decksLeft = cardsLeft / 52;
  const trueCount = decksLeft > 0.25 ? running / decksLeft : running;

  function draw() {
    if (!g.shoe.length) { g.shoe = newShoe(decks); g.discards = []; } // never run dry mid-hand
    return g.shoe.pop();
  }

  async function dealCard(target, { hidden = false, pause = 330 } = {}) {
    const c = draw();
    c.id = Math.random();
    target.push(Object.assign(c, hidden ? { hidden: true, wasHidden: true } : null));
    g.freshIds = new Set([c.id]);
    rr();
    await sleep(simRef.current.running ? Math.min(pause, 120) : pause); // sim plays fast
    return c;
  }

  const activeHand = () => g.hands[g.active];

  // round is over — compute net result for the win banner
  function endRound() {
    g.roundNet = bankRef.current - (g.bankAtStart ?? bankRef.current);
    g.roundKey = Math.random(); // retriggers the pop animation
    g.phase = "done";
    // busted (can't cover the smallest chip): auto-refill the play bankroll
    if (bankRef.current < CHIPS[0]) {
      refillAddRef.current += START_BANK - bankRef.current;
      payBank(START_BANK - bankRef.current);
      g.msg += " · Busted — bankroll refilled to $1,000.";
    }
  }

  // ── round flow ─────────────────────────────────────────────────────────────
  async function deal(forced) {
    if (g.phase !== "bet" && g.phase !== "done") return;
    // deal is also a click handler — only trust a numeric override (the sim)
    const b = (typeof forced === "number" ? forced : null) ?? (bet || g.lastBet);
    const sTotal = sides.match + sides.pairs + sides.plus3;
    if (!b) { g.msg = "Add chips to bet first."; rr(); return; }
    if (bankRef.current < b + sTotal) { g.msg = "Not enough credits."; rr(); return; }

    // last round's cards go to the discard tray (they stay countable)
    for (const h of g.hands) g.discards.push(...h.cards);
    g.discards.push(...g.dealer.cards);

    // reshuffle at the cut card
    if (g.shoe.length < cutCard) {
      g.shoe = newShoe(decks);
      g.discards = [];
      g.msg = "Shuffling a fresh shoe…";
      rr();
      await sleep(900);
    }

    g.bankAtStart = bankRef.current; // for the round-net win banner
    payBank(-(b + sTotal));
    g.lastBet = b;
    setBet(0); // next round's DEAL with no chips = rebet the same amount
    g.phase = "dealing";
    g.dealer = { cards: [], hidden: true };
    g.hands = [{ cards: [], bet: b, doubled: false, done: false, busted: false, surrendered: false, fromSplit: false, splitAces: false, result: null }];
    g.active = 0;
    g.msg = "";
    g.sideResults = null;
    rr();

    await dealCard(g.hands[0].cards);
    await dealCard(g.dealer.cards);
    await dealCard(g.hands[0].cards);
    await dealCard(g.dealer.cards, { hidden: true });

    const up = g.dealer.cards[0];

    // side bets resolve off the first two cards + dealer upcard
    if (sTotal) {
      const [c1, c2] = g.hands[0].cards;
      const res = {
        pairs: sides.pairs ? scorePairs(c1, c2) : undefined,
        match: sides.match ? scoreMatch([c1, c2], up) : undefined,
        plus3: sides.plus3 ? score21p3(c1, c2, up) : undefined,
      };
      const notes = [];
      let sideWin = 0;
      for (const [k, r] of Object.entries(res)) {
        if (r === undefined) continue;
        if (r) { sideWin += sides[k] * (r.mult + 1); notes.push(`${r.label} +${money(sides[k] * r.mult)}`); }
      }
      if (sideWin) payBank(sideWin);
      g.sideResults = res;
      if (notes.length) { g.msg = "Side bets: " + notes.join(" · "); rr(); await sleep(700); }
    }
    if (up.r === "A" && bankRef.current >= b / 2) {
      g.phase = "insurance";
      g.msg = "Insurance? Pays 2:1 if the dealer has blackjack.";
      rr();
      return;
    }
    await afterInsurance(false);
  }

  async function afterInsurance(took) {
    const b = g.hands[0].bet;
    const ins = took ? b / 2 : 0;
    if (ins) payBank(-ins);

    const up = g.dealer.cards[0];
    const dealerBJ = handValue(g.dealer.cards.map((c) => ({ r: c.r }))).total === 21;

    // dealer peeks on A or 10-value
    if ((up.r === "A" || VAL(up.r) === 10) && dealerBJ) {
      g.dealer.hidden = false;
      const playerBJ = isBJ(g.hands[0]);
      let note = "Dealer has blackjack.";
      if (ins) { payBank(ins * 3); note += ` Insurance pays ${money(ins * 2)}.`; }
      if (playerBJ) { payBank(b); g.hands[0].result = "push"; note += " Your blackjack pushes."; }
      else g.hands[0].result = "lose";
      g.msg = note;
      endRound();
      rr();
      return;
    }
    if (ins) g.msg = "No dealer blackjack — insurance lost.";

    // player natural
    if (isBJ(g.hands[0])) {
      g.dealer.hidden = false;
      const win = b * (pay32 ? 1.5 : 1.2);
      payBank(b + win);
      g.hands[0].result = "bj";
      g.msg = `BLACKJACK! Pays ${money(win)}.`;
      endRound();
      rr();
      return;
    }

    g.phase = "player";
    if (!g.msg) g.msg = "Your move.";
    rr();
  }

  async function advance() {
    // move to next unfinished hand, drawing the 2nd card for fresh split hands
    while (g.active < g.hands.length && g.hands[g.active].done) g.active++;
    if (g.active < g.hands.length) {
      const h = g.hands[g.active];
      if (h.cards.length === 1) {
        await dealCard(h.cards);
        if (h.splitAces) { h.done = true; rr(); return advance(); }
        if (handValue(h.cards).total === 21) { h.done = true; rr(); return advance(); }
      }
      rr();
      return;
    }
    await dealerPlay();
  }

  async function dealerPlay() {
    g.phase = "dealer";
    g.dealer.hidden = false;
    rr();
    await sleep(simRef.current.running ? 160 : 550);

    const liveHands = g.hands.filter((h) => !h.busted && !h.surrendered);
    if (liveHands.length) {
      for (;;) {
        const v = handValue(g.dealer.cards);
        if (v.total > 21) break;
        if (v.total > 17) break;
        if (v.total === 17 && (!v.soft || !h17)) break;
        await dealCard(g.dealer.cards, { pause: 560 });
      }
    }

    // settle
    const dv = handValue(g.dealer.cards).total;
    const dBust = dv > 21;
    const notes = [];
    for (const h of g.hands) {
      if (h.surrendered) { h.result = "surr"; continue; }
      if (h.busted) { h.result = "lose"; continue; }
      const pv = handValue(h.cards).total;
      if (dBust || pv > dv) { h.result = "win"; payBank(h.bet * 2); }
      else if (pv === dv) { h.result = "push"; payBank(h.bet); }
      else h.result = "lose";
    }
    const won = g.hands.filter((h) => h.result === "win").length;
    const pushed = g.hands.filter((h) => h.result === "push").length;
    const lost = g.hands.filter((h) => h.result === "lose").length;
    if (dBust) notes.push(`Dealer busts with ${dv}!`);
    else notes.push(`Dealer has ${dv}.`);
    if (won) notes.push(`${won} win${won > 1 ? "s" : ""}`);
    if (pushed) notes.push(`${pushed} push${pushed > 1 ? "es" : ""}`);
    if (lost) notes.push(`${lost} loss${lost > 1 ? "es" : ""}`);
    g.msg = notes.join(" · ");
    endRound();
    rr();
  }

  // ── player actions ──────────────────────────────────────────────────────────
  async function hit() {
    if (g.phase !== "player") return;
    const h = activeHand();
    await dealCard(h.cards);
    const v = handValue(h.cards);
    if (v.total > 21) { h.busted = true; h.done = true; g.msg = "Bust!"; rr(); return advance(); }
    if (v.total === 21) { h.done = true; rr(); return advance(); }
    rr();
  }
  async function stand() {
    if (g.phase !== "player") return;
    activeHand().done = true;
    rr();
    return advance();
  }
  async function doubleDown() {
    if (!canDouble()) return;
    const h = activeHand();
    payBank(-h.bet);
    h.bet *= 2;
    h.doubled = true;
    await dealCard(h.cards);
    if (handValue(h.cards).total > 21) { h.busted = true; g.msg = "Bust!"; }
    h.done = true;
    rr();
    return advance();
  }
  async function split() {
    if (!canSplit()) return;
    const h = activeHand();
    payBank(-h.bet);
    const [c1, c2] = h.cards;
    const aces = c1.r === "A";
    const mk = (c) => ({ cards: [c], bet: h.bet, doubled: false, done: false, busted: false, surrendered: false, fromSplit: true, splitAces: aces, result: null });
    g.hands.splice(g.active, 1, mk(c1), mk(c2));
    rr();
    await sleep(260);
    return advance(); // draws the 2nd card for the first split hand
  }
  function surrender() {
    if (!canSurrender()) return;
    const h = activeHand();
    h.surrendered = true;
    h.done = true;
    payBank(h.bet / 2);
    g.msg = `Surrendered — half the bet (${money(h.bet / 2)}) returned.`;
    rr();
    return advance();
  }

  const canAct = () => g.phase === "player" && activeHand() && !activeHand().done;
  const canDouble = () =>
    canAct() && activeHand().cards.length === 2 && !activeHand().splitAces && bankRef.current >= activeHand().bet;
  const canSplit = () => {
    if (!canAct()) return false;
    const h = activeHand();
    return (
      h.cards.length === 2 &&
      VAL(h.cards[0].r) === VAL(h.cards[1].r) &&
      !h.splitAces &&
      g.hands.length < 4 &&
      bankRef.current >= h.bet
    );
  };
  const canSurrender = () =>
    canAct() && g.hands.length === 1 && activeHand().cards.length === 2 && !activeHand().doubled;

  function resetBank() {
    if (g.phase === "dealing" || g.phase === "dealer") return;
    if (!window.confirm("Reset play bankroll to $1,000?")) return;
    bankRef.current = START_BANK;
    setBank(START_BANK);
    g.phase = "bet"; g.hands = []; g.dealer = { cards: [], hidden: true };
    g.msg = "Fresh bankroll. Place your bet.";
    setBet(0);
    rr();
  }

  // ── SIM autopilot: plays the book (or counts) by itself ──
  function simStart() {
    setSimOpen(false);
    simRef.current = {
      running: true, busy: false, hands: 0,
      startBank: bankRef.current, startRefill: refillAddRef.current,
      prevSides: sides,
    };
    // "for science": bet the unit on all three side bets every hand
    setSides(simCfg.sides
      ? { match: simCfg.unit, pairs: simCfg.unit, plus3: simCfg.unit }
      : { match: 0, pairs: 0, plus3: 0 });
    setSimStats({ hands: 0, net: 0 });
    setSimRunning(true);
  }
  function simStop() {
    simRef.current.running = false;
    setSimRunning(false);
    setSides(simRef.current.prevSides || { match: 0, pairs: 0, plus3: 0 });
    const net = bankRef.current - simRef.current.startBank - (refillAddRef.current - simRef.current.startRefill);
    setSimStats({ hands: simRef.current.hands, net });
  }

  async function simStep() {
    const counting = simCfg.strat === "count";
    if (g.phase === "bet" || g.phase === "done") {
      const net = bankRef.current - simRef.current.startBank - (refillAddRef.current - simRef.current.startRefill);
      setSimStats({ hands: simRef.current.hands, net });
      simRef.current.hands++;
      const units = counting ? spreadUnits(trueCount) : 1;
      const sTotal = sides.match + sides.pairs + sides.plus3;
      if (sTotal && bankRef.current < sTotal + CHIPS[0]) {
        setSides({ match: 0, pairs: 0, plus3: 0 }); // too broke for side bets
        return;
      }
      const wager = Math.max(CHIPS[0], Math.min(simCfg.unit * units, bankRef.current - sTotal));
      await deal(wager);
      return;
    }
    if (g.phase === "insurance") {
      await afterInsurance(counting && trueCount >= 3);
      return;
    }
    if (g.phase === "player") {
      const h = activeHand();
      if (!h || h.done) return;
      const mv = bestMove(h, g.dealer.cards[0], {
        canDouble: canDouble(),
        canSplit: canSplit(),
        canSurr: canSurrender(),
        h17,
        count: counting,
        tc: trueCount,
      });
      if (mv === "surrender") return surrender();
      if (mv === "split") return split();
      if (mv === "double") return doubleDown();
      if (mv === "stand") return stand();
      return hit();
    }
    // dealing / dealer phases: just wait for the next tick
  }

  useEffect(() => {
    if (!simRunning || simRef.current.busy) return;
    const t = setTimeout(async () => {
      if (!simRef.current.running || simRef.current.busy) return;
      simRef.current.busy = true;
      try { await simStep(); } finally {
        simRef.current.busy = false;
        if (aliveRef.current) setTick((x) => x + 1);
      }
    }, 260);
    return () => clearTimeout(t);
  }, [simRunning, tick]); // eslint-disable-line

  const betting = g.phase === "bet" || g.phase === "done";
  const dv = g.dealer.cards.length ? handValue(g.dealer.hidden ? [g.dealer.cards[0]] : g.dealer.cards) : null;

  const RES_TXT = { win: "WIN", lose: "LOSE", push: "PUSH", bj: "BLACKJACK", surr: "SURRENDER" };

  return (
    <div className={cx("bj", (["player", "insurance", "done"].includes(g.phase) || (g.phase === "bet" && (bet > 0 || g.lastBet > 0))) && "acting")}>
      <style>{CSS}</style>
      <header className="bj-top">
        <a className="bj-back" href="#">←</a>
        <span className="bj-title">BLACKJACK</span>
        <span className="bj-rules">{decks} decks · {h17 ? "H17" : "S17"} · BJ pays {pay32 ? "3:2" : "6:5"}</span>
        <span className="bj-meters">
          <span><b className="mono">{money(bank)}</b><i>credits</i></span>
        </span>
        <button className="bj-reset" onClick={resetBank}>Reset</button>
      </header>

      {/* shoe / counting strip */}
      <div className="bj-shoestrip">
        <div className="bj-shoebar" title="shoe penetration — marker is the cut card">
          <i style={{ width: `${(dealtCount / shoeTotal) * 100}%` }} />
          <em style={{ left: `${(1 - cutCard / shoeTotal) * 100}%` }} />
        </div>
        <span className="bj-shoetxt mono">
          {dealtCount}/{shoeTotal} dealt · {decksLeft.toFixed(1)} decks left
        </span>
        <label className="bj-counttoggle">
          <input type="checkbox" checked={showCount} onChange={(e) => setShowCount(e.target.checked)} />
          count
        </label>
        {showCount && (
          <span className="bj-count mono">
            RC {running > 0 ? "+" : ""}{running} · TC {trueCount > 0 ? "+" : ""}{trueCount.toFixed(1)}
          </span>
        )}
      </div>

      {/* table */}
      <div className="bj-table">
        <section className="bj-dealer">
          <div className="bj-row-label">
            DEALER {dv && <b>{g.dealer.hidden ? dv.total + " +" : handValue(g.dealer.cards).total}</b>}
          </div>
          <div className="bj-cards">
            {g.dealer.cards.map((c, i) => (
              <Card key={c.id || i} c={c} hidden={g.dealer.hidden && i === 1} fresh={g.freshIds.has(c.id)} />
            ))}
            {!g.dealer.cards.length && <div className="bj-slot" />}
          </div>
        </section>

        {/* felt lettering, like the printed table */}
        <div className="bj-feltarc">
          <span className="bj-feltline">BLACKJACK PAYS {pay32 ? "3 TO 2" : "6 TO 5"}</span>
          <span className="bj-feltline small">
            Dealer must draw to 16 and {h17 ? "hit soft 17" : "stand on all 17s"} · Insurance pays 2 to 1
          </span>
        </div>

        {g.phase === "done" && g.roundNet > 0 && (
          <div className="bj-winpop" key={g.roundKey}>
            <span className="bj-winpop-t">YOU WIN</span>
            <span className="bj-winpop-amt mono">+{money(g.roundNet)}</span>
          </div>
        )}
        <div className={cx("bj-msg", g.phase === "done" && "big")}>{g.msg}&nbsp;</div>

      {/* player hands */}
      <section className="bj-player">
        <div className="bj-hands">
          {g.hands.map((h, i) => {
            const v = handValue(h.cards);
            return (
              <div key={i} className={cx("bj-hand", g.phase === "player" && i === g.active && !h.done && "live", h.result && `r-${h.result}`)}>
                <div className="bj-cards">
                  {h.cards.map((c, j) => (
                    <Card key={c.id || j} c={c} fresh={g.freshIds.has(c.id)} />
                  ))}
                </div>
                <div className="bj-hand-foot">
                  <span className={cx("bj-total", v.total > 21 && "bust")}>
                    {v.total}{v.soft && v.total <= 21 ? " soft" : ""}
                  </span>
                  <span className="bj-handbet"><ChipStack amt={h.bet} small /><u className="mono">{money(h.bet)}</u></span>
                  {h.result && <span className={cx("bj-res", `r-${h.result}`)}>{RES_TXT[h.result]}</span>}
                </div>
              </div>
            );
          })}
          {!g.hands.length && <div className="bj-slot wide" />}
        </div>
      </section>
      {/* betting spots: pick a chip below, then tap a spot to place it */}
      <section className="bj-sides">
        {[
          ["pairs", "PERFECT PAIRS", "6:1 · 12:1 · 25:1"],
          ["__main__"],
          ["plus3", "21 + 3", "5:1 – 100:1"],
          ["match", "MATCH DEALER", "4:1 / suited 11:1"],
        ].map(([k, lbl, pays]) => {
          if (k === "__main__")
            return (
              <button
                key={k}
                className={cx("bj-mainspot", bet > 0 && "has")}
                onClick={() => betting && bankRef.current >= bet + sides.match + sides.pairs + sides.plus3 + chip && setBet(bet + chip)}
              >
                <span className="bj-spot-ring">
                  {bet > 0 ? <ChipStack amt={bet} /> : <em>BET</em>}
                </span>
                <span className="bj-spot-amt mono">{bet > 0 ? money(bet) : "tap to bet"}</span>
                {bet > 0 && betting && (
                  <i className="bj-spot-x" onClick={(e) => { e.stopPropagation(); setBet(0); }}>✕</i>
                )}
              </button>
            );
          const r = g.sideResults ? g.sideResults[k] : undefined;
          const settled = r !== undefined && g.phase !== "bet";
          return (
            <button
              key={k}
              className={cx("bj-side", sides[k] > 0 && "has", settled && (r ? "won" : "lost"))}
              onClick={() => betting && setSides((s) => ({ ...s, [k]: s[k] + chip }))}
            >
              <span className="bj-side-info">
                <b>{lbl}</b>
                <i>{pays}</i>
                {sides[k] > 0 && <u className="mono">{money(sides[k])}</u>}
              </span>
              {sides[k] > 0 && (
                <span className="bj-side-chips">
                  <ChipStack amt={sides[k]} small />
                  {betting && (
                    <i className="bj-spot-x side" onClick={(e) => { e.stopPropagation(); setSides((s) => ({ ...s, [k]: 0 })); }}>✕</i>
                  )}
                </span>
              )}
              {settled && <span className={cx("bj-side-badge", r ? "w" : "l")}>{r ? "WIN" : "LOSE"}</span>}
            </button>
          );
        })}
      </section>
      </div>{/* /bj-table */}

      {/* floating action cluster — thumb zone, bottom right */}
      {g.phase === "insurance" && (
        <div className="bj-float">
          <div className="bj-float-row">
            <button className="bj-btn ins" onClick={() => afterInsurance(true)}>INSURANCE {money(g.hands[0].bet / 2)}</button>
            <button className="bj-btn" onClick={() => afterInsurance(false)}>NO</button>
          </div>
        </div>
      )}
      {g.phase === "player" && (
        <div className="bj-float">
          <div className="bj-float-row">
            {canSurrender() && <button className="bj-btn surr" onClick={surrender}>SURR</button>}
            {canDouble() && <button className="bj-btn dbl" onClick={doubleDown}>DOUBLE</button>}
            {canSplit() && <button className="bj-btn split" onClick={split}>SPLIT</button>}
          </div>
          <div className="bj-float-row">
            <button className="bj-fab hit" onClick={hit}>HIT</button>
            <button className="bj-fab stand" onClick={stand}>STAND</button>
          </div>
        </div>
      )}
      {g.phase === "done" && (
        <div className="bj-float">
          <button className="bj-fab deal" onClick={deal}>
            DEAL<small>{money(bet || g.lastBet || 0)}</small>
          </button>
        </div>
      )}

      {g.phase === "bet" && (bet > 0 || g.lastBet > 0) && !simRunning && (
        <div className="bj-float">
          <button className="bj-fab deal" onClick={deal}>
            DEAL<small>{money(bet || g.lastBet)}</small>
          </button>
        </div>
      )}

      {/* SIM autopilot */}
      <button
        className={cx("bj-simfab", simRunning && "running")}
        onClick={() => (simRunning ? simStop() : setSimOpen(true))}
      >
        {simRunning ? "STOP" : "SIM"}
      </button>
      {simStats && (
        <div className="bj-simstats">
          <span>{simStats.hands} hands{simRunning && simCfg.strat === "count" ? ` · TC ${trueCount > 0 ? "+" : ""}${trueCount.toFixed(1)}` : ""}</span>
          <b className={cx("mono", simStats.net >= 0 ? "pos" : "neg")}>
            {simStats.net >= 0 ? "+" : "−"}{money(Math.abs(simStats.net))}
          </b>
        </div>
      )}
      {simOpen && (
        <div className="bj-simpanel">
          <div className="bj-simpanel-title">AUTOPILOT</div>
          {[
            ["basic", "Perfect basic strategy", "plays the book on every hand — flat bets, never takes insurance"],
            ["count", "Hi-Lo card counter", "basic strategy + bet spread 1-12x by true count, insurance at TC ≥ +3, Illustrious-18 & Fab-4 deviations"],
          ].map(([k, lbl, sub]) => (
            <button
              key={k}
              className={cx("bj-simstrat", simCfg.strat === k && "on")}
              onClick={() => setSimCfg((c) => ({ ...c, strat: k }))}
            >
              <b>{lbl}</b>
              <i>{sub}</i>
            </button>
          ))}
          <div className="bj-simamts">
            <span>unit</span>
            {[5, 10, 25, 100].map((a) => (
              <button key={a} className={cx("bj-simamt", simCfg.unit === a && "on")}
                onClick={() => setSimCfg((c) => ({ ...c, unit: a }))}>
                ${a}
              </button>
            ))}
          </div>
          <label className="bj-simsides">
            <input
              type="checkbox"
              checked={simCfg.sides}
              onChange={(e) => setSimCfg((c) => ({ ...c, sides: e.target.checked }))}
            />
            also bet Perfect Pairs + 21+3 + Match Dealer every hand
            <i>(for science — these are 2-7% house-edge bets; watch them drain)</i>
          </label>
          <div className="bj-simgo">
            <button className="bj-simcancel" onClick={() => setSimOpen(false)}>Cancel</button>
            <button className="bj-simstart" onClick={simStart}>▶ START</button>
          </div>
        </div>
      )}

      {/* chip rack */}
      {betting && (
        <footer className="bj-rack">
          {CHIPS.map((c) => (
            <button
              key={c}
              className={cx("bj-chip", `c${c}`, chip === c && "sel")}
              onClick={() => setChip(c)}
            >
              ${c}
            </button>
          ))}
          <span className="bj-settings">
            <label>
              decks
              <select value={decks} onChange={(e) => { setDecks(+e.target.value); G.current.shoe = newShoe(+e.target.value); G.current.discards = []; rr(); }}>
                {[1, 2, 6, 8].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label><input type="checkbox" checked={h17} onChange={(e) => setH17(e.target.checked)} /> dealer hits soft 17</label>
            <label><input type="checkbox" checked={pay32} onChange={(e) => setPay32(e.target.checked)} /> BJ pays 3:2</label>
          </span>
        </footer>
      )}
    </div>
  );
}

const CSS = `
.bj{
  --felt:#0d5c3d; --feltdark:#083d27; --linec:#f3ead2; --yellow:#f7d774;
  --red:#d8433b; --green:#63d68b; --ink:#f3ead2; --dim:#b9d3bd;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  font-family:var(--sans); color:var(--ink); min-height:100vh; min-height:100dvh; user-select:none;
  background:radial-gradient(ellipse at 50% -10%, #14754e, var(--felt) 45%, var(--feltdark));
  -webkit-font-smoothing:antialiased; display:flex; flex-direction:column;
}
.bj *{box-sizing:border-box;}
.bj .mono{font-family:var(--mono); font-variant-numeric:tabular-nums;}

.bj-top{display:flex; align-items:center; gap:12px; padding:10px 14px; background:rgba(0,0,0,.28); flex-wrap:wrap;}
.bj-back{color:var(--dim); text-decoration:none; font-size:1rem;}
.bj-title{font-size:.78rem; letter-spacing:.22em; color:var(--yellow); font-weight:800;}
.bj-rules{font-size:.62rem; color:var(--dim); letter-spacing:.04em;}
.bj-shoestrip{display:flex; align-items:center; gap:12px; padding:7px 16px; background:rgba(0,0,0,.18);
  flex-wrap:wrap; justify-content:center;}
.bj-shoebar{position:relative; width:180px; height:9px; border-radius:5px; background:rgba(255,255,255,.14); overflow:visible;}
.bj-shoebar i{position:absolute; left:0; top:0; bottom:0; background:var(--yellow); border-radius:5px; transition:width .3s;}
.bj-shoebar em{position:absolute; top:-3px; bottom:-3px; width:2px; background:var(--red);}
.bj-shoetxt{font-size:.62rem; color:var(--dim);}
.bj-counttoggle{display:flex; gap:5px; align-items:center; font-size:.62rem; color:#9dbfa4; cursor:pointer;}
.bj-count{font-size:.72rem; color:var(--yellow); font-weight:800;}
.bj-meters span{display:flex; flex-direction:column; align-items:flex-end;}
.bj-meters b{font-size:.9rem;}
.bj-meters i{font-style:normal; font-size:.52rem; text-transform:uppercase; letter-spacing:.12em; color:#86ab8e;}
.bj-reset{background:transparent; border:1px solid #3f6b4d; color:#9dbfa4; border-radius:8px; padding:6px 10px; font-size:.66rem; cursor:pointer;}

.bj-table{flex:1; display:flex; flex-direction:column; align-items:center; width:100%;
  max-width:860px; margin:0 auto; padding:0 12px;}
.bj-dealer{padding:20px 16px 4px; min-height:150px; display:flex; flex-direction:column; align-items:center;}
.bj-player{padding:4px 16px 10px; width:100%; display:flex; justify-content:center;}
.bj-row-label{font-size:.6rem; letter-spacing:.28em; color:var(--dim); margin-bottom:10px; font-weight:800; text-align:center;}
.bj-row-label b{color:var(--yellow); margin-left:6px; font-family:var(--mono);}

.bj-feltarc{display:flex; flex-direction:column; align-items:center; gap:4px; margin:8px 0 2px;
  padding:10px 34px; border:2px solid rgba(243,234,210,.28); border-radius:50% / 100% 100% 0 0;
  border-bottom:none;}
.bj-feltline{font-family:Georgia,'Times New Roman',serif; font-style:italic; letter-spacing:.3em;
  color:rgba(243,234,210,.75); font-size:.86rem; font-weight:700; text-align:center;}
.bj-feltline.small{font-size:.56rem; letter-spacing:.18em; color:rgba(243,234,210,.5);}

.bj-cards{display:flex; min-height:96px; justify-content:center;}
.bj-slot{width:66px; height:94px; border:2px dashed rgba(243,234,210,.25); border-radius:9px;}
.bj-slot.wide{width:140px;}

/* card */
.bj-card{width:66px; height:94px; margin-right:-18px; filter:drop-shadow(0 4px 6px rgba(0,0,0,.45));}
.bj-card.fresh{animation:bj-dealin .32s cubic-bezier(.2,.8,.3,1);}
@keyframes bj-dealin{from{transform:translate(60px,-70px) rotate(8deg); opacity:0;} to{transform:none; opacity:1;}}
/* single face at a time — no 3D pair, no iOS z-fighting */
.bj-face{width:100%; height:100%; border-radius:9px; border:1px solid #b9b2a2; position:relative;}
.bj-front{background:linear-gradient(150deg,#fdfbf4,#efe9dc); color:#1d232b; display:flex;
  align-items:center; justify-content:center;}
.bj-front.flipin{animation:bj-flipin .4s cubic-bezier(.3,.8,.3,1);}
@keyframes bj-flipin{from{transform:rotateY(88deg);} to{transform:none;}}
.bj-front.red{color:#c22c24;}
.bj-idx{position:absolute; top:5px; left:6px; font-size:.82rem; font-weight:800; line-height:.95; text-align:center; font-family:Georgia,serif;}
.bj-idx em{display:block; font-style:normal; font-size:.7rem;}
.bj-idx.flip2{top:auto; left:auto; bottom:5px; right:6px; transform:rotate(180deg);}
.bj-pip{font-size:2rem;}
.bj-back{background:#27456b; display:flex; align-items:center; justify-content:center;}
.bj-back i{position:absolute; inset:5px; border-radius:6px; border:2px solid rgba(255,255,255,.35);
  background:repeating-linear-gradient(45deg, #2e5280 0 6px, #27456b 6px 12px);}

/* hands */
.bj-hands{display:flex; gap:26px; flex-wrap:wrap; align-items:flex-end; justify-content:center;}
.bj-hand{padding:8px 10px 9px; border-radius:12px; border:2px solid transparent;}
.bj-hand.live{border-color:var(--yellow); background:rgba(247,215,116,.07);}
.bj-hand.r-win,.bj-hand.r-bj{border-color:var(--green); animation:bj-glow 1.1s ease-out;}
@keyframes bj-glow{0%{box-shadow:0 0 0 rgba(99,214,139,0);} 30%{box-shadow:0 0 26px rgba(99,214,139,.8);} 100%{box-shadow:0 0 8px rgba(99,214,139,.25);}}
.bj-hand.r-lose{opacity:.75;}
.bj-hand-foot{display:flex; align-items:center; gap:8px; margin-top:8px;}
.bj-total{font-family:var(--mono); font-weight:800; font-size:.8rem; background:rgba(0,0,0,.3); border-radius:6px; padding:2px 7px;}
.bj-total.bust{color:var(--red);}
.bj-betchip{font-family:var(--mono); font-size:.68rem; font-weight:800; color:#241c05;
  background:radial-gradient(circle at 40% 35%, #ffe9a8, #d4a940); border:2px dashed #8a6c1e; border-radius:12px; padding:2px 8px;}
.bj-res{font-size:.6rem; font-weight:900; letter-spacing:.08em; padding:3px 7px; border-radius:6px;}
.bj-res.r-win,.bj-res.r-bj{background:var(--green); color:#06230f;}
.bj-res.r-lose{background:var(--red); color:#fff;}
.bj-res.r-push,.bj-res.r-surr{background:#8fa3b8; color:#101820;}

/* betting spots — fixed heights so placing chips never shifts the layout */
.bj-sides{display:flex; gap:10px; justify-content:center; align-items:center; flex-wrap:wrap; padding:6px 0 12px;}
.bj-side{position:relative; display:flex; flex-direction:row; align-items:center; gap:10px;
  border:2px dashed rgba(243,234,210,.4); border-radius:12px; background:rgba(0,0,0,.14);
  color:var(--ink); padding:0 12px; cursor:pointer; min-width:160px; height:64px; justify-content:space-between;}
.bj-side.has{border-style:solid; border-color:var(--yellow);}
.bj-side.won{border-color:var(--green); box-shadow:0 0 10px rgba(99,214,139,.4);}
.bj-side.lost{opacity:.6;}
.bj-side-info{display:flex; flex-direction:column; gap:2px; text-align:left;}
.bj-side-info b{font-size:.58rem; font-weight:900; letter-spacing:.1em;}
.bj-side-info i{font-style:normal; font-size:.5rem; color:var(--dim);}
.bj-side-info u{text-decoration:none; font-size:.62rem; color:var(--yellow); font-weight:800;}
.bj-side-chips{display:flex; align-items:flex-end; gap:4px;}
.bj-side-badge{position:absolute; top:-8px; right:-6px; font-size:.54rem; font-weight:900;
  border-radius:6px; padding:2px 6px; letter-spacing:.06em;}
.bj-side-badge.w{background:var(--green); color:#06230f;}
.bj-side-badge.l{background:var(--red); color:#fff;}

/* main betting circle */
.bj-mainspot{position:relative; display:flex; flex-direction:column; align-items:center; gap:4px;
  background:transparent; border:none; cursor:pointer; color:var(--ink); width:110px;}
.bj-spot-ring{width:84px; height:84px; border-radius:50%; border:3px dashed rgba(243,234,210,.55);
  display:flex; align-items:flex-end; justify-content:center; padding-bottom:8px;}
.bj-mainspot.has .bj-spot-ring{border-style:solid; border-color:var(--yellow);}
.bj-spot-ring em{font-style:normal; align-self:center; font-size:.72rem; letter-spacing:.22em;
  color:rgba(243,234,210,.6); font-weight:900;}
.bj-spot-amt{font-size:.66rem; color:var(--yellow); font-weight:800;}
.bj-spot-x{position:absolute; top:-4px; right:8px; font-style:normal; width:20px; height:20px;
  border-radius:50%; background:rgba(0,0,0,.5); color:#e8b7b2; font-size:.62rem; display:flex;
  align-items:center; justify-content:center; cursor:pointer;}
.bj-spot-x.side{position:static; width:18px; height:18px;}

/* chip stacks */
.bj-cstack{position:relative; display:inline-block; flex-shrink:0;}
.bj-cchip{position:absolute; left:0; border-radius:50%; border:2px dashed rgba(255,255,255,.6);
  box-shadow:0 1px 3px rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; box-sizing:border-box;}
.bj-cchip em{font-style:normal; color:#fff; font-size:.5rem; font-weight:900;}
.bj-handbet{display:flex; align-items:flex-end; gap:5px;}
.bj-handbet u{text-decoration:none; font-size:.62rem; color:var(--yellow); font-weight:800; font-family:var(--mono);}

.bj-msg{padding:6px 18px; min-height:30px; font-size:.86rem; color:var(--yellow); font-weight:600; text-align:center;}
.bj-msg.big{font-size:1rem;}

/* floating action cluster — bottom CENTER, circular hit/stand */
.bj-float{position:fixed; left:50%; transform:translateX(-50%); bottom:calc(16px + env(safe-area-inset-bottom));
  display:flex; flex-direction:column; align-items:center; gap:10px; z-index:60;}
.bj.acting .bj-table{padding-bottom:150px;} /* keep cards clear of the floating buttons */
.bj-float-row{display:flex; gap:14px; align-items:center; justify-content:center;}
.bj-fab{width:78px; height:78px; border-radius:50%; font-weight:900; font-size:.9rem; letter-spacing:.06em;
  cursor:pointer; color:#fff; border:3px solid rgba(255,255,255,.85);
  box-shadow:0 6px 18px rgba(0,0,0,.5), inset 0 -4px 0 rgba(0,0,0,.25);}
.bj-fab:active{transform:translateY(2px);}
.bj-fab.hit{background:radial-gradient(circle at 35% 30%, #35b567, #17743c);}
.bj-fab.stand{background:radial-gradient(circle at 35% 30%, #e2574d, #a72820);}
.bj-float .bj-btn{background:rgba(6,26,15,.92); box-shadow:0 4px 12px rgba(0,0,0,.45);}

/* win pop — fixed overlay so it never pushes the layout, fades out on its own */
.bj-winpop{position:fixed; top:34%; left:50%; z-index:70; pointer-events:none;
  display:flex; flex-direction:column; align-items:center; gap:2px;
  background:rgba(6,26,15,.82); border:2px solid var(--yellow); border-radius:16px; padding:14px 30px;
  box-shadow:0 8px 30px rgba(0,0,0,.5);
  animation:bj-pop .5s cubic-bezier(.2,1.6,.4,1), bj-fade .5s ease 2s forwards;}
.bj-winpop-t{font-size:.7rem; letter-spacing:.34em; color:var(--yellow); font-weight:900;}
.bj-winpop-amt{font-size:1.7rem; font-weight:800; color:var(--yellow);
  text-shadow:0 0 18px rgba(247,215,116,.55), 0 2px 4px rgba(0,0,0,.5);}
@keyframes bj-pop{from{transform:translate(-50%,-50%) scale(.4); opacity:0;}
  70%{transform:translate(-50%,-50%) scale(1.12);} to{transform:translate(-50%,-50%) scale(1); opacity:1;}}
@keyframes bj-fade{to{opacity:0;}}
.bj-winpop{transform:translate(-50%,-50%);}

.bj-fab.deal{background:radial-gradient(circle at 35% 30%, #d4a940, #8a6c1e); display:flex;
  flex-direction:column; align-items:center; justify-content:center; gap:1px;}
.bj-fab.deal small{font-size:.58rem; font-weight:700; opacity:.9;}

.bj-actions{display:flex; gap:9px; padding:10px 16px; flex-wrap:wrap; align-items:center; justify-content:center;}
.bj-btn{padding:13px 20px; border-radius:11px; border:2px solid var(--linec); background:rgba(0,0,0,.25);
  color:var(--ink); font-weight:900; letter-spacing:.08em; font-size:.82rem; cursor:pointer;}
.bj-btn:active{transform:translateY(1px);}
.bj-btn.hit{border-color:var(--green); color:var(--green);}
.bj-btn.stand{border-color:var(--red); color:#ffb3ae;}
.bj-btn.dbl{border-color:var(--yellow); color:var(--yellow);}
.bj-btn.split{border-color:#7db8ff; color:#a8ceff;}
.bj-btn.surr{border-color:#8fa3b8; color:#c6d4e2; font-size:.7rem;}
.bj-btn.ins{border-color:var(--yellow); color:var(--yellow);}
.bj-btn.deal{border-color:var(--yellow); background:linear-gradient(#8a6c1e,#5e4a12); color:#fff; padding:13px 30px;}
.bj-betbox{display:flex; align-items:center; gap:9px; background:rgba(0,0,0,.28); border-radius:11px; padding:10px 14px;}
.bj-betlbl{font-size:.58rem; letter-spacing:.16em; color:var(--dim); font-weight:800;}
.bj-betbox b{font-size:1rem; color:var(--yellow);}
.bj-clearbet{background:none; border:none; color:#9dbfa4; font-size:.66rem; cursor:pointer; text-decoration:underline;}

.bj-rack{display:flex; align-items:center; gap:9px; padding:6px 16px 18px; flex-wrap:wrap;
  justify-content:center; max-width:860px; margin:0 auto; width:100%;}
.bj-chip{width:46px; height:46px; border-radius:50%; font-weight:800; cursor:pointer; color:#fff;
  border:3px dashed rgba(255,255,255,.6); font-size:.72rem;}
.bj-chip.c5{background:#c0392b;} .bj-chip.c10{background:#2471a3;} .bj-chip.c25{background:#1e8449;}
.bj-chip.c100{background:#111;} .bj-chip.c500{background:#6c3483;}
.bj-chip.sel{outline:3px solid var(--yellow); outline-offset:2px;}
.bj-settings{width:100%; display:flex; gap:16px; align-items:center; flex-wrap:wrap; justify-content:center; margin-top:8px;}
.bj-settings label{display:flex; gap:5px; align-items:center; font-size:.64rem; color:#9dbfa4; cursor:pointer;}
.bj-settings select{background:#0f3d28; color:var(--ink); border:1px solid #3f6b4d; border-radius:6px; padding:3px 6px;}

/* SIM autopilot */
.bj-simfab{position:fixed; left:16px; bottom:calc(18px + env(safe-area-inset-bottom)); z-index:60;
  width:58px; height:58px; border-radius:50%; border:2.5px solid #7db8ff; color:#a8ceff;
  background:radial-gradient(circle at 35% 30%, #1d3d63, #10233c); font-weight:900; font-size:.68rem;
  letter-spacing:.08em; cursor:pointer; box-shadow:0 6px 16px rgba(0,0,0,.5);}
.bj-simfab.running{border-color:var(--red); color:#ffd9d6;
  background:radial-gradient(circle at 35% 30%, #6e211c, #3c100d); animation:bj-simpulse 1s infinite alternate;}
@keyframes bj-simpulse{from{box-shadow:0 0 0 rgba(216,67,59,.5);} to{box-shadow:0 0 18px rgba(216,67,59,.7);}}
.bj-simstats{position:fixed; left:84px; bottom:calc(26px + env(safe-area-inset-bottom)); z-index:60;
  display:flex; flex-direction:column; gap:1px; background:rgba(4,26,15,.9); border:1px solid #2c4a35;
  border-radius:10px; padding:6px 10px; pointer-events:none;}
.bj-simstats span{font-size:.56rem; color:var(--dim); letter-spacing:.06em;}
.bj-simstats b{font-size:.82rem; font-weight:800;}
.bj-simstats b.pos{color:var(--green);} .bj-simstats b.neg{color:var(--red);}
.bj-simpanel{position:fixed; left:50%; transform:translateX(-50%); bottom:calc(14px + env(safe-area-inset-bottom));
  z-index:75; width:min(420px, calc(100vw - 24px)); background:#06230f; border:2px solid var(--yellow);
  border-radius:16px; padding:14px; display:flex; flex-direction:column; gap:8px; box-shadow:0 -8px 40px rgba(0,0,0,.6);}
.bj-simpanel-title{font-size:.62rem; letter-spacing:.24em; color:var(--yellow); font-weight:900; text-align:center;}
.bj-simstrat{display:flex; flex-direction:column; gap:3px; text-align:left; padding:10px 12px;
  border:1.5px solid #2c4a35; border-radius:10px; background:rgba(255,255,255,.03); color:var(--ink); cursor:pointer;}
.bj-simstrat.on{border-color:var(--yellow); background:rgba(247,215,116,.1);}
.bj-simstrat b{font-size:.74rem; font-weight:800;}
.bj-simstrat i{font-style:normal; font-size:.58rem; color:var(--dim); line-height:1.45;}
.bj-simamts{display:flex; align-items:center; gap:7px;}
.bj-simamts > span{font-size:.58rem; color:var(--dim); letter-spacing:.08em;}
.bj-simamt{flex:1; padding:9px 2px; border:1.5px solid #2c4a35; border-radius:9px; background:transparent;
  color:var(--ink); font-weight:800; font-size:.72rem; cursor:pointer; font-family:var(--mono);}
.bj-simamt.on{border-color:var(--yellow); background:rgba(247,215,116,.14); color:var(--yellow);}
.bj-simsides{display:flex; gap:8px; align-items:flex-start; font-size:.6rem; color:var(--dim);
  cursor:pointer; line-height:1.5; flex-wrap:wrap;}
.bj-simsides i{font-style:normal; color:#8fa3b8; width:100%; margin-left:22px; font-size:.54rem;}
.bj-simgo{display:flex; gap:8px;}
.bj-simcancel{flex:1; padding:11px; border:1.5px solid #2c4a35; border-radius:10px; background:transparent;
  color:var(--dim); font-weight:700; font-size:.72rem; cursor:pointer;}
.bj-simstart{flex:2; padding:11px; border:2px solid var(--yellow); border-radius:10px;
  background:linear-gradient(#8a6c1e,#5e4a12); color:#fff; font-weight:900; letter-spacing:.1em; font-size:.78rem; cursor:pointer;}

/* compact mobile: smaller cards + tighter spacing so nothing runs off-screen */
@media (max-width:480px){
  .bj-card{width:54px; height:78px; margin-right:-16px;}
  .bj-slot{width:54px; height:78px;}
  .bj-pip{font-size:1.5rem;}
  .bj-idx{font-size:.7rem;}
  .bj-dealer{min-height:112px; padding-top:12px;}
  .bj-cards{min-height:80px;}
  .bj-feltarc{padding:7px 18px; margin:4px 0 0;}
  .bj-feltline{font-size:.68rem; letter-spacing:.18em;}
  .bj-feltline.small{font-size:.5rem;}
  .bj-msg{min-height:24px; font-size:.78rem; padding:4px 12px;}
  .bj-hands{gap:14px;}
  .bj-side{min-width:104px; padding:7px 8px;}
  .bj-side-lbl{font-size:.52rem;}
  .bj-btn{padding:12px 14px; font-size:.74rem;}
  .bj-chip{width:40px; height:40px; font-size:.64rem;}
  .bj-rack{padding-bottom:26px;}
  .bj-shoebar{width:120px;}
}
`;
