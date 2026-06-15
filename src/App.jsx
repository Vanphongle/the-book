import { useState, useEffect, useMemo } from "react";
import {
  fetchBets,
  insertBet,
  updateBetOutcome,
  updateBetNote,
  deleteBet,
  clearBets,
  fetchPlayers,
  insertPlayer,
  updatePlayer,
  renameBetsPerson,
  subscribeChanges,
} from "./db";

const NEW_PLAYER = "__new__";

// The Book — quick settlement calculator
//   WIN       → pay 90% of the bet amount
//   HALF WIN  → pay half of the 90%  (= 45% of the bet)
//   HALF LOSE → collect half the bet amount
//   LOSE      → collect the full bet amount
//   PUSH (=)  → a draw: no win or lose, settles to $0
//   PENDING   → saved but not settled yet (counts for nothing until you pick)
// Typed amount is multiplied by the chosen ×1 / ×10 / ×100 at save time.
// Each bet line is saved to Supabase (see src/db.js).

const PAY_RATE = 0.9;
const MULTS = [1, 10, 100];

const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
};
const fmtMD = (d) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
const fmtDayHead = (d) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(d);

// Start of the week (Monday 00:00) that contains d.
function mondayOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  x.setDate(x.getDate() - dow);
  return x;
}
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

// Order comparator: by created_at, then id (ids encode submission order). The id
// tiebreak runs opposite to the time sort so submission order is preserved.
function cmpEntries(a, b, sort) {
  const c = (a.created_at || "").localeCompare(b.created_at || "");
  if (c !== 0) return sort === "new" ? -c : c;
  const t = (a.id || "").localeCompare(b.id || "");
  return sort === "new" ? t : -t;
}

// Returns how a bet settles: direction (collect/pay/pending), dollar value, and if it's a half result.
function settle(outcome, amount) {
  switch (outcome) {
    case "win":
      return { dir: "pay", value: amount * PAY_RATE, half: false };
    case "halfwin":
      return { dir: "pay", value: amount * PAY_RATE * 0.5, half: true };
    case "halflose":
      return { dir: "collect", value: amount * 0.5, half: true };
    case "lose":
      return { dir: "collect", value: amount, half: false };
    case "push":
      return { dir: "even", value: 0, half: false };
    case "pending":
    default:
      return { dir: "pending", value: 0, half: false };
  }
}

const OUTCOMES = [
  { key: "win", label: "Win", tone: "win" },
  { key: "halfwin", label: "½ Win", tone: "win" },
  { key: "push", label: "=", tone: "even" },
  { key: "halflose", label: "½ Lose", tone: "lose" },
  { key: "lose", label: "Lose", tone: "lose" },
];

// One editable line in the bulk add form. All rows in a save share the same person.
let rowSeq = 0;
const makeRow = () => ({ key: `r${rowSeq++}`, note: "", ratioSign: "+", ratio: "", mult: 100, amount: "" });

export default function App() {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");

  const [players, setPlayers] = useState([]);
  const [person, setPerson] = useState(""); // selected player name, or NEW_PLAYER
  const [newPlayer, setNewPlayer] = useState(""); // typed name when adding inline
  const [rows, setRows] = useState(() => [makeRow()]);
  const [showEarnings, setShowEarnings] = useState(false);
  const [showAdd, setShowAdd] = useState(true);
  const [sort, setSort] = useState("new"); // "new" = newest first, "old" = oldest first
  const [weekOffset, setWeekOffset] = useState(0); // 0 = this week, -1 = last week …
  const [collapsedDays, setCollapsedDays] = useState(() => new Set());
  const [editId, setEditId] = useState(null); // bet whose note is being edited
  const [editText, setEditText] = useState("");
  const [confirmId, setConfirmId] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Players drawer + the active player filter (null = all players).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filter, setFilter] = useState(null);
  const [addingPlayer, setAddingPlayer] = useState(false);
  const [drawerNewName, setDrawerNewName] = useState("");
  const [editPlayer, setEditPlayer] = useState(null); // player name being renamed
  const [editPlayerText, setEditPlayerText] = useState("");

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
    fetchPlayers()
      .then((rows) => alive && setPlayers(rows))
      .catch((e) => console.error(e));
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

  // When you filter to a player, prefill the Add-a-bet Person with them so you
  // don't have to pick the same person again.
  useEffect(() => {
    if (filter) {
      setPerson(filter);
      setNewPlayer("");
    }
  }, [filter]);

  // Realtime: when any device adds/edits/deletes, re-pull so this screen stays in
  // sync. Debounced so a bulk insert (many events) triggers a single refresh.
  useEffect(() => {
    let t;
    const refresh = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        fetchBets().then(setEntries).catch((e) => console.error(e));
        fetchPlayers().then(setPlayers).catch((e) => console.error(e));
      }, 250);
    };
    const unsub = subscribeChanges(refresh);
    return () => {
      clearTimeout(t);
      unsub();
    };
  }, []);

  // Drawer list = saved players ∪ any person already used on a bet (so legacy
  // names and pre-added players both show). Sorted, case-insensitive.
  const playerNames = useMemo(() => {
    const set = new Set();
    for (const p of players) if (p.name) set.add(p.name);
    for (const e of entries) if (e.person) set.add(e.person);
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [players, entries]);

  const countByPlayer = useMemo(() => {
    const m = {};
    for (const e of entries) if (e.person) m[e.person] = (m[e.person] || 0) + 1;
    return m;
  }, [entries]);

  // Save a new player name (skips blanks and case-insensitive duplicates).
  function addPlayer(rawName) {
    const name = rawName.trim();
    if (!name) return;
    const exists = players.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (exists) return;
    const p = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name };
    setPlayers((prev) => [...prev, p]);
    insertPlayer(p).catch((err) => console.error(err));
  }

  // Rename a player everywhere: the player record AND every bet linked by the old
  // name. Fixes a misspelled / wrong player without losing its bets.
  function renamePlayer(oldName, rawNew) {
    const newName = rawNew.trim();
    setEditPlayer(null);
    if (!newName || newName === oldName) return;
    // Optimistic local update across players, bets, and the active filter/form.
    setPlayers((prev) => prev.map((p) => (p.name === oldName ? { ...p, name: newName } : p)));
    setEntries((prev) => prev.map((e) => (e.person === oldName ? { ...e, person: newName } : e)));
    if (filter === oldName) setFilter(newName);
    if (person === oldName) setPerson(newName);
    const rec = players.find((p) => p.name === oldName);
    const tasks = [renameBetsPerson(oldName, newName)];
    if (rec) tasks.push(updatePlayer(rec.id, newName));
    Promise.all(tasks).catch((err) => {
      setErr("Failed to rename the player.");
      console.error(err);
      resync();
      fetchPlayers().then(setPlayers).catch(() => {});
    });
  }

  const validRows = rows.filter((r) => (parseFloat(r.amount) || 0) > 0);
  const totalReal = validRows.reduce((s, r) => s + (parseFloat(r.amount) || 0) * r.mult, 0);
  const canAdd = validRows.length > 0;
  // Effective player name for the current form (handles the inline "+ New player").
  const personName = (person === NEW_PLAYER ? newPlayer : person).trim();

  function updateRow(key, patch) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, makeRow()]);
  }
  function removeRow(key) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  }

  // Save every filled-in row as its own bet, all sharing the same person. Each
  // starts unsettled; you pick the outcome on each card afterward.
  function save() {
    const valid = rows.filter((r) => (parseFloat(r.amount) || 0) > 0);
    if (valid.length === 0) return;
    const p = personName;
    if (person === NEW_PLAYER && p) addPlayer(p);
    const base = Date.now();
    const stamp = base.toString(36);
    const created = valid.map((r, i) => {
      // The signed +/- ratio is appended to the end of the note.
      const ratio = r.ratio.trim() ? `${r.ratioSign}${r.ratio.trim()}` : "";
      return {
        id: stamp + i.toString(36) + Math.random().toString(36).slice(2, 5),
        person: p,
        name: [r.note.trim(), ratio].filter(Boolean).join(" "),
        amount: (parseFloat(r.amount) || 0) * r.mult,
        outcome: "pending",
        // Stagger by 1ms per row so each bet has a distinct, ordered timestamp.
        // Identical created_at values let the DB return ties in random order on
        // reload (the "shuffle"). Row 0 stays the newest, so it sits on top.
        created_at: new Date(base - i).toISOString(),
      };
    });
    setEntries((prev) => [...created, ...prev]); // optimistic
    setPerson(filter || ""); // keep the filtered player prefilled for the next bet
    setNewPlayer("");
    setRows([makeRow()]);
    Promise.all(created.map((e) => insertBet(e))).catch((err) => {
      setErr("Failed to save one or more bets.");
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
  function startEdit(e) {
    setEditId(e.id);
    setEditText(e.name || "");
  }
  function saveNote() {
    const id = editId;
    const name = editText.trim();
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, name } : e)));
    setEditId(null);
    updateBetNote(id, name).catch((err) => {
      setErr("Failed to update the note.");
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

  // The book respects the active player filter; the earnings total follows suit.
  const visibleEntries = useMemo(
    () => (filter ? entries.filter((e) => e.person === filter) : entries),
    [entries, filter]
  );

  // The visible week window [start, end) based on the week switcher offset.
  const weekStart = useMemo(() => {
    const m = mondayOfWeek(new Date());
    m.setDate(m.getDate() + weekOffset * 7);
    return m;
  }, [weekOffset]);
  const weekEnd = useMemo(() => {
    const e = new Date(weekStart);
    e.setDate(e.getDate() + 7);
    return e;
  }, [weekStart]);
  const weekLabel = useMemo(() => {
    const last = new Date(weekEnd);
    last.setDate(last.getDate() - 1);
    return `${fmtMD(weekStart)} – ${fmtMD(last)}`;
  }, [weekStart, weekEnd]);

  // Bets entered in the selected week (after the player filter).
  const weekEntries = useMemo(() => {
    const s = weekStart.getTime();
    const e = weekEnd.getTime();
    return visibleEntries.filter((x) => {
      const t = new Date(x.created_at || 0).getTime();
      return t >= s && t < e;
    });
  }, [visibleEntries, weekStart, weekEnd]);

  // Group the week's bets by the day they were entered, ordered by the sort toggle.
  const dayGroups = useMemo(() => {
    const map = new Map();
    for (const e of weekEntries) {
      const d = new Date(e.created_at || 0);
      const key = dayKey(d);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    const groups = [...map.values()].map((list) => {
      const items = [...list].sort((a, b) => cmpEntries(a, b, sort));
      let collect = 0, pay = 0;
      for (const e of items) {
        const s = settle(e.outcome, e.amount);
        if (s.dir === "collect") collect += s.value;
        else if (s.dir === "pay") pay += s.value;
      }
      const d = new Date(items[0].created_at || 0);
      return { key: dayKey(d), items, net: collect - pay, label: fmtDayHead(d), time: d.getTime() };
    });
    groups.sort((a, b) => (sort === "new" ? b.time - a.time : a.time - b.time));
    return groups;
  }, [weekEntries, sort]);

  function toggleDay(key) {
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const totals = useMemo(() => {
    let collect = 0, pay = 0, pending = 0;
    for (const e of visibleEntries) {
      const s = settle(e.outcome, e.amount);
      if (s.dir === "collect") collect += s.value;
      else if (s.dir === "pay") pay += s.value;
      else if (s.dir === "pending") pending += 1;
    }
    return { collect, pay, net: collect - pay, count: visibleEntries.length, pending };
  }, [visibleEntries]);

  const netCls = totals.net > 0 ? "bk-pos" : totals.net < 0 ? "bk-neg" : "bk-zero";
  const netSign = totals.net > 0 ? "+" : "";

  const renderEntry = (e) => {
    const s = settle(e.outcome, e.amount);
    const pending = s.dir === "pending";
    const isCollect = s.dir === "collect";
    return (
      <div className={cx("bk-entry", pending && "is-pending")} key={e.id}>
        <div className="bk-entry-head">
          <span className={cx("bk-dot", e.outcome)} />
          <div className="bk-entry-names">
            {filter ? (
              // Already filtered to one player — the person name is redundant,
              // so the match/note becomes the highlighted headline instead.
              <span className={cx("bk-name bk-name-note", !e.name && "empty")}>
                {e.name || "No note"}
              </span>
            ) : (
              <>
                <span className={cx("bk-name", !e.person && "empty")}>
                  {e.person || "No name"}
                </span>
                {e.name && <span className="bk-note">{e.name}</span>}
              </>
            )}
          </div>
          {confirmId === e.id ? (
            <div className="bk-confirm">
              <button className="bk-confirm-yes" onClick={() => remove(e.id)}>delete</button>
              <button className="bk-confirm-no" onClick={() => setConfirmId(null)}>keep</button>
            </div>
          ) : (
            <div className="bk-entry-tools">
              <button className="bk-edit" onClick={() => startEdit(e)} aria-label="Edit note">
                ✎
              </button>
              <button
                className="bk-del"
                onClick={() => setConfirmId(e.id)}
                aria-label="Delete entry"
              >
                ✕
              </button>
            </div>
          )}
        </div>

        {editId === e.id && (
          <form
            className="bk-edit-row"
            onSubmit={(ev) => {
              ev.preventDefault();
              saveNote();
            }}
          >
            <input
              className="bk-input"
              placeholder="Note / match"
              value={editText}
              onChange={(ev) => setEditText(ev.target.value)}
              autoFocus
            />
            <button className="bk-edit-save" type="submit">Save</button>
            <button className="bk-edit-cancel" type="button" onClick={() => setEditId(null)}>
              Cancel
            </button>
          </form>
        )}

        <div className="bk-entry-meta">
          <span className="bk-entry-sub mono">
            bet {money(e.amount)}
            {fmtDate(e.created_at) && (
              <span className="bk-entry-date"> · {fmtDate(e.created_at)}</span>
            )}
          </span>
          {pending ? (
            <span className="bk-entry-net bk-pending mono">
              —<span className="bk-tag">not settled</span>
            </span>
          ) : s.dir === "even" ? (
            <span className="bk-entry-net bk-even mono">
              {money(0)}
              <span className="bk-tag">even</span>
            </span>
          ) : (
            // Color follows player win/lose, not money direction: a Win
            // pays out (collect=false) yet shows green so it reads as a win.
            <span className={cx("bk-entry-net mono", isCollect ? "bk-neg" : "bk-pos")}>
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
              className={cx(e.outcome === o.key && `on-${o.tone}`)}
              onClick={() => setOutcome(e.id, o.key)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="bk">
      <style>{CSS}</style>

      {/* Players drawer */}
      {drawerOpen && (
        <div className="bk-scrim" onClick={() => setDrawerOpen(false)} />
      )}
      <aside className={cx("bk-drawer", drawerOpen && "open")} aria-hidden={!drawerOpen}>
        <div className="bk-drawer-head">
          <span className="bk-drawer-title">Players</span>
          <button
            className="bk-drawer-add"
            onClick={() => {
              setAddingPlayer((v) => !v);
              setDrawerNewName("");
            }}
            aria-label="Add player"
          >
            +
          </button>
        </div>

        {addingPlayer && (
          <form
            className="bk-player-new"
            onSubmit={(e) => {
              e.preventDefault();
              addPlayer(drawerNewName);
              setDrawerNewName("");
              setAddingPlayer(false);
            }}
          >
            <input
              className="bk-input"
              placeholder="Player name"
              value={drawerNewName}
              onChange={(e) => setDrawerNewName(e.target.value)}
              autoFocus
            />
            <button className="bk-player-save" type="submit">Add</button>
          </form>
        )}

        <button
          className={cx("bk-player-item", filter === null && "on")}
          onClick={() => {
            setFilter(null);
            setDrawerOpen(false);
          }}
        >
          <span className="bk-player-name">All players</span>
          <span className="bk-player-count">{entries.length}</span>
        </button>

        {playerNames.length === 0 && (
          <div className="bk-drawer-empty">No players yet. Tap + to add one.</div>
        )}
        {playerNames.map((nm) =>
          editPlayer === nm ? (
            <form
              key={nm}
              className="bk-player-edit"
              onSubmit={(e) => {
                e.preventDefault();
                renamePlayer(nm, editPlayerText);
              }}
            >
              <input
                className="bk-input"
                value={editPlayerText}
                onChange={(e) => setEditPlayerText(e.target.value)}
                autoFocus
              />
              <button className="bk-player-save" type="submit">Save</button>
              <button
                className="bk-player-x"
                type="button"
                onClick={() => setEditPlayer(null)}
                aria-label="Cancel rename"
              >
                ✕
              </button>
            </form>
          ) : (
            <div key={nm} className="bk-player-row">
              <button
                className={cx("bk-player-item", filter === nm && "on")}
                onClick={() => {
                  setFilter(nm);
                  setDrawerOpen(false);
                }}
              >
                <span className="bk-player-name">{nm}</span>
                <span className="bk-player-count">{countByPlayer[nm] || 0}</span>
              </button>
              <button
                className="bk-player-edit-btn"
                onClick={() => {
                  setEditPlayer(nm);
                  setEditPlayerText(nm);
                }}
                aria-label={`Rename ${nm}`}
              >
                ✎
              </button>
            </div>
          )
        )}
      </aside>

      <div className="bk-wrap">
        <header className="bk-head">
          <div className="bk-head-left">
            <button
              className="bk-burger"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open players menu"
            >
              ☰
            </button>
            <span className="bk-title">The Book</span>
          </div>
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

        {filter && (
          <div className="bk-filter-bar">
            <span>
              Showing <strong>{filter}</strong>
            </span>
            <button className="bk-filter-clear" onClick={() => setFilter(null)}>
              ✕ all players
            </button>
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
                  <span className="v" style={{ color: "var(--lose)" }}>{money(totals.collect)}</span>
                  <span className="k">to collect</span>
                </div>
                <div>
                  <span className="v" style={{ color: "var(--win)" }}>+{money(totals.pay)}</span>
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
          <button
            className="bk-form-toggle"
            onClick={() => setShowAdd((v) => !v)}
            aria-expanded={showAdd}
          >
            <span className="bk-form-title">Add a bet</span>
            <span className="bk-chev">{showAdd ? "▾" : "▸"}</span>
          </button>
          {showAdd && (
          <div className="bk-form-body">
          <select
            className="bk-input bk-select"
            value={person}
            onChange={(e) => setPerson(e.target.value)}
          >
            <option value="">Person — who pays / collects</option>
            {playerNames.map((nm) => (
              <option key={nm} value={nm}>{nm}</option>
            ))}
            <option value={NEW_PLAYER}>+ New player…</option>
          </select>
          {person === NEW_PLAYER && (
            <input
              className="bk-input bk-input-new"
              placeholder="New player name"
              value={newPlayer}
              onChange={(e) => setNewPlayer(e.target.value)}
              autoFocus
            />
          )}
          <div className="bk-rows">
            {rows.map((r) => (
              <div className="bk-brow" key={r.key}>
                <div className="bk-brow-top">
                  <input
                    className="bk-input bk-brow-note"
                    placeholder="Note / match (optional)"
                    value={r.note}
                    onChange={(ev) => updateRow(r.key, { note: ev.target.value })}
                  />
                  <button
                    type="button"
                    className={cx("bk-ratio-sign", r.ratioSign === "-" && "minus")}
                    onClick={() =>
                      updateRow(r.key, { ratioSign: r.ratioSign === "+" ? "-" : "+" })
                    }
                    aria-label="Toggle ratio sign"
                  >
                    {r.ratioSign === "+" ? "+" : "−"}
                  </button>
                  <input
                    className="bk-input bk-brow-ratio mono"
                    inputMode="decimal"
                    placeholder="ratio"
                    value={r.ratio}
                    onChange={(ev) => updateRow(r.key, { ratio: ev.target.value })}
                    aria-label="Ratio (appended to note)"
                  />
                  {rows.length > 1 && (
                    <button
                      className="bk-brow-del"
                      type="button"
                      onClick={() => removeRow(r.key)}
                      aria-label="Remove row"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="bk-brow-bot">
                  <div className="bk-mult" role="group" aria-label="Amount multiplier">
                    {MULTS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={cx(r.mult === m && "on")}
                        onClick={() => updateRow(r.key, { mult: m })}
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
                      value={r.amount}
                      onChange={(ev) => updateRow(r.key, { amount: ev.target.value })}
                      onKeyDown={(ev) => ev.key === "Enter" && save()}
                    />
                    <span className="bk-suffix">×{r.mult}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button className="bk-addrow" type="button" onClick={addRow}>
            + Add row
          </button>

          <div className="bk-preview">
            {canAdd ? (
              <>
                total <span className="mono">{money(totalReal)}</span> — {validRows.length}{" "}
                {validRows.length === 1 ? "bet" : "bets"}
                {personName && (
                  <> for <span className="bk-prev-person">{personName}</span></>
                )}
              </>
            ) : (
              <>&nbsp;</>
            )}
          </div>

          <button className="bk-save" disabled={!canAdd} onClick={save}>
            {canAdd
              ? `Save ${validRows.length} bet${validRows.length === 1 ? "" : "s"}`
              : "Save bets"}
          </button>
          </div>
          )}
        </section>

        {/* Lines */}
        <section>
          {/* Week switcher */}
          <div className="bk-week">
            <button
              className="bk-week-nav"
              onClick={() => setWeekOffset((w) => w - 1)}
              aria-label="Previous week"
            >
              ‹
            </button>
            <button
              className="bk-week-label"
              onClick={() => setWeekOffset(0)}
              title="Jump to this week"
            >
              <span className="bk-week-range">{weekLabel}</span>
              <span className="bk-week-sub">
                {weekOffset === 0
                  ? "this week"
                  : weekOffset === -1
                  ? "last week"
                  : `${weekOffset > 0 ? "+" : ""}${weekOffset} weeks`}
              </span>
            </button>
            <button
              className="bk-week-nav"
              onClick={() => setWeekOffset((w) => w + 1)}
              aria-label="Next week"
            >
              ›
            </button>
          </div>

          {weekEntries.length > 0 && (
            <div className="bk-list-head">
              <span className="bk-list-count">
                {weekEntries.length} {weekEntries.length === 1 ? "bet" : "bets"} this week
              </span>
              <div className="bk-sort" role="group" aria-label="Sort by date">
                <button className={cx(sort === "new" && "on")} onClick={() => setSort("new")}>
                  Newest
                </button>
                <button className={cx(sort === "old" && "on")} onClick={() => setSort("old")}>
                  Oldest
                </button>
              </div>
            </div>
          )}

          {loaded && weekEntries.length === 0 && (
            <div className="bk-empty">
              {filter ? `No bets for ${filter} this week.` : "No bets entered this week."}
            </div>
          )}
          {dayGroups.map((g) => {
            const collapsed = collapsedDays.has(g.key);
            return (
              <div className="bk-day" key={g.key}>
                <button
                  className="bk-day-head"
                  onClick={() => toggleDay(g.key)}
                  aria-expanded={!collapsed}
                >
                  <span className="bk-day-date">{g.label}</span>
                  <span className="bk-day-meta">
                    <span className="bk-day-count">
                      {g.items.length} {g.items.length === 1 ? "bet" : "bets"}
                    </span>
                    <span
                      className={cx(
                        "mono bk-day-net",
                        g.net > 0 ? "bk-pos" : g.net < 0 ? "bk-neg" : "bk-zero"
                      )}
                    >
                      {g.net > 0 ? "+" : ""}
                      {money(Math.abs(g.net))}
                    </span>
                    <span className="bk-chev">{collapsed ? "▸" : "▾"}</span>
                  </span>
                </button>
                {!collapsed && <div className="bk-day-body">{g.items.map(renderEntry)}</div>}
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

/* Burger + players drawer */
.bk-head-left{display:flex; align-items:center; gap:12px;}
.bk-burger{width:44px; height:44px; border:1px solid var(--line2); border-radius:10px; background:var(--panel2);
  color:var(--brass); font-size:1.4rem; line-height:1; cursor:pointer; transition:all .15s; flex-shrink:0;}
.bk-burger:hover{color:var(--brass); border-color:var(--brass-dim); background:rgba(203,162,78,.12);}
.bk-burger:active{transform:scale(.95);}
.bk-scrim{position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:40; animation:bk-fade .15s ease;}
.bk-drawer{position:fixed; top:0; left:0; height:100%; width:260px; max-width:82vw; background:var(--panel);
  border-right:1px solid var(--line2); z-index:50; padding:18px 14px; overflow-y:auto;
  transform:translateX(-100%); transition:transform .2s ease; display:flex; flex-direction:column; gap:3px;}
.bk-drawer.open{transform:none;}
.bk-drawer-head{display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; padding:0 6px;}
.bk-drawer-title{font-size:.72rem; text-transform:uppercase; letter-spacing:.16em; color:var(--brass); font-weight:700;}
.bk-drawer-add{width:30px; height:30px; border:1px solid var(--line2); border-radius:8px; background:transparent;
  color:var(--brass); font-size:1.1rem; line-height:1; cursor:pointer; transition:all .15s;}
.bk-drawer-add:hover{border-color:var(--brass); background:rgba(203,162,78,.12);}
.bk-player-new{display:flex; gap:6px; margin-bottom:8px;}
.bk-player-new .bk-input{padding:9px 10px;}
.bk-player-save{padding:0 12px; border:1px solid var(--brass); border-radius:8px; background:rgba(203,162,78,.16);
  color:var(--brass); font-weight:700; font-size:.78rem; cursor:pointer; font-family:var(--sans);}
.bk-player-row{display:flex; align-items:center; gap:2px;}
.bk-player-row .bk-player-item{flex:1; min-width:0;}
.bk-player-edit-btn{width:34px; height:34px; flex-shrink:0; border:none; border-radius:8px;
  background:transparent; color:var(--faint); cursor:pointer; font-size:.85rem; transition:all .12s;}
.bk-player-edit-btn:hover{color:var(--brass); background:var(--panel2);}
.bk-player-edit{display:flex; align-items:center; gap:5px; padding:3px 2px;}
.bk-player-edit .bk-input{flex:1; min-width:0; padding:8px 10px;}
.bk-player-save{flex-shrink:0; padding:0 11px; align-self:stretch; border:1px solid var(--brass); border-radius:8px;
  background:rgba(203,162,78,.16); color:var(--brass); font-weight:700; font-size:.76rem; cursor:pointer; font-family:var(--sans);}
.bk-player-x{flex-shrink:0; width:32px; height:32px; border:1px solid var(--line2); border-radius:8px;
  background:transparent; color:var(--faint); cursor:pointer; font-size:.76rem; line-height:1;}
.bk-player-item{display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%;
  padding:11px 12px; border:none; border-radius:9px; background:transparent; color:var(--ink);
  font-family:var(--sans); font-size:.9rem; cursor:pointer; text-align:left; transition:background .12s;}
.bk-player-item:hover{background:var(--panel2);}
.bk-player-item.on{background:rgba(203,162,78,.14); color:var(--brass);}
.bk-player-name{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.bk-player-count{font-family:var(--mono); font-size:.74rem; color:var(--faint); flex-shrink:0;}
.bk-player-item.on .bk-player-count{color:var(--brass-dim);}
.bk-drawer-empty{color:var(--faint); font-size:.8rem; padding:10px 12px;}

.bk-filter-bar{display:flex; align-items:center; justify-content:space-between; gap:10px;
  background:rgba(203,162,78,.1); border:1px solid var(--brass-dim); border-radius:10px;
  padding:9px 14px; margin-bottom:14px; font-size:.82rem; color:var(--dim);}
.bk-filter-bar strong{color:var(--brass); font-weight:700;}
.bk-filter-clear{background:transparent; border:none; color:var(--faint); cursor:pointer;
  font-size:.74rem; font-family:var(--sans); font-weight:600;}
.bk-filter-clear:hover{color:var(--lose);}

.bk-select{appearance:none; -webkit-appearance:none; cursor:pointer; padding-right:36px;
  background:var(--panel2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23A89C89' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 13px center;}
@keyframes bk-fade{from{opacity:0;} to{opacity:1;}}

.bk-head{position:sticky; top:0; z-index:30; background:var(--bg);
  display:flex; align-items:center; justify-content:space-between;
  padding:12px 0; margin-bottom:14px; min-height:30px; border-bottom:1px solid var(--line);}
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
.bk-form{border:1px solid var(--line); border-radius:16px; background:var(--panel); margin-bottom:22px;}
.bk-form-toggle{width:100%; display:flex; align-items:center; justify-content:space-between;
  background:transparent; border:none; cursor:pointer; padding:16px 18px; font-family:var(--sans);}
.bk-form-title{font-size:.66rem; text-transform:uppercase; letter-spacing:.16em; color:var(--brass-dim); font-weight:600;}
.bk-form-body{padding:2px 18px 20px; animation:bk-in .18s ease;}
/* 16px keeps iOS Safari from auto-zooming the page when a field is focused. */
.bk-input{width:100%; background:var(--panel2); border:1px solid var(--line2); border-radius:10px;
  color:var(--ink); padding:12px; font-size:16px; font-family:var(--sans); outline:none;
  transition:border-color .15s, box-shadow .15s;}
.bk-input::placeholder{color:var(--faint);}
.bk-input:focus{border-color:var(--brass); box-shadow:0 0 0 3px rgba(203,162,78,.16);}
.bk-input + .bk-input{margin-top:10px;}

.bk-rows{display:flex; flex-direction:column; gap:8px; margin-top:12px;}
.bk-brow{border:1px solid var(--line); border-radius:11px; padding:10px;}
.bk-brow-top{display:flex; gap:8px; align-items:center;}
.bk-brow-note{flex:1; min-width:0;}
.bk-ratio-sign{flex:0 0 40px; align-self:stretch; border:1px solid var(--line2); border-radius:10px;
  background:var(--panel2); color:var(--brass); font-size:1.15rem; font-weight:700; line-height:1;
  cursor:pointer; font-family:var(--mono); transition:all .13s;}
.bk-ratio-sign:hover{border-color:var(--faint);}
.bk-ratio-sign.minus{color:var(--lose);}
.bk-brow-ratio{flex:0 0 58px; min-width:0; text-align:center; padding-left:6px; padding-right:6px;}
.bk-brow-del{width:34px; height:34px; flex-shrink:0; border:1px solid var(--line2); border-radius:8px;
  background:transparent; color:var(--faint); cursor:pointer; font-size:.8rem; line-height:1; transition:all .15s;}
.bk-brow-del:hover{color:var(--lose); border-color:var(--lose);}
.bk-brow-bot{display:grid; grid-template-columns:auto 1fr; gap:8px; margin-top:8px;}
.bk-addrow{margin-top:10px; width:100%; padding:11px; border:1px dashed var(--line2); border-radius:10px;
  background:transparent; color:var(--brass-dim); cursor:pointer; font-family:var(--sans);
  font-size:.78rem; font-weight:700; letter-spacing:.04em; transition:all .15s;}
.bk-addrow:hover{color:var(--brass); border-color:var(--brass-dim);}
.bk-prev-person{color:var(--ink); font-weight:600;}
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

.bk-list-head{display:flex; align-items:center; justify-content:space-between; margin:2px 2px 12px;}
.bk-list-count{font-size:.7rem; text-transform:uppercase; letter-spacing:.12em; color:var(--faint); font-weight:600;}
.bk-sort{display:flex; border:1px solid var(--line2); border-radius:8px; overflow:hidden;}
.bk-sort button{padding:7px 13px; border:none; background:var(--panel2); color:var(--faint);
  font-size:.72rem; font-weight:600; cursor:pointer; font-family:var(--sans); transition:all .12s;}
.bk-sort button + button{border-left:1px solid var(--line2);}
.bk-sort button:hover{color:var(--ink);}
.bk-sort button.on{background:rgba(203,162,78,.16); color:var(--brass);}
.bk-entry-date{color:var(--faint);}

/* Week switcher */
.bk-week{display:flex; align-items:center; gap:8px; margin:6px 0 14px;}
.bk-week-nav{width:38px; height:42px; flex-shrink:0; border:1px solid var(--line2); border-radius:10px;
  background:var(--panel2); color:var(--dim); font-size:1.25rem; line-height:1; cursor:pointer; transition:all .13s;}
.bk-week-nav:hover{color:var(--brass); border-color:var(--brass-dim);}
.bk-week-label{flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; gap:1px;
  border:1px solid var(--line); border-radius:10px; background:var(--panel); padding:6px 10px;
  cursor:pointer; font-family:var(--sans); transition:border-color .13s;}
.bk-week-label:hover{border-color:var(--line2);}
.bk-week-range{font-size:.9rem; font-weight:700; color:var(--ink); letter-spacing:.01em;}
.bk-week-sub{font-size:.58rem; text-transform:uppercase; letter-spacing:.14em; color:var(--faint);}

/* Day groups */
.bk-day{margin-bottom:14px;}
.bk-day-head{width:100%; display:flex; align-items:center; justify-content:space-between; gap:10px;
  background:transparent; border:none; border-bottom:1px solid var(--line2); padding:6px 2px 8px;
  cursor:pointer; font-family:var(--sans); margin-bottom:10px;}
.bk-day-date{font-size:.76rem; font-weight:700; color:var(--brass); letter-spacing:.04em; text-transform:uppercase;}
.bk-day-meta{display:flex; align-items:center; gap:11px;}
.bk-day-count{font-size:.64rem; text-transform:uppercase; letter-spacing:.1em; color:var(--faint);}
.bk-day-net{font-size:.9rem; font-weight:600;}

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
.bk-dot.push{background:var(--dim);}
.bk-dot.pending{border:2px solid var(--brass-dim);}
.bk-entry-names{flex:1; min-width:0; display:flex; flex-direction:column; gap:3px;}
.bk-name{font-size:.98rem; color:var(--ink); overflow-wrap:anywhere; font-weight:600; line-height:1.35;}
.bk-name.empty{color:var(--faint); font-weight:400;}
.bk-name-note{color:var(--brass);}
.bk-note{font-size:.8rem; color:var(--dim); overflow-wrap:anywhere; line-height:1.35;}

.bk-entry-meta{display:flex; align-items:baseline; justify-content:space-between; gap:12px;
  margin:9px 0 13px; padding-left:18px;}
.bk-entry-sub{font-size:.76rem; color:var(--dim);}
.bk-entry-net{font-size:1.1rem; font-weight:600; white-space:nowrap; text-align:right; line-height:1.1;}
.bk-entry-net.bk-pending{color:var(--faint);}
.bk-entry-net.bk-even{color:var(--dim);}
.bk-tag{display:inline-block; font-family:var(--sans); font-size:.57rem; text-transform:uppercase;
  letter-spacing:.1em; color:var(--faint); margin-left:7px; font-weight:600;}

.bk-outcomes{display:grid; grid-template-columns:repeat(5,1fr); gap:6px;}
.bk-outcomes button{padding:11px 3px; border-radius:10px; cursor:pointer; font-family:var(--sans);
  font-size:.8rem; font-weight:700; white-space:nowrap;
  border:1px solid var(--line2); background:var(--panel2); color:var(--dim); transition:all .13s;}
.bk-outcomes button:hover{color:var(--ink); border-color:var(--faint);}
.bk-outcomes button.on-win{border-color:var(--win); background:var(--win-bg); color:var(--win);}
.bk-outcomes button.on-lose{border-color:var(--lose); background:var(--lose-bg); color:var(--lose);}
.bk-outcomes button.on-even{border-color:var(--brass-dim); background:rgba(203,162,78,.14); color:var(--brass);}

.bk-entry-tools{display:flex; gap:6px; flex-shrink:0;}
.bk-del{width:30px; height:30px; flex-shrink:0; border:1px solid var(--line2); border-radius:8px; background:transparent;
  color:var(--faint); cursor:pointer; font-size:.85rem; line-height:1; transition:all .15s;}
.bk-del:hover{color:var(--lose); border-color:var(--lose);}
.bk-edit{width:30px; height:30px; flex-shrink:0; border:1px solid var(--line2); border-radius:8px; background:transparent;
  color:var(--faint); cursor:pointer; font-size:.82rem; line-height:1; transition:all .15s;}
.bk-edit:hover{color:var(--brass); border-color:var(--brass-dim);}
.bk-edit-row{display:flex; gap:6px; margin:11px 0 2px;}
.bk-edit-row .bk-input{flex:1; min-width:0;}
.bk-edit-save{flex-shrink:0; padding:0 13px; border:1px solid var(--brass); border-radius:8px;
  background:rgba(203,162,78,.16); color:var(--brass); font-weight:700; font-size:.78rem; cursor:pointer; font-family:var(--sans);}
.bk-edit-cancel{flex-shrink:0; padding:0 13px; border:1px solid var(--line2); border-radius:8px;
  background:transparent; color:var(--dim); font-size:.78rem; cursor:pointer; font-family:var(--sans);}
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
  .bk-outcomes button{font-size:.7rem; padding:11px 1px;}
  .bk-outcomes{gap:5px;}
  .bk-mult button{min-width:42px; padding:0 9px;}
}

/* Touch devices: comfortable tap targets. */
@media (pointer:coarse){
  .bk-outcomes button{padding:13px 4px;}
  .bk-mult button{padding:12px 11px;}
  .bk-del{width:38px; height:38px; font-size:.95rem;}
  .bk-edit{width:38px; height:38px; font-size:.92rem;}
  .bk-clear{padding:9px 14px;}
}
`;
