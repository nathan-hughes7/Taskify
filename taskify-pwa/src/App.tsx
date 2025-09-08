import React, { useEffect, useMemo, useRef, useState } from "react";

/* ================= Types ================= */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun
type DayChoice = Weekday | "bounties" | "items";
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type Recurrence =
  | { type: "none" }
  | { type: "daily" }
  | { type: "weekly"; days: Weekday[] }
  | { type: "every"; n: number; unit: "day" | "week" }
  | { type: "monthlyDay"; day: number };

type Task = {
  id: string;
  boardId: string;
  title: string;
  note?: string;
  dueISO: string;                 // for week board columns (day grouping)
  completed?: boolean;
  completedAt?: string;
  recurrence?: Recurrence;
  column?: "day" | "bounties" | "items";
  hiddenUntilISO?: string;        // controls visibility (appear at/after this date)
};

type Board =
  | { id: string; name: string; kind: "week" } // fixed Sun–Sat + Bounties
  | { id: string; name: string; kind: "list" }; // single column "Items"

type Settings = {
  weekStart: Weekday; // 0=Sun, 1=Mon, 6=Sat
};

const R_NONE: Recurrence = { type: "none" };
const LS_TASKS = "taskify_tasks_v3";
const LS_SETTINGS = "taskify_settings_v2";
const LS_BOARDS = "taskify_boards_v1";

/* ================= Date helpers ================= */
function startOfDay(d: Date) {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  return nd;
}
function isoForWeekday(target: Weekday, base = new Date()): string {
  const today = startOfDay(base);
  const diff = target - (today.getDay() as Weekday);
  return new Date(today.getTime() + diff * 86400000).toISOString();
}
function nextOccurrence(currentISO: string, rule: Recurrence): string | null {
  const cur = startOfDay(new Date(currentISO));
  const addDays = (d: number) =>
    startOfDay(new Date(cur.getTime() + d * 86400000)).toISOString();
  switch (rule.type) {
    case "none":
      return null;
    case "daily":
      return addDays(1);
    case "weekly": {
      if (!rule.days.length) return null;
      for (let i = 1; i <= 28; i++) {
        const cand = addDays(i);
        const wd = new Date(cand).getDay() as Weekday;
        if (rule.days.includes(wd)) return cand;
      }
      return null;
    }
    case "every":
      return addDays(rule.unit === "day" ? rule.n : rule.n * 7);
    case "monthlyDay": {
      const y = cur.getFullYear(), m = cur.getMonth();
      const next = new Date(y, m + 1, Math.min(rule.day, 28));
      return startOfDay(next).toISOString();
    }
  }
}

/* ============= Visibility helpers (hide until X) ============= */
function isVisibleNow(t: Task, now = new Date()): boolean {
  if (!t.hiddenUntilISO) return true;
  const today = startOfDay(now).getTime();
  const reveal = startOfDay(new Date(t.hiddenUntilISO)).getTime();
  return today >= reveal;
}

function startOfWeek(d: Date, weekStart: Weekday): Date {
  const sd = startOfDay(d);
  const current = sd.getDay() as Weekday;
  const ws = (weekStart === 1 || weekStart === 6) ? weekStart : 0; // only Mon(1)/Sat(6)/Sun(0)
  let diff = current - ws;
  if (diff < 0) diff += 7;
  return new Date(sd.getTime() - diff * 86400000);
}

/** Decide when the next instance should re-appear (hiddenUntilISO). */
function hiddenUntilForNext(
  nextISO: string,
  rule: Recurrence,
  weekStart: Weekday
): string | undefined {
  const nextMidnight = startOfDay(new Date(nextISO));
  if (rule.type === "daily") {
    // Daily: show at midnight on the due day.
    return nextMidnight.toISOString();
  }
  if (rule.type === "weekly") {
    // Weekly: show at midnight of the WEEK START that contains the next due date.
    const sow = startOfWeek(nextMidnight, weekStart);
    return sow.toISOString();
  }
  // Others (every-N / monthly): show the day BEFORE it’s due
  const dayBefore = new Date(nextMidnight.getTime() - 86400000);
  return startOfDay(dayBefore).toISOString();
}

/* ================= Storage hooks ================= */
function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_SETTINGS) || "") || { weekStart: 0 };
    } catch {
      return { weekStart: 0 };
    }
  });
  useEffect(() => {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  }, [settings]);
  return [settings, setSettings] as const;
}

function useBoards() {
  const [boards, setBoards] = useState<Board[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(LS_BOARDS) || "[]") as Board[];
      if (stored && stored.length) return stored;
    } catch {}
    // default: one Week board
    return [{ id: "week-default", name: "Week", kind: "week" }];
  });
  useEffect(() => {
    localStorage.setItem(LS_BOARDS, JSON.stringify(boards));
  }, [boards]);
  return [boards, setBoards] as const;
}

function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_TASKS) || "[]"); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem(LS_TASKS, JSON.stringify(tasks)); }, [tasks]);
  return [tasks, setTasks] as const;
}

/* ================= App ================= */
export default function App() {
  const [boards, setBoards] = useBoards();
  const [currentBoardId, setCurrentBoardId] = useState(boards[0].id);
  const currentBoard = boards.find(b => b.id === currentBoardId)!;

  const [tasks, setTasks] = useTasks();
  const [settings, setSettings] = useSettings();

  // header view
  const [view, setView] = useState<"board" | "completed">("board");
  const [showSettings, setShowSettings] = useState(false);
  const [showManageBoards, setShowManageBoards] = useState(false);

  // add bar
  const [newTitle, setNewTitle] = useState("");
  const defaultDay: DayChoice = currentBoard?.kind === "list" ? "items" : (new Date().getDay() as Weekday);
  const [dayChoice, setDayChoice] = useState<DayChoice>(defaultDay);

  // recurrence select (with Custom… option)
  const [quickRule, setQuickRule] = useState<
    "none" | "daily" | "weeklyMonFri" | "weeklyWeekends" | "every2d" | "custom"
  >("none");
  const [addCustomRule, setAddCustomRule] = useState<Recurrence>(R_NONE);
  const [showAddAdvanced, setShowAddAdvanced] = useState(false);

  // edit modal
  const [editing, setEditing] = useState<Task | null>(null);

  // undo snackbar
  const [undoTask, setUndoTask] = useState<Task | null>(null);

  // upcoming drawer (out-of-the-way FAB)
  const [showUpcoming, setShowUpcoming] = useState(false);

  // confetti
  const confettiRef = useRef<HTMLDivElement>(null);
  function burst() {
    const el = confettiRef.current;
    if (!el) return;
    for (let i = 0; i < 18; i++) {
      const s = document.createElement("span");
      s.textContent = ["🎉", "✨", "🎊", "💥"][i % 4];
      s.style.position = "absolute";
      s.style.left = Math.random() * 100 + "%";
      s.style.top = "-10px";
      s.style.transition = "transform 1s ease, opacity 1.1s ease";
      el.appendChild(s);
      requestAnimationFrame(() => {
        s.style.transform = `translateY(${
          80 + Math.random() * 120
        }px) rotate(${(Math.random() * 360) | 0}deg)`;
        s.style.opacity = "0";
        setTimeout(() => el.removeChild(s), 1200);
      });
    }
  }

  /* ---------- Derived: board-scoped lists ---------- */
  const tasksForBoard = useMemo(
    () => tasks.filter(t => t.boardId === currentBoardId),
    [tasks, currentBoardId]
  );

  const byDay = useMemo(() => {
    const visible = tasksForBoard.filter(t => !t.completed && t.column !== "bounties" && t.column !== "items" && isVisibleNow(t));
    const m = new Map<Weekday, Task[]>();
    for (const t of visible) {
      const wd = new Date(t.dueISO).getDay() as Weekday;
      if (!m.has(wd)) m.set(wd, []);
      m.get(wd)!.push(t); // preserve insertion order for manual reordering
    }
    return m;
  }, [tasksForBoard]);

  const bounties = useMemo(
    () => tasksForBoard.filter(t => !t.completed && t.column === "bounties" && isVisibleNow(t)),
    [tasksForBoard]
  );

  const listItems = useMemo(
    () => tasksForBoard.filter(t => !t.completed && t.column === "items" && isVisibleNow(t)),
    [tasksForBoard]
  );

  const completed = useMemo(
    () =>
      tasksForBoard
        .filter((t) => !!t.completed)
        .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || "")),
    [tasksForBoard]
  );

  const upcoming = useMemo(
    () =>
      tasksForBoard
        .filter((t) => !t.completed && t.hiddenUntilISO && !isVisibleNow(t))
        .sort((a, b) => (a.hiddenUntilISO || "").localeCompare(b.hiddenUntilISO || "")),
    [tasksForBoard]
  );

  /* ---------- Helpers ---------- */
  function resolveQuickRule(): Recurrence {
    switch (quickRule) {
      case "none": return R_NONE;
      case "daily": return { type: "daily" };
      case "weeklyMonFri": return { type: "weekly", days: [1,2,3,4,5] };
      case "weeklyWeekends": return { type: "weekly", days: [0,6] };
      case "every2d": return { type: "every", n: 2, unit: "day" };
      case "custom": return addCustomRule;
    }
  }

  function addTask() {
    const title = newTitle.trim();
    if (!title || !currentBoard) return;

    const candidate = resolveQuickRule();
    const recurrence = candidate.type === "none" ? undefined : candidate;

    let dueISO = isoForWeekday(0);
    let column: Task["column"] = "day";
    if (currentBoard.kind === "week") {
      if (dayChoice === "bounties") { column = "bounties"; }
      else { column = "day"; dueISO = isoForWeekday(dayChoice as Weekday); }
    } else {
      column = "items"; dueISO = isoForWeekday(0);
    }

    const t: Task = {
      id: crypto.randomUUID(),
      boardId: currentBoard.id,
      title,
      dueISO,
      completed: false,
      recurrence,
      column,
    };
    setTasks(prev => [...prev, t]);

    setNewTitle("");
    setQuickRule("none");
    setAddCustomRule(R_NONE);
  }

  function completeTask(id: string) {
    setTasks(prev => {
      const cur = prev.find(t => t.id === id);
      if (!cur) return prev;
      const now = new Date().toISOString();
      const updated = prev.map(t => t.id===id ? ({...t, completed:true, completedAt:now}) : t);
      const nextISO = cur.recurrence ? nextOccurrence(cur.dueISO, cur.recurrence) : null;
      if (nextISO && cur.recurrence) {
        const clone: Task = {
          ...cur,
          id: crypto.randomUUID(),
          completed: false,
          completedAt: undefined,
          dueISO: nextISO,
          hiddenUntilISO: hiddenUntilForNext(nextISO, cur.recurrence, settings.weekStart),
        };
        return [...updated, clone];
      }
      return updated;
    });
    burst();
  }

  function deleteTask(id: string) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    setUndoTask(t);
    setTasks(prev => prev.filter(x => x.id !== id));
    setTimeout(() => setUndoTask(null), 5000); // undo duration
  }
  function undoDelete() {
    if (undoTask) { setTasks(prev => [...prev, undoTask]); setUndoTask(null); }
  }

  function restoreTask(id: string) {
    setTasks(prev => prev.map(t => t.id===id ? ({...t, completed:false, completedAt:undefined}) : t));
    setView("board");
  }
  function clearCompleted() {
    setTasks(prev => prev.filter(t => !t.completed));
  }

  function saveEdit(updated: Task) {
    setTasks(prev => prev.map(t => t.id===updated.id ? updated : t));
    setEditing(null);
  }

  /* ---------- Drag & Drop: move or reorder ---------- */
  function moveTask(
    id: string,
    target: { type: "day"; day: Weekday } | { type: "bounties" } | { type: "items" },
    beforeId?: string
  ) {
    setTasks(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(t => t.id === id);
      if (fromIdx < 0) return prev;
      const task = arr[fromIdx];
      const updated: Task = {
        ...task,
        column:
          target.type === "bounties" ? "bounties" :
          target.type === "items" ? "items" : "day",
        dueISO:
          target.type === "bounties" || target.type === "items"
            ? isoForWeekday(0)
            : isoForWeekday(target.day),
        hiddenUntilISO: undefined, // reveal if user manually places it
      };
      // remove
      arr.splice(fromIdx, 1);
      // insert
      let insertIdx = typeof beforeId === "string" ? arr.findIndex(t => t.id === beforeId) : -1;
      if (insertIdx < 0) insertIdx = arr.length;
      arr.splice(insertIdx, 0, updated);
      return arr;
    });
  }

  // reset dayChoice when board changes
  useEffect(() => {
    setDayChoice(currentBoard?.kind === "list" ? "items" : (new Date().getDay() as Weekday));
  }, [currentBoardId]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="flex flex-wrap gap-3 items-center mb-4">
          <h1 className="text-2xl font-semibold tracking-tight">Taskify</h1>
          <div ref={confettiRef} className="relative h-0 w-full" />
          <div className="ml-auto flex items-center gap-2">
            {/* Board switcher */}
            <select
              value={currentBoardId}
              onChange={(e)=>setCurrentBoardId(e.target.value)}
              className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              title="Boards"
            >
              {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" onClick={()=>setShowManageBoards(true)}>Manage Boards</button>

            {/* Settings + View */}
            <button
              className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              onClick={() => setShowSettings(true)}
              title="Settings"
            >
              ⚙️
            </button>
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
              <button className={`px-3 py-2 ${view==="board" ? "bg-neutral-800":""}`} onClick={()=>setView("board")}>Board</button>
              <button className={`px-3 py-2 ${view==="completed" ? "bg-neutral-800":""}`} onClick={()=>setView("completed")}>Completed</button>
            </div>
          </div>
        </header>

        {/* Add bar */}
        {view === "board" && (
          <div className="flex flex-wrap gap-2 items-center mb-4">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="New task…"
              className="flex-1 min-w-[220px] px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 outline-none"
            />

            {/* Column picker (adapts to board) */}
            {currentBoard.kind === "week" ? (
              <select
                value={dayChoice === "bounties" ? "bounties" : String(dayChoice)}
                onChange={(e) => {
                  const v = e.target.value;
                  setDayChoice(v === "bounties" ? "bounties" : (Number(v) as Weekday));
                }}
                className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              >
                {WD_SHORT.map((d,i)=>(<option key={i} value={i}>{d}</option>))}
                <option value="bounties">Bounties</option>
              </select>
            ) : (
              <select
                value="items"
                onChange={()=>setDayChoice("items")}
                className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              >
                <option value="items">Items</option>
              </select>
            )}

            {/* Recurrence select with Custom… */}
            <select
              value={quickRule}
              onChange={(e) => {
                const v = e.target.value as typeof quickRule;
                setQuickRule(v);
                if (v === "custom") setShowAddAdvanced(true);
              }}
              className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              title="Recurrence"
            >
              <option value="none">No recurrence</option>
              <option value="daily">Daily</option>
              <option value="weeklyMonFri">Mon–Fri</option>
              <option value="weeklyWeekends">Weekends</option>
              <option value="every2d">Every 2 days</option>
              <option value="custom">Custom…</option>
            </select>

            {quickRule === "custom" && addCustomRule.type !== "none" && (
              <span className="text-xs text-neutral-400">({labelOf(addCustomRule)})</span>
            )}

            <button
              onClick={addTask}
              className="px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-medium"
            >
              Add
            </button>
          </div>
        )}

        {/* Board/Completed */}
        {view === "board" ? (
          currentBoard.kind === "week" ? (
            <>
              {/* HORIZONTAL board: single row, side-scroll */}
              <div className="overflow-x-auto pb-4">
                <div className="flex gap-4 min-w-max">
                  {Array.from({ length: 7 }, (_, i) => i as Weekday).map((day) => (
                    <DroppableColumn
                      key={day}
                      title={WD_SHORT[day]}
                      onDropCard={(payload) => moveTask(payload.id, { type: "day", day })}
                    >
                      {(byDay.get(day) || []).map((t, idx, arr) => (
                        <Card
                          key={t.id}
                          task={t}
                          onComplete={() => completeTask(t.id)}
                          onEdit={() => setEditing(t)}
                          onDelete={() => deleteTask(t.id)}
                          onDropBefore={(dragId) => moveTask(dragId, { type: "day", day }, t.id)}
                          isLast={idx === arr.length - 1}
                        />
                      ))}
                    </DroppableColumn>
                  ))}

                  {/* Bounties */}
                  <DroppableColumn
                    title="Bounties"
                    onDropCard={(payload) => moveTask(payload.id, { type: "bounties" })}
                  >
                    {bounties.map((t, idx, arr) => (
                      <Card
                        key={t.id}
                        task={t}
                        onComplete={() => completeTask(t.id)}
                        onEdit={() => setEditing(t)}
                        onDelete={() => deleteTask(t.id)}
                        onDropBefore={(dragId) => moveTask(dragId, { type: "bounties" }, t.id)}
                        isLast={idx === arr.length - 1}
                      />
                    ))}
                  </DroppableColumn>
                </div>
              </div>
            </>
          ) : (
            // LIST board (single column), still in the horizontal scroller for consistency
            <div className="overflow-x-auto pb-4">
              <div className="flex gap-4 min-w-max">
                <DroppableColumn
                  title="Items"
                  onDropCard={(payload) => moveTask(payload.id, { type: "items" })}
                >
                  {listItems.map((t, idx, arr) => (
                    <Card
                      key={t.id}
                      task={t}
                      onComplete={() => completeTask(t.id)}
                      onEdit={() => setEditing(t)}
                      onDelete={() => deleteTask(t.id)}
                      onDropBefore={(dragId) => moveTask(dragId, { type: "items" }, t.id)}
                      isLast={idx === arr.length - 1}
                    />
                  ))}
                </DroppableColumn>
              </div>
            </div>
          )
        ) : (
          // Completed view
          <div className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="text-lg font-semibold">Completed</div>
              <div className="ml-auto">
                <button
                  className="px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600"
                  onClick={clearCompleted}
                >
                  Clear completed
                </button>
              </div>
            </div>
            {completed.length === 0 ? (
              <div className="text-neutral-400 text-sm">No completed tasks yet.</div>
            ) : (
              <ul className="space-y-2">
                {completed.map((t) => (
                  <li key={t.id} className="p-3 rounded-xl bg-neutral-800 border border-neutral-700">
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                        <div className="text-sm font-medium">
                          {renderTitleWithLink(t.title, t.note)}
                        </div>
                        <div className="text-xs text-neutral-400">
                          {currentBoard.kind === "week"
                            ? `Due ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}`
                            : "Completed item"}
                          {t.completedAt ? ` • Completed ${new Date(t.completedAt).toLocaleString()}` : ""}
                        </div>
                        {!!t.note && <div className="text-xs text-neutral-400 mt-1 break-words">{autolink(t.note)}</div>}
                      </div>
                      <div className="flex gap-1">
                        <IconButton label="Restore" onClick={() => restoreTask(t.id)} intent="success">↩︎</IconButton>
                        <IconButton label="Delete" onClick={() => deleteTask(t.id)} intent="danger">🗑</IconButton>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Floating Upcoming Drawer Button */}
      <button
        className="fixed bottom-4 right-4 px-3 py-2 rounded-full bg-neutral-800 border border-neutral-700 shadow-lg text-sm"
        onClick={() => setShowUpcoming(true)}
        title="Upcoming (hidden) tasks"
      >
        Upcoming {upcoming.length ? `(${upcoming.length})` : ""}
      </button>

      {/* Upcoming Drawer */}
      {showUpcoming && (
        <SideDrawer title="Upcoming" onClose={() => setShowUpcoming(false)}>
          {upcoming.length === 0 ? (
            <div className="text-sm text-neutral-400">No upcoming tasks.</div>
          ) : (
            <ul className="space-y-2">
              {upcoming.map((t) => (
                <li key={t.id} className="p-3 rounded-xl bg-neutral-900 border border-neutral-800">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <div className="text-sm font-medium">{renderTitleWithLink(t.title, t.note)}</div>
                      <div className="text-xs text-neutral-400">
                        {currentBoard.kind === "week"
                          ? `Due ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}`
                          : "Hidden item"}
                        {t.hiddenUntilISO ? ` • Reveals ${new Date(t.hiddenUntilISO).toLocaleDateString()}` : ""}
                      </div>
                      {!!t.note && <div className="text-xs text-neutral-400 mt-1 break-words">{autolink(t.note)}</div>}
                    </div>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="px-3 py-1 rounded-full bg-emerald-600 hover:bg-emerald-500 text-sm"
                      onClick={() =>
                        setTasks((prev) =>
                          prev.map((x) =>
                            x.id === t.id ? { ...x, hiddenUntilISO: undefined } : x
                          )
                        )
                      }
                    >
                      Reveal now
                    </button>
                    <button
                      className="px-3 py-1 rounded-full bg-neutral-700 hover:bg-neutral-600 text-sm"
                      onClick={() => { setEditing(t); setShowUpcoming(false); }}
                    >
                      Edit
                    </button>
                    <button
                      className="px-3 py-1 rounded-full bg-rose-600/80 hover:bg-rose-600 text-sm"
                      onClick={() => deleteTask(t.id)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SideDrawer>
      )}

      {/* Undo Snackbar */}
      {undoTask && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-neutral-800 border border-neutral-700 text-sm px-4 py-2 rounded-xl shadow-lg flex items-center gap-3">
          Task deleted
          <button onClick={undoDelete} className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500">Undo</button>
        </div>
      )}

      {/* Edit Modal (with Advanced recurrence) */}
      {editing && (
        <EditModal
          task={editing}
          onCancel={() => setEditing(null)}
          onDelete={() => { deleteTask(editing.id); setEditing(null); }}
          onSave={saveEdit}
        />
      )}

      {/* Add bar Advanced recurrence modal */}
      {showAddAdvanced && (
        <RecurrenceModal
          initial={addCustomRule}
          onClose={() => setShowAddAdvanced(false)}
          onApply={(r) => { setAddCustomRule(r); setShowAddAdvanced(false); }}
        />
      )}

      {/* Settings */}
      {showSettings && (
        <Modal onClose={() => setShowSettings(false)} title="Settings">
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Week starts on</div>
              <div className="flex gap-2">
                <button className={`px-3 py-2 rounded-xl ${settings.weekStart === 6 ? "bg-emerald-600" : "bg-neutral-800"}`} onClick={() => setSettings({ weekStart: 6 })}>Saturday</button>
                <button className={`px-3 py-2 rounded-xl ${settings.weekStart === 0 ? "bg-emerald-600" : "bg-neutral-800"}`} onClick={() => setSettings({ weekStart: 0 })}>Sunday</button>
                <button className={`px-3 py-2 rounded-xl ${settings.weekStart === 1 ? "bg-emerald-600" : "bg-neutral-800"}`} onClick={() => setSettings({ weekStart: 1 })}>Monday</button>
              </div>
              <div className="text-xs text-neutral-400 mt-2">Affects when weekly recurring tasks re-appear.</div>
            </div>
            <div className="flex justify-end">
              <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setShowSettings(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Manage Boards */}
      {showManageBoards && (
        <ManageBoardsModal
          boards={boards}
          onClose={() => setShowManageBoards(false)}
          onCreate={(name) => {
            const id = crypto.randomUUID();
            setBoards(prev => [...prev, { id, name: name.trim() || "New Board", kind: "list" }]);
            setCurrentBoardId(id);
          }}
          onRename={(id, name) => setBoards(prev => prev.map(b => b.id===id ? {...b, name: name.trim() || b.name} : b))}
          onDelete={(id) => {
            const b = boards.find(x => x.id === id);
            if (!b || b.kind === "week") return; // cannot delete Week
            setBoards(prev => prev.filter(x => x.id !== id));
            setTasks(prev => prev.filter(t => t.boardId !== id));
            if (currentBoardId === id) setCurrentBoardId(boards[0].id);
          }}
        />
      )}
    </div>
  );
}

/* ================= Subcomponents ================= */

function renderTitleWithLink(title: string, note?: string) {
  const url = firstUrl(note || "");
  if (!url) return title;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="underline decoration-neutral-500 hover:decoration-emerald-500">
      {title}
    </a>
  );
}

function firstUrl(text: string): string | null {
  // simple, safe-enough URL detector
  const m = text.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}
function autolink(text: string) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/gi);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//i.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="underline decoration-neutral-500 hover:decoration-emerald-500 break-words">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

// Horizontal, fixed-width column container
function DroppableColumn({
  title,
  onDropCard,
  children,
}: {
  title: string;
  onDropCard: (payload: { id: string }) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current!;
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer?.getData("text/task-id");
      if (id) onDropCard({ id });
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
    };
  }, [onDropCard]);

  return (
    <div
      ref={ref}
      className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-3 min-h-[18rem] w-[18rem] shrink-0"
      style={{ touchAction: "pan-y" }}
    >
      <div className="font-semibold mb-2">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Card({
  task,
  onComplete,
  onEdit,
  onDelete,
  onDropBefore,
  isLast,
}: {
  task: Task;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDropBefore: (dragId: string) => void;
  isLast: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [overBefore, setOverBefore] = useState(false);

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setDragImage(e.currentTarget as HTMLElement, 0, 0);
  }
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    setOverBefore(e.clientY < midpoint);
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const dragId = e.dataTransfer.getData("text/task-id");
    if (dragId) onDropBefore(dragId);
    setOverBefore(false);
  }
  function handleDragLeave() { setOverBefore(false); }

  return (
    <div
      ref={cardRef}
      className="group relative p-3 rounded-xl bg-neutral-800 border border-neutral-700 select-none"
      style={{ touchAction: "pan-y" }}
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {/* insert-before indicator */}
      {overBefore && (
        <div className="absolute -top-[2px] left-0 right-0 h-[3px] bg-emerald-500 rounded-full" />
      )}

      <div className="flex items-start gap-2">
        {/* Unchecked circular "complete" button (click only) */}
        <button
          onClick={onComplete}
          aria-label="Complete task"
          title="Mark complete"
          className="flex items-center justify-center w-8 h-8 rounded-full border border-neutral-600 text-neutral-300 hover:text-emerald-500 hover:border-emerald-500 transition"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" className="pointer-events-none">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>

        {/* Title (hyperlinked if note contains a URL) */}
        <div className="flex-1 cursor-pointer" onClick={onEdit}>
          <div className="text-sm font-medium leading-5 break-words">
            {renderTitleWithLink(task.title, task.note)}
          </div>
          {!!task.note && <div className="text-xs text-neutral-400 break-words">{autolink(task.note)}</div>}
        </div>

        {/* Circular edit/delete buttons */}
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <IconButton label="Edit" onClick={onEdit}>✎</IconButton>
          <IconButton label="Delete" onClick={onDelete} intent="danger">🗑</IconButton>
        </div>
      </div>
    </div>
  );
}

/* Small circular icon button */
function IconButton({
  children, onClick, label, intent
}: React.PropsWithChildren<{ onClick: ()=>void; label: string; intent?: "danger"|"success" }>) {
  const base = "w-8 h-8 rounded-full inline-flex items-center justify-center text-xs border border-transparent bg-neutral-700/40 hover:bg-neutral-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500";
  const danger = " bg-rose-700/30 hover:bg-rose-700/50";
  const success = " bg-emerald-700/30 hover:bg-emerald-700/50";
  const cls = base + (intent==="danger" ? danger : intent==="success" ? success : "");
  return <button aria-label={label} title={label} className={cls} onClick={onClick}>{children}</button>;
}

/* ---------- Recurrence helpers & UI ---------- */
function labelOf(r: Recurrence): string {
  switch (r.type) {
    case "none": return "None";
    case "daily": return "Daily";
    case "weekly": return `Weekly on ${r.days.map((d) => WD_SHORT[d]).join(", ") || "(none)"}`;
    case "every": return `Every ${r.n} ${r.unit === "day" ? "day(s)" : "week(s)"}`;
    case "monthlyDay": return `Monthly on day ${r.day}`;
  }
}

/* Edit modal with Advanced recurrence */
function EditModal({ task, onCancel, onDelete, onSave }: {
  task: Task; onCancel: ()=>void; onDelete: ()=>void; onSave: (t: Task)=>void;
}) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note || "");
  const [rule, setRule] = useState<Recurrence>(task.recurrence ?? R_NONE);
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <Modal onClose={onCancel} title="Edit task">
      <div className="space-y-4">
        <input value={title} onChange={e=>setTitle(e.target.value)}
               className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" placeholder="Title"/>
        <textarea value={note} onChange={e=>setNote(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" rows={3}
                  placeholder="Notes (optional)"/>

        {/* Recurrence section */}
        <div className="rounded-xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">Recurrence</div>
            <div className="ml-auto text-xs text-neutral-400">{labelOf(rule)}</div>
          </div>
          <div className="mt-2 flex gap-2 flex-wrap">
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setRule(R_NONE)}>None</button>
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setRule({ type: "daily" })}>Daily</button>
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setRule({ type: "weekly", days: [1,2,3,4,5] })}>Mon–Fri</button>
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setRule({ type: "weekly", days: [0,6] })}>Weekends</button>
            <button className="ml-auto px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setShowAdvanced(true)} title="Advanced recurrence…">Advanced…</button>
          </div>
        </div>

        <div className="pt-2 flex justify-between">
          <button className="px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600" onClick={onDelete}>Delete</button>
          <div className="space-x-2">
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={onCancel}>Cancel</button>
            <button className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
                    onClick={()=>onSave({...task, title, note: note || undefined, recurrence: rule.type==="none"? undefined : rule})}>
              Save
            </button>
          </div>
        </div>
      </div>

      {showAdvanced && (
        <RecurrenceModal
          initial={rule}
          onClose={() => setShowAdvanced(false)}
          onApply={(r) => { setRule(r); setShowAdvanced(false); }}
        />
      )}
    </Modal>
  );
}

/* Advanced recurrence modal & picker */
function RecurrenceModal({
  initial, onClose, onApply,
}: { initial: Recurrence; onClose: () => void; onApply: (r: Recurrence) => void; }) {
  const [value, setValue] = useState<Recurrence>(initial);

  return (
    <Modal onClose={onClose} title="Advanced recurrence">
      <RecurrencePicker value={value} onChange={setValue} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={onClose}>Cancel</button>
        <button className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500" onClick={() => onApply(value)}>Apply</button>
      </div>
    </Modal>
  );
}

function RecurrencePicker({ value, onChange }: { value: Recurrence; onChange: (r: Recurrence)=>void }) {
  const [weekly, setWeekly] = useState<Set<Weekday>>(new Set());
  const [everyN, setEveryN] = useState(2);
  const [unit, setUnit] = useState<"day"|"week">("day");
  const [monthDay, setMonthDay] = useState(15);

  useEffect(()=>{
    switch (value.type) {
      case "weekly": setWeekly(new Set(value.days)); break;
      case "every": setEveryN(value.n); setUnit(value.unit); break;
      case "monthlyDay": setMonthDay(value.day); break;
      default: setWeekly(new Set());
    }
  }, [value]);

  function setNone() { onChange({ type: "none" }); }
  function setDaily() { onChange({ type: "daily" }); }
  function toggleDay(d: Weekday) {
    const next = new Set(weekly);
    next.has(d) ? next.delete(d) : next.add(d);
    setWeekly(next);
    const sorted = Array.from(next).sort((a,b)=>a-b);
    onChange(sorted.length ? { type: "weekly", days: sorted } : { type: "none" });
  }
  function applyEvery() { onChange({ type:"every", n: Math.max(1, everyN || 1), unit }); }
  function applyMonthly() { onChange({ type:"monthlyDay", day: Math.min(28, Math.max(1, monthDay)) }); }

  return (
    <div className="space-y-5">
      <section>
        <div className="text-sm font-medium mb-2">Preset</div>
        <div className="flex gap-2">
          <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={setNone}>None</button>
          <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={setDaily}>Daily</button>
        </div>
      </section>

      <section>
        <div className="text-sm font-medium mb-2">Weekly</div>
        <div className="grid grid-cols-3 gap-2">
          {Array.from({length:7},(_,i)=>i as Weekday).map(d=>{
            const on = weekly.has(d);
            return (
              <button key={d} onClick={()=>toggleDay(d)}
                      className={`px-2 py-2 rounded-xl ${on ? "bg-emerald-600":"bg-neutral-800"}`}>
                {WD_SHORT[d]}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="text-sm font-medium mb-2">Every N</div>
        <div className="flex items-center gap-2">
          <input type="number" min={1} max={30} value={everyN}
                 onChange={e=>setEveryN(parseInt(e.target.value || "1",10))}
                 className="w-20 px-2 py-2 rounded-xl bg-neutral-900 border border-neutral-800"/>
          <select value={unit} onChange={e=>setUnit(e.target.value as "day"|"week")}
                  className="px-2 py-2 rounded-xl bg-neutral-900 border border-neutral-800">
            <option value="day">Days</option>
            <option value="week">Weeks</option>
          </select>
          <button className="ml-2 px-3 py-2 rounded-xl bg-neutral-800" onClick={applyEvery}>Apply</button>
        </div>
      </section>

      <section>
        <div className="text-sm font-medium mb-2">Monthly</div>
        <div className="flex items-center gap-2">
          <select value={monthDay} onChange={e=>setMonthDay(parseInt(e.target.value,10))}
                  className="px-2 py-2 rounded-xl bg-neutral-900 border border-neutral-800" size={5}>
            {Array.from({length:28},(_,i)=>i+1).map(d=>(
              <option key={d} value={d}>Day {d}</option>
            ))}
          </select>
          <button className="ml-2 px-3 py-2 rounded-xl bg-neutral-800" onClick={applyMonthly}>Apply</button>
        </div>
      </section>
    </div>
  );
}

/* Generic modal */
function Modal({ children, onClose, title }: React.PropsWithChildren<{ onClose: ()=>void; title?: string }>) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[min(720px,92vw)] max-h-[80vh] overflow-auto bg-neutral-900 border border-neutral-700 rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-lg font-semibold">{title}</div>
          <button className="ml-auto px-3 py-1 rounded bg-neutral-800" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* Side drawer (right) */
function SideDrawer({ title, onClose, children }: React.PropsWithChildren<{ title?: string; onClose: ()=>void }>) {
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute right-0 top-0 bottom-0 w-[min(380px,92vw)] bg-neutral-900 border-l border-neutral-800 p-4 shadow-2xl">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-lg font-semibold">{title}</div>
          <button className="ml-auto px-3 py-1 rounded bg-neutral-800" onClick={onClose}>Close</button>
        </div>
        <div className="overflow-y-auto max-h-[calc(100vh-80px)]">{children}</div>
      </div>
    </div>
  );
}

/* Manage Boards Modal */
function ManageBoardsModal({
  boards,
  onClose,
  onCreate,
  onRename,
  onDelete,
}: {
  boards: Board[];
  onClose: () => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState("");

  return (
    <Modal onClose={onClose} title="Boards">
      <div className="space-y-4">
        <div className="rounded-xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="text-sm font-medium mb-2">Create a new board</div>
          <div className="flex gap-2">
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="Board name (e.g., Groceries)"
                   className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"/>
            <button className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
                    onClick={()=>{ if (name.trim()) { onCreate(name.trim()); setName(""); }}}>
              Create
            </button>
          </div>
          <div className="text-xs text-neutral-400 mt-2">New boards are simple single-column lists. (We can add multi-column custom boards later.)</div>
        </div>

        <div>
          <div className="text-sm font-medium mb-2">Your boards</div>
          <ul className="space-y-2">
            {boards.map(b => (
              <li key={b.id} className="p-3 rounded-xl bg-neutral-900 border border-neutral-800">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium">{b.name} {b.kind === "week" && <span className="text-xs text-neutral-400">(Week)</span>}</div>
                  <div className="ml-auto flex gap-2">
                    <button className="px-3 py-1 rounded-full bg-neutral-800"
                            onClick={()=>{
                              const newName = prompt("Rename board", b.name);
                              if (newName != null) onRename(b.id, newName);
                            }}>
                      Rename
                    </button>
                    <button className={`px-3 py-1 rounded-full ${b.kind==="week" ? "bg-neutral-800 text-neutral-500 cursor-not-allowed" : "bg-rose-600/80 hover:bg-rose-600"}`}
                            disabled={b.kind==="week"}
                            onClick={()=> onDelete(b.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-end">
          <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}