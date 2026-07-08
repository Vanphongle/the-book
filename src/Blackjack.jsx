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
function Card({ c, hidden, fresh }) {
  const red = c && (c.s === "♥" || c.s === "♦");
  return (
    <div className={cx("bj-card", fresh && "fresh")}>
      <div className={cx("bj-flip", hidden && "down")}>
        <div className={cx("bj-face bj-front", red && "red")}>
          <span className="bj-idx">{c?.r}<em>{c?.s}</em></span>
          <span className="bj-pip">{c?.s}</span>
          <span className="bj-idx flip2">{c?.r}<em>{c?.s}</em></span>
        </div>
        <div className="bj-face bj-back"><i /></div>
      </div>
    </div>
  );
}

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
    phase: "bet", // bet | dealing | insurance | player | dealer | done
    dealer: { cards: [], hidden: true },
    hands: [], // {cards, bet, doubled, done, busted, surrendered, fromSplit, splitAces, result}
    active: 0,
    lastBet: 0,
    freshIds: new Set(),
    msg: "Place your bet.",
  });
  const [, setTick] = useState(0);
  const rr = () => { if (aliveRef.current) setTick((t) => t + 1); };
  const [bet, setBet] = useState(0);
  const [chip, setChip] = useState(25);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const g = G.current;
  const cardsLeft = g.shoe.length;
  const cutCard = Math.floor(52 * decks * 0.25);

  function draw() {
    if (!g.shoe.length) g.shoe = newShoe(decks); // safety: never run dry mid-hand
    return g.shoe.pop();
  }

  async function dealCard(target, { hidden = false, pause = 330 } = {}) {
    const c = draw();
    c.id = Math.random();
    target.push(Object.assign(c, hidden ? { hidden: true } : null));
    g.freshIds = new Set([c.id]);
    rr();
    await sleep(pause);
    return c;
  }

  const activeHand = () => g.hands[g.active];

  // ── round flow ─────────────────────────────────────────────────────────────
  async function deal() {
    if (g.phase !== "bet" && g.phase !== "done") return;
    const b = bet || g.lastBet;
    if (!b) { g.msg = "Add chips to bet first."; rr(); return; }
    if (bankRef.current < b) { g.msg = "Not enough credits."; rr(); return; }

    // reshuffle at the cut card
    if (g.shoe.length < cutCard) {
      g.shoe = newShoe(decks);
      g.msg = "Shuffling a fresh shoe…";
      rr();
      await sleep(900);
    }

    payBank(-b);
    g.lastBet = b;
    setBet(0); // next round's DEAL with no chips = rebet the same amount
    g.phase = "dealing";
    g.dealer = { cards: [], hidden: true };
    g.hands = [{ cards: [], bet: b, doubled: false, done: false, busted: false, surrendered: false, fromSplit: false, splitAces: false, result: null }];
    g.active = 0;
    g.msg = "";
    rr();

    await dealCard(g.hands[0].cards);
    await dealCard(g.dealer.cards);
    await dealCard(g.hands[0].cards);
    await dealCard(g.dealer.cards, { hidden: true });

    const up = g.dealer.cards[0];
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
      g.phase = "done";
      const playerBJ = isBJ(g.hands[0]);
      let note = "Dealer has blackjack.";
      if (ins) { payBank(ins * 3); note += ` Insurance pays ${money(ins * 2)}.`; }
      if (playerBJ) { payBank(b); g.hands[0].result = "push"; note += " Your blackjack pushes."; }
      else g.hands[0].result = "lose";
      g.msg = note;
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
      g.phase = "done";
      g.msg = `BLACKJACK! Pays ${money(win)}.`;
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
    await sleep(550);

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
    g.phase = "done";
    g.msg = notes.join(" · ");
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

  const betting = g.phase === "bet" || g.phase === "done";
  const dv = g.dealer.cards.length ? handValue(g.dealer.hidden ? [g.dealer.cards[0]] : g.dealer.cards) : null;

  const RES_TXT = { win: "WIN", lose: "LOSE", push: "PUSH", bj: "BLACKJACK", surr: "SURRENDER" };

  return (
    <div className="bj">
      <style>{CSS}</style>
      <header className="bj-top">
        <a className="bj-back" href="#">←</a>
        <span className="bj-title">BLACKJACK</span>
        <span className="bj-rules">{decks} decks · {h17 ? "H17" : "S17"} · BJ pays {pay32 ? "3:2" : "6:5"}</span>
        <span className="bj-shoe">🂠 {cardsLeft}</span>
        <span className="bj-meters">
          <span><b className="mono">{money(bank)}</b><i>credits</i></span>
        </span>
        <button className="bj-reset" onClick={resetBank}>Reset</button>
      </header>

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

        <div className={cx("bj-msg", g.phase === "done" && "big")}>{g.msg}&nbsp;</div>

      {/* player hands */}
      <section className="bj-player">
        <div className="bj-hands">
          {g.hands.map((h, i) => {
            const v = handValue(h.cards);
            return (
              <div key={i} className={cx("bj-hand", g.phase === "player" && i === g.active && !h.done && "live", h.result)}>
                <div className="bj-cards">
                  {h.cards.map((c, j) => (
                    <Card key={c.id || j} c={c} fresh={g.freshIds.has(c.id)} />
                  ))}
                </div>
                <div className="bj-hand-foot">
                  <span className={cx("bj-total", v.total > 21 && "bust")}>
                    {v.total}{v.soft && v.total <= 21 ? " soft" : ""}
                  </span>
                  <span className="bj-betchip">{money(h.bet)}</span>
                  {h.result && <span className={cx("bj-res", h.result)}>{RES_TXT[h.result]}</span>}
                </div>
              </div>
            );
          })}
          {!g.hands.length && <div className="bj-slot wide" />}
        </div>
      </section>
      </div>{/* /bj-table */}

      {/* actions */}
      <section className="bj-actions">
        {g.phase === "insurance" && (
          <>
            <button className="bj-btn ins" onClick={() => afterInsurance(true)}>INSURANCE {money(g.hands[0].bet / 2)}</button>
            <button className="bj-btn" onClick={() => afterInsurance(false)}>NO THANKS</button>
          </>
        )}
        {g.phase === "player" && (
          <>
            <button className="bj-btn hit" onClick={hit}>HIT</button>
            <button className="bj-btn stand" onClick={stand}>STAND</button>
            {canDouble() && <button className="bj-btn dbl" onClick={doubleDown}>DOUBLE</button>}
            {canSplit() && <button className="bj-btn split" onClick={split}>SPLIT</button>}
            {canSurrender() && <button className="bj-btn surr" onClick={surrender}>SURRENDER</button>}
          </>
        )}
        {betting && (
          <>
            <div className="bj-betbox">
              <span className="bj-betlbl">BET</span>
              <b className="mono">{money(bet || g.lastBet || 0)}</b>
              {bet > 0 && <button className="bj-clearbet" onClick={() => setBet(0)}>clear</button>}
            </div>
            <button className="bj-btn deal" onClick={deal}>
              {g.phase === "done" && !bet ? "REBET & DEAL" : "DEAL"}
            </button>
          </>
        )}
      </section>

      {/* chip rack */}
      {betting && (
        <footer className="bj-rack">
          {CHIPS.map((c) => (
            <button
              key={c}
              className={cx("bj-chip", `c${c}`, chip === c && "sel")}
              onClick={() => { setChip(c); if (bankRef.current >= (bet + c)) setBet(bet + c); }}
            >
              ${c}
            </button>
          ))}
          <span className="bj-settings">
            <label>
              decks
              <select value={decks} onChange={(e) => { setDecks(+e.target.value); G.current.shoe = newShoe(+e.target.value); rr(); }}>
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
  font-family:var(--sans); color:var(--ink); min-height:100vh; user-select:none;
  background:radial-gradient(ellipse at 50% -10%, #14754e, var(--felt) 45%, var(--feltdark));
  -webkit-font-smoothing:antialiased; display:flex; flex-direction:column;
}
.bj *{box-sizing:border-box;}
.bj .mono{font-family:var(--mono); font-variant-numeric:tabular-nums;}

.bj-top{display:flex; align-items:center; gap:12px; padding:10px 14px; background:rgba(0,0,0,.28); flex-wrap:wrap;}
.bj-back{color:var(--dim); text-decoration:none; font-size:1rem;}
.bj-title{font-size:.78rem; letter-spacing:.22em; color:var(--yellow); font-weight:800;}
.bj-rules{font-size:.62rem; color:var(--dim); letter-spacing:.04em;}
.bj-shoe{font-size:.72rem; color:var(--dim); margin-left:auto;}
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
.bj-card{width:66px; height:94px; margin-right:-18px; perspective:400px; filter:drop-shadow(0 4px 6px rgba(0,0,0,.45));}
.bj-card.fresh{animation:bj-dealin .32s cubic-bezier(.2,.8,.3,1);}
@keyframes bj-dealin{from{transform:translate(60px,-70px) rotate(8deg); opacity:0;} to{transform:none; opacity:1;}}
.bj-flip{position:relative; width:100%; height:100%; transform-style:preserve-3d; transition:transform .45s cubic-bezier(.6,0,.3,1);}
.bj-flip.down{transform:rotateY(180deg);}
.bj-face{position:absolute; inset:0; backface-visibility:hidden; border-radius:9px; border:1px solid #b9b2a2;}
.bj-front{background:linear-gradient(150deg,#fdfbf4,#efe9dc); color:#1d232b; display:flex; align-items:center; justify-content:center;}
.bj-front.red{color:#c22c24;}
.bj-idx{position:absolute; top:5px; left:6px; font-size:.82rem; font-weight:800; line-height:.95; text-align:center; font-family:Georgia,serif;}
.bj-idx em{display:block; font-style:normal; font-size:.7rem;}
.bj-idx.flip2{top:auto; left:auto; bottom:5px; right:6px; transform:rotate(180deg);}
.bj-pip{font-size:2rem;}
.bj-back{background:#27456b; transform:rotateY(180deg); display:flex; align-items:center; justify-content:center;}
.bj-back i{position:absolute; inset:5px; border-radius:6px; border:2px solid rgba(255,255,255,.35);
  background:repeating-linear-gradient(45deg, #2e5280 0 6px, #27456b 6px 12px);}

/* hands */
.bj-hands{display:flex; gap:26px; flex-wrap:wrap; align-items:flex-end; justify-content:center;}
.bj-hand{padding:8px 10px 9px; border-radius:12px; border:2px solid transparent;}
.bj-hand.live{border-color:var(--yellow); background:rgba(247,215,116,.07);}
.bj-hand.win,.bj-hand.bj{border-color:var(--green);}
.bj-hand.lose{opacity:.75;}
.bj-hand-foot{display:flex; align-items:center; gap:8px; margin-top:8px;}
.bj-total{font-family:var(--mono); font-weight:800; font-size:.8rem; background:rgba(0,0,0,.3); border-radius:6px; padding:2px 7px;}
.bj-total.bust{color:var(--red);}
.bj-betchip{font-family:var(--mono); font-size:.68rem; font-weight:800; color:#241c05;
  background:radial-gradient(circle at 40% 35%, #ffe9a8, #d4a940); border:2px dashed #8a6c1e; border-radius:12px; padding:2px 8px;}
.bj-res{font-size:.6rem; font-weight:900; letter-spacing:.08em; padding:3px 7px; border-radius:6px;}
.bj-res.win,.bj-res.bj{background:var(--green); color:#06230f;}
.bj-res.lose{background:var(--red); color:#fff;}
.bj-res.push,.bj-res.surr{background:#8fa3b8; color:#101820;}

.bj-msg{padding:6px 18px; min-height:30px; font-size:.86rem; color:var(--yellow); font-weight:600; text-align:center;}
.bj-msg.big{font-size:1rem;}

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
`;
