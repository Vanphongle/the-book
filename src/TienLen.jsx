import { useState, useEffect, useRef } from "react";

// ─── TIẾN LÊN (miền Nam) ──────────────────────────────────────────────────────
// Vietnam's national card game — you vs three AI, phone-first:
//   • 52 cards, 13 each · rank 3<4<…<K<A<2 · suits ♠<♣<♦<♥ break ties
//   • Combos: single · pair · triple · tứ quý · sảnh (3+ run, no 2s) ·
//     đôi thông (3+ consecutive pairs, no 2s)
//   • Chops (chặt): 3 đôi thông chops a single 2 · tứ quý chops single/pair 2s
//     and 3 đôi thông · 4 đôi thông chops all of those
//   • 3♠ holder leads the first trick and must include the 3♠
//   • Betting: 1st +3×, 2nd +1×, 3rd −1×, 4th −3× the stake
// Play money only (localStorage) — nothing here touches The Book's data.

const LS_BANK = "the-book.tienlen.bank.v1";
const START_BANK = 10000;
const CHIPS = [5, 10, 25, 100];
const NAMES = ["You", "Anh Hai", "Chị Ba", "Chú Tư"];

const SUIT_TXT = ["♠", "♣", "♦", "♥"];
const isRedSuit = (s) => s >= 2;
const rankTxt = (r) => (r <= 10 ? String(r) : { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2" }[r]);
const val = (c) => c.r * 4 + c.s;

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newDeck() {
  const d = [];
  for (let r = 3; r <= 15; r++) for (let s = 0; s < 4; s++) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
const sortHand = (h) => [...h].sort((a, b) => val(a) - val(b));

// ── combo classification & comparison ────────────────────────────────────────
function classify(cards) {
  if (!cards.length) return null;
  const cs = sortHand(cards);
  const n = cs.length;
  const top = cs[n - 1];
  if (n === 1) return { type: "single", cards: cs, top };
  const sameRank = cs.every((c) => c.r === cs[0].r);
  if (sameRank && n === 2) return { type: "pair", cards: cs, top };
  if (sameRank && n === 3) return { type: "triple", cards: cs, top };
  if (sameRank && n === 4) return { type: "quad", cards: cs, top };
  // straight (no 2s, distinct consecutive ranks)
  if (n >= 3) {
    let run = true;
    for (let i = 0; i < n; i++) {
      if (cs[i].r === 15) run = false;
      if (i > 0 && cs[i].r !== cs[i - 1].r + 1) run = false;
    }
    if (run) return { type: "run", len: n, cards: cs, top };
  }
  // double run (3+ consecutive pairs, no 2s)
  if (n >= 6 && n % 2 === 0) {
    let ok = true;
    for (let i = 0; i < n; i += 2) {
      if (cs[i].r !== cs[i + 1].r || cs[i].r === 15) ok = false;
      if (i > 0 && cs[i].r !== cs[i - 2].r + 1) ok = false;
    }
    if (ok) return { type: "drun", pairs: n / 2, cards: cs, top };
  }
  return null;
}
const bombPower = (c) =>
  !c ? 0 : c.type === "drun" && c.pairs === 3 ? 1 : c.type === "quad" ? 2 : c.type === "drun" && c.pairs >= 4 ? 3 : 0;

function canBeat(play, cur) {
  if (!play) return false;
  if (!cur) return true; // leading — anything valid
  const pb = bombPower(play), cb = bombPower(cur);
  // chops on 2s
  if (cur.type === "single" && cur.top.r === 15 && pb >= 1) return true;
  if (cur.type === "pair" && cur.top.r === 15 && pb >= 2) return true;
  if (cb > 0) {
    if (pb > cb) return true;
    if (pb === cb && play.type === cur.type && (play.pairs || 0) === (cur.pairs || 0))
      return val(play.top) > val(cur.top);
    return false;
  }
  if (pb > 0) return false; // bombs don't beat ordinary plays (only 2s / bombs)
  if (play.type !== cur.type) return false;
  if (play.type === "run" && play.len !== cur.len) return false;
  if (play.type === "drun" && play.pairs !== cur.pairs) return false;
  return val(play.top) > val(cur.top);
}

// ── move generation (for the AI) ─────────────────────────────────────────────
function groupsByRank(hand) {
  const g = {};
  for (const c of sortHand(hand)) (g[c.r] = g[c.r] || []).push(c);
  return g;
}
function genSingles(hand) { return sortHand(hand).map((c) => [c]); }
function genOfAKind(hand, k) {
  const g = groupsByRank(hand);
  const out = [];
  for (const r of Object.keys(g).map(Number).sort((a, b) => a - b))
    if (g[r].length >= k) out.push(g[r].slice(0, k));
  return out;
}
function genRuns(hand, len) {
  const g = groupsByRank(hand);
  const ranks = Object.keys(g).map(Number).filter((r) => r < 15).sort((a, b) => a - b);
  const out = [];
  for (const start of ranks) {
    const seq = [];
    for (let r = start; r < start + len; r++) {
      if (!g[r]) { seq.length = 0; break; }
      seq.push(g[r][0]);
    }
    if (seq.length === len) out.push(seq);
  }
  return out;
}
function genDruns(hand, pairs) {
  const g = groupsByRank(hand);
  const ranks = Object.keys(g).map(Number).filter((r) => r < 15).sort((a, b) => a - b);
  const out = [];
  for (const start of ranks) {
    const seq = [];
    for (let r = start; r < start + pairs; r++) {
      if (!g[r] || g[r].length < 2) { seq.length = 0; break; }
      seq.push(g[r][0], g[r][1]);
    }
    if (seq.length === pairs * 2) out.push(seq);
  }
  return out;
}
function genAllBombs(hand) {
  return [...genOfAKind(hand, 4), ...genDruns(hand, 3), ...genDruns(hand, 4)];
}

// candidate plays that beat `cur` (or leads when cur is null)
function candidates(hand, cur) {
  let cands = [];
  if (!cur) {
    // leading: everything reasonable
    for (let L = 6; L >= 3; L--) cands.push(...genRuns(hand, L));
    cands.push(...genDruns(hand, 3));
    cands.push(...genOfAKind(hand, 2), ...genOfAKind(hand, 3));
    cands.push(...genSingles(hand));
  } else if (cur.type === "single") cands = genSingles(hand);
  else if (cur.type === "pair") cands = genOfAKind(hand, 2);
  else if (cur.type === "triple") cands = genOfAKind(hand, 3);
  else if (cur.type === "quad") cands = genOfAKind(hand, 4);
  else if (cur.type === "run") cands = genRuns(hand, cur.len);
  else if (cur.type === "drun") cands = genDruns(hand, cur.pairs);
  if (cur) cands.push(...genAllBombs(hand)); // chops are always on the table
  const seen = new Set();
  const out = [];
  for (const cs of cands) {
    const cl = classify(cs);
    if (!cl || !canBeat(cl, cur)) continue;
    const key = cl.cards.map(val).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cl);
  }
  return out;
}

// AI: cheapest beating play, hoarding 2s and bombs unless needed / endgame
function aiChoose(hand, cur, mustInclude3S) {
  let cands = candidates(hand, cur);
  if (mustInclude3S) cands = cands.filter((c) => c.cards.some((x) => x.r === 3 && x.s === 0));
  if (!cands.length) return null;
  const score = (c) => {
    let s = val(c.top);
    const twos = c.cards.filter((x) => x.r === 15).length;
    if (hand.length > 4) s += twos * 200; // don't burn 2s early
    if (bombPower(c) > 0 && !(cur && (bombPower(cur) > 0 || cur.top.r === 15))) s += 400; // save bombs for chopping
    if (!cur) s -= c.cards.length * 30; // when leading, shed more cards
    return s;
  };
  cands.sort((a, b) => score(a) - score(b));
  return cands[0];
}

// ── card face ────────────────────────────────────────────────────────────────
function CardFace({ c, sel, onClick, small }) {
  return (
    <button className={cx("tl-card", small && "small", sel && "sel", isRedSuit(c.s) && "red")} onClick={onClick}>
      <span className="tl-card-r">{rankTxt(c.r)}</span>
      <span className="tl-card-s">{SUIT_TXT[c.s]}</span>
    </button>
  );
}

export default function TienLen() {
  const [bank, setBank] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS_BANK));
    return v > 0 ? v : START_BANK;
  });
  useEffect(() => localStorage.setItem(LS_BANK, String(bank)), [bank]);
  const bankRef = useRef(bank);
  const payBank = (d) => { bankRef.current += d; setBank(bankRef.current); };

  const G = useRef({
    phase: "bet", // bet | play | done
    hands: [[], [], [], []],
    turn: 0,
    cur: null, // current combo on the table (+ owner)
    owner: -1,
    pile: [], // plays of the current trick (for the stacked middle)
    playSeq: 0,
    passed: new Set(),
    finished: [],
    first: false, // must include 3♠
    bet: 10,
    msg: "Set your stake and deal.",
    results: null,
    winKey: 0,
  });
  const [tick, setTick] = useState(0);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const rr = () => { if (aliveRef.current) setTick((t) => t + 1); };
  const [sel, setSel] = useState(new Set()); // selected card values
  const g = G.current;

  async function deal() {
    if (g.phase !== "bet" && g.phase !== "done") return;
    if (bankRef.current < g.bet * 3) { g.msg = "Need 3× the stake to play."; rr(); return; }
    g.results = null;
    g.pile = [];
    g.cur = null;
    g.hands = [[], [], [], []];
    g.finished = [];
    g.passed = new Set();
    g.phase = "shuffle";
    g.msg = "Shuffling…";
    setSel(new Set());
    rr();
    await sleep(950);
    if (!aliveRef.current) return;
    g.phase = "dealing";
    g.msg = "Dealing…";
    rr();
    await sleep(1150);
    if (!aliveRef.current) return;
    const deck = newDeck();
    g.hands = [0, 1, 2, 3].map((i) => sortHand(deck.slice(i * 13, i * 13 + 13)));
    g.owner = -1;
    // 3♠ leads
    g.turn = g.hands.findIndex((h) => h.some((c) => c.r === 3 && c.s === 0));
    g.first = true;
    g.phase = "play";
    g.msg = g.turn === 0 ? "You have the 3♠ — lead with it." : `${NAMES[g.turn]} leads with the 3♠…`;
    rr();
  }

  // trick/turn advance after player i played (or passed)
  function nextActor(from) {
    for (let step = 1; step <= 4; step++) {
      const j = (from + step) % 4;
      if (g.finished.includes(j)) continue;
      if (j === g.owner) {
        // everyone in between passed — trick cleared, owner leads
        clearTrick();
        return;
      }
      if (g.passed.has(j)) continue;
      g.turn = j;
      return;
    }
    clearTrick();
  }
  function clearTrick() {
    g.cur = null;
    g.pile = [];
    g.passed = new Set();
    let leader = g.owner;
    // if the trick winner already finished, lead passes to the next active player
    let guard = 0;
    while (g.finished.includes(leader) && guard++ < 5) leader = (leader + 1) % 4;
    g.turn = leader;
    g.msg = `${NAMES[leader] === "You" ? "You lead" : NAMES[leader] + " leads"} — new round.`;
  }

  function applyPlay(i, combo) {
    const ids = new Set(combo.cards.map(val));
    g.hands[i] = g.hands[i].filter((c) => !ids.has(val(c)));
    g.cur = combo;
    g.owner = i;
    g.pile = [...g.pile, { cards: combo.cards, owner: i, key: g.playSeq++ }].slice(-5);
    g.first = false;
    g.passed = new Set();
    const bomb = bombPower(combo) > 0;
    g.msg = `${NAMES[i]}: ${describe(combo)}${bomb ? " — CHẶT! 💥" : ""}`;
    if (g.hands[i].length === 0) {
      g.finished.push(i);
      g.msg = `${NAMES[i]} ${i === 0 ? "went out" : "hết bài"} — ${place(g.finished.length)}!`;
      if (g.finished.length === 3 || (i === 0 && g.finished.length === 1)) {
        // end when 3 done, or fast-settle remaining AI order when you finish first
        return endGame();
      }
    }
    nextActor(i);
    rr();
  }

  function endGame() {
    // rank remaining players by cards left (fewer = better)
    const remaining = [0, 1, 2, 3].filter((i) => !g.finished.includes(i));
    remaining.sort((a, b) => g.hands[a].length - g.hands[b].length);
    const order = [...g.finished, ...remaining];
    const payouts = [3, 1, -1, -3].map((m) => m * g.bet);
    const mine = order.indexOf(0);
    payBank(payouts[mine]);
    g.results = order.map((p, idx) => ({ who: NAMES[p], place: idx + 1, pay: p === 0 ? payouts[idx] : null }));
    g.phase = "done";
    g.winKey = Math.random();
    g.myPlace = mine + 1;
    g.myPay = payouts[mine];
    g.msg = `${place(mine + 1)} — ${payouts[mine] >= 0 ? "+" : "−"}${money(Math.abs(payouts[mine]))}`;
    if (bankRef.current < CHIPS[0] * 3) {
      payBank(START_BANK - bankRef.current);
      g.msg += " · Busted — bankroll refilled to $10,000.";
    }
    rr();
  }
  const place = (n) => ["🥇 1st", "🥈 2nd", "🥉 3rd", "4th"][n - 1];
  function describe(c) {
    const t = { single: "", pair: "pair of ", triple: "three ", quad: "TỨ QUÝ ", run: "straight to ", drun: `${c.pairs} đôi thông to ` }[c.type];
    return `${t}${rankTxt(c.top.r)}${SUIT_TXT[c.top.s]}`;
  }

  // ── human actions ──
  function toggle(c) {
    if (g.phase !== "play" || g.turn !== 0) return;
    const v = val(c);
    const n = new Set(sel);
    n.has(v) ? n.delete(v) : n.add(v);
    setSel(n);
  }
  function playSelected() {
    if (g.phase !== "play" || g.turn !== 0) return;
    const cards = g.hands[0].filter((c) => sel.has(val(c)));
    const combo = classify(cards);
    if (!combo) { g.msg = "That's not a valid combination."; rr(); return; }
    if (g.first && !cards.some((c) => c.r === 3 && c.s === 0)) { g.msg = "First play must include the 3♠."; rr(); return; }
    if (!canBeat(combo, g.cur)) { g.msg = g.cur ? `Doesn't beat ${describe(g.cur)}.` : "Invalid lead."; rr(); return; }
    setSel(new Set());
    applyPlay(0, combo);
  }
  function pass() {
    if (g.phase !== "play" || g.turn !== 0 || !g.cur) return;
    g.passed.add(0);
    g.msg = "You pass.";
    setSel(new Set());
    nextActor(0);
    rr();
  }

  // ── AI turns ──
  useEffect(() => {
    if (g.phase !== "play" || g.turn === 0) return;
    const i = g.turn;
    const t = setTimeout(() => {
      if (g.phase !== "play" || g.turn !== i) return;
      const combo = aiChoose(g.hands[i], g.cur, g.first);
      if (combo) applyPlay(i, combo);
      else {
        g.passed.add(i);
        g.msg = `${NAMES[i]} passes.`;
        nextActor(i);
        rr();
      }
    }, 750);
    return () => clearTimeout(t);
  }, [tick]); // eslint-disable-line

  function resetBank() {
    if (g.phase === "play") return;
    if (!window.confirm("Reset play bankroll to $10,000?")) return;
    payBank(START_BANK - bankRef.current);
    g.msg = "Fresh bankroll.";
    rr();
  }

  const myTurn = g.phase === "play" && g.turn === 0;
  const selCards = g.hands[0].filter((c) => sel.has(val(c)));
  const selCombo = classify(selCards);
  const selOk = selCombo && canBeat(selCombo, g.cur) && (!g.first || selCards.some((c) => c.r === 3 && c.s === 0));

  return (
    <div className="tl">
      <style>{CSS}</style>
      <header className="tl-top">
        <a className="tl-back" href="#">←</a>
        <span className="tl-title">TIẾN LÊN</span>
        <span className="tl-meters">
          <b className="mono">{money(bank)}</b><i>credits</i>
        </span>
        <button className="tl-reset" onClick={resetBank}>Reset</button>
      </header>

      {/* opponents */}
      <div className="tl-opps">
        {[1, 2, 3].map((i) => (
          <div key={i} className={cx("tl-opp", g.phase === "play" && g.turn === i && "turn",
            g.finished.includes(i) && "out", g.passed.has(i) && "passed")}>
            <b>{NAMES[i]}</b>
            <span className="tl-opp-fan">
              {Array.from({ length: Math.min(13, g.hands[i].length) }, (_, k) => (
                <i key={k} style={{ left: k * 5, transform: `rotate(${(k - g.hands[i].length / 2) * 2}deg)` }} />
              ))}
              <u>{g.hands[i].length}</u>
            </span>
            {g.finished.includes(i) && <em>{place(g.finished.indexOf(i) + 1)}</em>}
            {g.passed.has(i) && !g.finished.includes(i) && <em className="p">pass</em>}
          </div>
        ))}
      </div>

      {/* table */}
      <div className="tl-table">
        {g.phase === "shuffle" && (
          <div className="tl-shuffle">
            {[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className={`tl-backcard sh${i % 3}`} style={{ animationDelay: `${i * 90}ms` }} />)}
          </div>
        )}
        {g.phase === "dealing" && (
          <div className="tl-dealfx">
            <span className="tl-backcard deck" />
            {Array.from({ length: 16 }, (_, i) => (
              <span key={i} className={`tl-backcard flyout seat${i % 4}`} style={{ animationDelay: `${i * 65}ms` }} />
            ))}
          </div>
        )}
        {g.pile.length > 0 ? (
          <>
            <div className="tl-pilestack">
              {g.pile.map((p, idx, arr) => (
                <div
                  key={p.key}
                  className={cx("tl-flywrap", idx === arr.length - 1 && `flyin seat${p.owner}`)}
                  style={{ zIndex: idx, opacity: idx === arr.length - 1 ? 1 : 0.45 }}
                >
                  <div className="tl-pileplay" style={{ transform: `translate(-50%,-50%) rotate(${((p.key * 47) % 13) - 6}deg) translate(${((p.key * 31) % 11) - 5}px, ${((p.key * 17) % 7) - 3}px) scale(${idx === arr.length - 1 ? 1 : 0.92})` }}>
                    {p.cards.map((c) => <CardFace key={val(c)} c={c} small />)}
                  </div>
                </div>
              ))}
            </div>
            <div className="tl-pile-owner">{NAMES[g.owner]}{bombPower(g.cur) > 0 ? " 💥" : ""}</div>
          </>
        ) : (
          g.phase !== "shuffle" && g.phase !== "dealing" && (
            <div className="tl-pile-empty">{g.phase === "play" ? "new round — lead anything" : ""}</div>
          )
        )}
      </div>

      <div className="tl-msg">{g.msg}&nbsp;</div>

      {g.phase === "done" && g.myPay > 0 && (
        <div className="tl-winpop" key={g.winKey}>
          <span className="tl-winpop-t">{place(g.myPlace)}</span>
          <span className="tl-winpop-amt mono">+{money(g.myPay)}</span>
        </div>
      )}

      {/* my hand */}
      <div className={cx("tl-hand", myTurn && "myturn")}>
        {g.hands[0].map((c) => (
          <CardFace key={val(c)} c={c} sel={sel.has(val(c))} onClick={() => toggle(c)} />
        ))}
        {g.phase !== "play" && g.hands[0].length === 0 && (
          <div className="tl-hand-empty">tap DEAL to play</div>
        )}
      </div>

      {/* controls */}
      <footer className="tl-controls">
        {g.phase === "play" ? (
          <>
            <button className="tl-btn pass" disabled={!myTurn || !g.cur} onClick={pass}>PASS</button>
            <button className={cx("tl-btn play", selOk && "ok")} disabled={!myTurn || !selOk} onClick={playSelected}>
              PLAY {selCards.length > 0 && selCombo ? `· ${describe(selCombo)}` : ""}
            </button>
          </>
        ) : (
          <>
            <span className="tl-stake">
              stake
              {CHIPS.map((c) => (
                <button key={c} className={cx("tl-chip", g.bet === c && "sel")} onClick={() => { g.bet = c; rr(); }}>
                  ${c}
                </button>
              ))}
              <button className={cx("tl-chip call", !CHIPS.includes(g.bet) && "sel")}
                onClick={() => { g.bet = Math.max(5, Math.floor(bankRef.current / 3)); rr(); }}>
                ALL
              </button>
            </span>
            <button className="tl-btn deal" onClick={deal}>DEAL · win +{money(g.bet * 3)}</button>
          </>
        )}
      </footer>
    </div>
  );
}

const CSS = `
.tl{
  --felt:#1a2a4a; --feltdark:#0d1626; --gold:#e8c56b; --red:#e05a50; --green:#57c07a;
  --ink:#eef0f6; --dim:#a8b3cc;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  font-family:var(--sans); color:var(--ink); min-height:100vh; min-height:100dvh; user-select:none;
  background:radial-gradient(ellipse at 50% -10%, #2a4272, var(--felt) 45%, var(--feltdark));
  display:flex; flex-direction:column; -webkit-font-smoothing:antialiased;
}
.tl *{box-sizing:border-box;}
.tl .mono{font-family:var(--mono); font-variant-numeric:tabular-nums;}

.tl-top{display:flex; align-items:center; gap:12px; padding:10px 14px; background:rgba(0,0,0,.32);}
.tl-back{color:var(--dim); text-decoration:none; font-size:1rem;}
.tl-title{font-size:.78rem; letter-spacing:.24em; color:var(--gold); font-weight:800;}
.tl-meters{display:flex; flex-direction:column; align-items:flex-end; margin-left:auto;}
.tl-meters b{font-size:.9rem;}
.tl-meters i{font-style:normal; font-size:.52rem; text-transform:uppercase; letter-spacing:.12em; color:#7d89a8;}
.tl-reset{background:transparent; border:1px solid #3a4a6b; color:#9aa8c8; border-radius:8px; padding:6px 10px; font-size:.66rem; cursor:pointer;}

.tl-opps{display:grid; grid-template-columns:repeat(3,1fr); gap:8px; padding:10px 12px 2px;}
.tl-opp{position:relative; border:1.5px solid #3a4a6b; border-radius:12px; padding:8px 10px; background:rgba(0,0,0,.2);
  display:flex; flex-direction:column; gap:2px; transition:all .2s;}
.tl-opp b{font-size:.72rem;}
.tl-opp-cards{font-size:.68rem; color:var(--dim);}
.tl-opp.turn{border-color:var(--gold); box-shadow:0 0 12px rgba(232,197,107,.35);}
.tl-opp.passed{opacity:.55;}
.tl-opp.out{border-color:var(--green);}
.tl-opp em{position:absolute; top:-8px; right:-4px; font-style:normal; font-size:.56rem; font-weight:900;
  background:var(--green); color:#06230f; border-radius:6px; padding:2px 6px;}
.tl-opp em.p{background:#7d89a8; color:#101623;}
.tl-opp-fan{position:relative; height:30px; margin-top:3px; display:block;}
.tl-opp-fan i{position:absolute; top:2px; width:17px; height:24px; border-radius:3px;
  background:#27456b; border:1px solid rgba(255,255,255,.4);
  background-image:repeating-linear-gradient(45deg,#2e5280 0 3px,#27456b 3px 6px); box-shadow:0 1px 2px rgba(0,0,0,.4);}
.tl-opp-fan u{position:absolute; right:2px; top:5px; text-decoration:none; font-size:.68rem; font-weight:800;
  color:var(--gold); font-family:var(--mono); text-shadow:0 1px 2px rgba(0,0,0,.7);}

/* card backs + shuffle + dealing fx */
.tl-backcard{width:44px; height:62px; border-radius:6px; background:#27456b; border:1.5px solid rgba(255,255,255,.45);
  background-image:repeating-linear-gradient(45deg,#2e5280 0 5px,#27456b 5px 10px); box-shadow:0 3px 7px rgba(0,0,0,.5); display:inline-block;}
.tl-shuffle{position:relative; width:120px; height:70px;}
.tl-shuffle .tl-backcard{position:absolute; left:38px; top:0;}
.tl-shuffle .sh0{animation:tl-riffle0 .5s infinite alternate ease-in-out;}
.tl-shuffle .sh1{animation:tl-riffle1 .5s infinite alternate-reverse ease-in-out;}
.tl-shuffle .sh2{animation:tl-riffle2 .45s infinite alternate ease-in-out;}
@keyframes tl-riffle0{from{transform:translateX(-26px) rotate(-9deg);} to{transform:translateX(4px) rotate(2deg);}}
@keyframes tl-riffle1{from{transform:translateX(26px) rotate(9deg);} to{transform:translateX(-4px) rotate(-2deg);}}
@keyframes tl-riffle2{from{transform:translateY(-7px) rotate(3deg);} to{transform:translateY(5px) rotate(-4deg);}}
.tl-dealfx{position:relative; width:60px; height:70px;}
.tl-dealfx .deck{position:absolute; left:8px; top:4px;}
.tl-dealfx .flyout{position:absolute; left:8px; top:4px; opacity:0; animation:none;}
.tl-dealfx .flyout.seat0{animation:tl-deal0 .55s ease-in forwards;}
.tl-dealfx .flyout.seat1{animation:tl-deal1 .55s ease-in forwards;}
.tl-dealfx .flyout.seat2{animation:tl-deal2 .55s ease-in forwards;}
.tl-dealfx .flyout.seat3{animation:tl-deal3 .55s ease-in forwards;}
@keyframes tl-deal0{0%{opacity:1; transform:none;} 100%{opacity:0; transform:translate(0,46vh) scale(.6) rotate(20deg);}}
@keyframes tl-deal1{0%{opacity:1; transform:none;} 100%{opacity:0; transform:translate(-36vw,-16vh) scale(.5) rotate(-30deg);}}
@keyframes tl-deal2{0%{opacity:1; transform:none;} 100%{opacity:0; transform:translate(0,-18vh) scale(.5) rotate(15deg);}}
@keyframes tl-deal3{0%{opacity:1; transform:none;} 100%{opacity:0; transform:translate(36vw,-16vh) scale(.5) rotate(30deg);}}

/* played combos fly in from their seat and stack on the pile */
.tl-pilestack{position:relative; width:100%; min-height:80px;}
.tl-flywrap{position:absolute; left:50%; top:50%; transition:opacity .3s;}
.tl-flywrap.flyin.seat0{animation:tl-fly0 .38s cubic-bezier(.2,.8,.3,1);}
.tl-flywrap.flyin.seat1{animation:tl-fly1 .38s cubic-bezier(.2,.8,.3,1);}
.tl-flywrap.flyin.seat2{animation:tl-fly2 .38s cubic-bezier(.2,.8,.3,1);}
.tl-flywrap.flyin.seat3{animation:tl-fly3 .38s cubic-bezier(.2,.8,.3,1);}
@keyframes tl-fly0{from{transform:translate(0,40vh) scale(.75); opacity:.4;}}
@keyframes tl-fly1{from{transform:translate(-38vw,-16vh) scale(.7); opacity:.4;}}
@keyframes tl-fly2{from{transform:translate(0,-18vh) scale(.7); opacity:.4;}}
@keyframes tl-fly3{from{transform:translate(38vw,-16vh) scale(.7); opacity:.4;}}
.tl-pileplay{display:flex;}

.tl-table{min-height:110px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; padding:8px;}
.tl-pile{display:flex;}
.tl-pileplay{padding-right:12px;}
.tl-pileplay .tl-card{cursor:default;}
.tl-pile-owner{font-size:.62rem; color:var(--gold); font-weight:800; letter-spacing:.1em;}
.tl-pile-empty{color:#5d6c8f; font-size:.74rem;}

.tl-msg{min-height:24px; text-align:center; font-size:.8rem; color:var(--gold); font-weight:700; padding:0 12px;}

.tl-winpop{position:fixed; top:32%; left:50%; transform:translate(-50%,-50%); z-index:70; pointer-events:none;
  display:flex; flex-direction:column; align-items:center; gap:2px;
  background:rgba(8,12,26,.9); border:2px solid var(--gold); border-radius:16px; padding:14px 30px;
  animation:tl-pop .5s cubic-bezier(.2,1.6,.4,1), tl-fade .4s ease 2s forwards;}
.tl-winpop-t{font-size:.8rem; letter-spacing:.2em; color:var(--gold); font-weight:900;}
.tl-winpop-amt{font-size:1.7rem; font-weight:800; color:var(--gold); text-shadow:0 0 18px rgba(232,197,107,.6);}
@keyframes tl-pop{from{transform:translate(-50%,-50%) scale(.4); opacity:0;} 70%{transform:translate(-50%,-50%) scale(1.1);} to{transform:translate(-50%,-50%) scale(1); opacity:1;}}
@keyframes tl-fade{to{opacity:0;}}

.tl-hand{flex:1; display:flex; flex-wrap:wrap; align-content:flex-end; justify-content:center; padding:6px 10px 14px;
  border-top:1px dashed rgba(232,197,107,.25); margin-top:4px;}
.tl-hand.myturn{background:linear-gradient(transparent, rgba(232,197,107,.06));}
.tl-hand-empty{color:#5d6c8f; font-size:.78rem; align-self:center;}
.tl-card{position:relative; width:52px; height:74px; margin:4px -5px 4px 0; border-radius:8px;
  border:1px solid #b9b2a2; background:linear-gradient(150deg,#fdfbf4,#efe9dc); color:#1d232b;
  display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer;
  font-family:Georgia,serif; box-shadow:0 2px 5px rgba(0,0,0,.4); transition:transform .12s; padding:0;}
.tl-card.red{color:#c22c24;}
.tl-card.sel{transform:translateY(-16px); box-shadow:0 6px 12px rgba(0,0,0,.5), 0 0 0 2.5px var(--gold);}
.tl-card.small{width:42px; height:58px; margin:0 -12px 0 0;}
.tl-card-r{font-size:1.1rem; font-weight:800; line-height:1;}
.tl-card-s{font-size:1rem; line-height:1.1;}
.tl-hand .tl-card{touch-action:manipulation;}

.tl-controls{display:flex; align-items:center; gap:9px; padding:8px 14px calc(16px + env(safe-area-inset-bottom));
  background:rgba(0,0,0,.28); flex-wrap:wrap; justify-content:center;}
.tl-btn{padding:13px 18px; border-radius:11px; border:2px solid #3a4a6b; background:rgba(0,0,0,.25);
  color:var(--ink); font-weight:900; letter-spacing:.06em; font-size:.8rem; cursor:pointer; font-family:var(--sans);}
.tl-btn:disabled{opacity:.4; cursor:default;}
.tl-btn.pass{border-color:var(--red); color:#ffb9b2;}
.tl-btn.play.ok{border-color:var(--gold); background:linear-gradient(#8a6c1e,#5e4a12); color:#fff;}
.tl-btn.deal{border-color:var(--gold); background:linear-gradient(#8a6c1e,#5e4a12); color:#fff; padding:13px 26px;}
.tl-stake{display:flex; align-items:center; gap:6px; font-size:.62rem; color:var(--dim);}
.tl-chip.call{background:linear-gradient(140deg,#d4a940,#7a5c10); font-size:.5rem; letter-spacing:.04em;}
.tl-chip{width:40px; height:40px; border-radius:50%; border:2.5px dashed rgba(255,255,255,.55);
  background:#22335a; color:#fff; font-weight:800; font-size:.64rem; cursor:pointer;}
.tl-chip.sel{outline:3px solid var(--gold); outline-offset:2px; background:#31497e;}
`;
