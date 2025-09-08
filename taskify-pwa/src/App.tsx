import React, { useEffect, useMemo, useRef, useState } from "react";

/* ================= Types ================= */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun
type DayChoice = Weekday | "bounties" | string; // string = custom list columnId
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
  dueISO: string;                 // for week board day grouping
  completed?: boolean;
  completedAt?: string;
  recurrence?: Recurrence;
  // Week board columns:
  column?: "day" | "bounties";
  // Custom boards (multi-list):
  columnId?: string;
  hiddenUntilISO?: string;        // controls visibility (appear at/after this date)
};

type ListColumn = { id: string; name: string };

type Board =
  | { id: string; name: string; kind: "week" } // fixed Sun–Sat + Bounties
  | { id: string; name: string; kind: "lists"; columns: ListColumn[] }; // multiple customizable columns

type Settings = {
  weekStart: Weekday; // 0=Sun, 1=Mon, 6=Sat
};

const R_NONE: Recurrence = { type: "none" };
const LS_TASKS = "taskify_tasks_v4";
const LS_SETTINGS = "taskify_settings_v2";
const LS_BOARDS = "taskify_boards_v2";

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
  if (rule.type === "daily") return nextMidnight.toISOString(); // midnight on due day
  if (rule.type === "weekly") {
    const sow = startOfWeek(nextMidnight, weekStart);
    return sow.toISOString(); // midnight at start of that week
  }
  const dayBefore = new Date(nextMidnight.getTime() - 86400000);
  return startOfDay(dayBefore).toISOString(); // others: day before
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

function migrateBoards(stored: any): Board[] | null {
  try {
    const arr = stored as any[];
    if (!Array.isArray(arr)) return null;
    return arr.map((b) => {
      if (b?.kind === "week") return b as Board;
      if (b?.kind === "lists" && Array.isArray(b.columns)) return b as Board;
      if (b?.kind === "list") {
        // old single-column boards -> migrate to lists with one column
        const colId = crypto.randomUUID();
        return { id: b.id, name: b.name, kind: "lists", columns: [{ id: colId, name: "Items" }] } as Board;
      }
      // unknown -> keep as lists with one column
      const colId = crypto.randomUUID();
      return { id: b?.id || crypto.randomUUID(), name: b?.name || "Board", kind: "lists", columns: [{ id: colId, name: "Items" }] } as Board;
    });
  } catch { return null; }
}

function useBoards() {
  const [boards, setBoards] = useState<Board[]>(() => {
    const raw = localStorage.getItem(LS_BOARDS);
    if (raw) {
      const migrated = migrateBoards(JSON.parse(raw));
      if (migrated && migrated.length) return migrated;
    }
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

  // add bar
  const [newTitle, setNewTitle] = useState("");
  const [dayChoice, setDayChoice] = useState<DayChoice>(() => {
    return (boards[0].kind === "lists")
      ? (boards[0] as Extract<Board, {kind:"lists"}>).columns[0]?.id || "items"
      : (new Date().getDay() as Weekday);
  });

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

  // Week board
  const byDay = useMemo(() => {
    if (currentBoard.kind !== "week") return new Map<Weekday, Task[]>();
    const visible = tasksForBoard.filter(t => !t.completed && t.column !== "bounties" && isVisibleNow(t));
    const m = new Map<Weekday, Task[]>();
    for (const t of visible) {
      const wd = new Date(t.dueISO).getDay() as Weekday;
      if (!m.has(wd)) m.set(wd, []);
      m.get(wd)!.push(t); // preserve insertion order for manual reordering
    }
    return m;
  }, [tasksForBoard, currentBoard.kind]);

  const bounties = useMemo(
    () => currentBoard.kind === "week"
      ? tasksForBoard.filter(t => !t.completed && t.column === "bounties" && isVisibleNow(t))
      : [],
    [tasksForBoard, currentBoard.kind]
  );

  // Custom list boards
  const listColumns = (currentBoard.kind === "lists") ? currentBoard.columns : [];
  const itemsByColumn = useMemo(() => {
    if (currentBoard.kind !== "lists") return new Map<string, Task[]>();
    const m = new Map<string, Task[]>();
    const visible = tasksForBoard.filter(t => !t.completed && t.columnId && isVisibleNow(t));
    for (const col of currentBoard.columns) m.set(col.id, []);
    for (const t of visible) {
      const arr = m.get(t.columnId!);
      if (arr) arr.push(t);
    }
    return m;
  }, [tasksForBoard, currentBoard]);

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

    let t: Task = {
      id: crypto.randomUUID(),
      boardId: currentBoard.id,
      title,
      dueISO: isoForWeekday(0),
      completed: false,
      recurrence,
    };

    if (currentBoard.kind === "week") {
      if (dayChoice === "bounties") {
        t.column = "bounties";
        t.dueISO = isoForWeekday(0);
      } else {
        t.column = "day";
        t.dueISO = isoForWeekday(dayChoice as Weekday);
      }
    } else {
      // lists board
      const firstCol = currentBoard.columns[0];
      const selectedColId = typeof dayChoice === "string" ? dayChoice : firstCol?.id;
      t.columnId = selectedColId || firstCol?.id;
      t.dueISO = isoForWeekday(0);
    }

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
    target:
      | { type: "day"; day: Weekday }
      | { type: "bounties" }
      | { type: "list"; columnId: string },
    beforeId?: string
  ) {
    setTasks(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(t => t.id === id);
      if (fromIdx < 0) return prev;
      const task = arr[fromIdx];

      let updated: Task = { ...task };
      if (target.type === "day") {
        updated.column = "day";
        updated.columnId = undefined;
        updated.dueISO = isoForWeekday(target.day);
      } else if (target.type === "bounties") {
        updated.column = "bounties";
        updated.columnId = undefined;
        updated.dueISO = isoForWeekday(0);
      } else {
        updated.column = undefined;
        updated.columnId = target.columnId;
        updated.dueISO = isoForWeekday(0);
      }
      // reveal if user manually places it
      updated.hiddenUntilISO = undefined;

      // remove original
      arr.splice(fromIdx, 1);
      // compute insert index relative to new array
      let insertIdx = typeof beforeId === "string" ? arr.findIndex(t => t.id === beforeId) : -1;
      if (insertIdx < 0) insertIdx = arr.length;
      arr.splice(insertIdx, 0, updated);
      return arr;
    });
  }

  // reset dayChoice when board changes
  useEffect(() => {
    if (currentBoard.kind === "lists") {
      const firstCol = currentBoard.columns[0];
      setDayChoice(firstCol?.id || crypto.randomUUID());
    } else {
      setDayChoice(new Date().getDay() as Weekday);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBoardId]);

  // horizontal scroller ref to enable iOS momentum scrolling
  const scrollerRef = useRef<HTMLDivElement>(null);

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
                value={String(dayChoice)}
                onChange={(e)=>setDayChoice(e.target.value)}
                className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              >
                {listColumns.map(c => (<option key={c.id} value={c.id}>{c.name}</option>))}
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
              <div
                ref={scrollerRef}
                className="overflow-x-auto pb-4"
                style={{ WebkitOverflowScrolling: "touch" }} // fluid momentum scroll on iOS
              >
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
            // LISTS board (multiple custom columns) — still a horizontal row
            <div
              ref={scrollerRef}
              className="overflow-x-auto pb-4"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className="flex gap-4 min-w-max">
                {listColumns.map(col => (
                  <DroppableColumn
                    key={col.id}
                    title={col.name}
                    onDropCard={(payload) => moveTask(payload.id, { type: "list", columnId: col.id })}
                  >
                    {(itemsByColumn.get(col.id) || []).map((t, idx, arr) => (
                      <Card
                        key={t.id}
                        task={t}
                        onComplete={() => completeTask(t.id)}
                        onEdit={() => setEditing(t)}
                        onDelete={() => deleteTask(t.id)}
                        onDropBefore={(dragId) => moveTask(dragId, { type: "list", columnId: col.id }, t.id)}
                        isLast={idx === arr.length - 1}
                      />
                    ))}
                  </DroppableColumn>
                ))}
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

      {/* Settings (Week start + Manage Boards & Columns) */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          boards={boards}
          currentBoardId={currentBoardId}
          setSettings={setSettings}
          setBoards={setBoards}
          setCurrentBoardId={setCurrentBoardId}
          onClose={() => setShowSettings(false)}
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

// Column container (fixed width for consistent horizontal scroll)
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
      // No touchAction lock so horizontal scrolling stays fluid
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
          {!!task.note && (
  <div
    className="text-xs text-neutral-400 break-words"
    style={{
      display: "-webkit-box",
      WebkitLineClamp: 2,       // number of lines to show in preview
      WebkitBoxOrient: "vertical",
      overflow: "hidden"
    }}
    title={task.note} // optional: hover to see full note as tooltip (desktop)
  >
    {autolink(task.note)}
  </div>
)}
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

/* Settings modal incl. Week start + Manage Boards & Columns */
function SettingsModal({
  settings,
  boards,
  currentBoardId,
  setSettings,
  setBoards,
  setCurrentBoardId,
  onClose,
}: {
  settings: Settings;
  boards: Board[];
  currentBoardId: string;
  setSettings: (s: Settings) => void;
  setBoards: React.Dispatch<React.SetStateAction<Board[]>>;
  setCurrentBoardId: (id: string) => void;
  onClose: () => void;
}) {
  const [newBoardName, setNewBoardName] = useState("");
  const [selectedBoardId, setSelectedBoardId] = useState(currentBoardId);
  const selectedBoard = boards.find(b => b.id === selectedBoardId)!;

  function addBoard() {
    const name = newBoardName.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    const board: Board = { id, name, kind: "lists", columns: [{ id: crypto.randomUUID(), name: "List 1" }] };
    setBoards(prev => [...prev, board]);
    setNewBoardName("");
    setSelectedBoardId(id);
    setCurrentBoardId(id);
  }

  function renameBoard(id: string) {
    const b = boards.find(x => x.id === id);
    if (!b) return;
    const name = prompt("Rename board", b.name);
    if (name == null) return;
    const nn = name.trim();
    if (!nn) return;
    setBoards(prev => prev.map(x => x.id === id ? { ...x, name: nn } : x));
  }

  function deleteBoard(id: string) {
    const b = boards.find(x => x.id === id);
    if (!b) return;
    if (b.kind === "week") return alert("The Week board cannot be deleted.");
    if (!confirm(`Delete board “${b.name}”? This will also remove its tasks.`)) return;
    setBoards(prev => prev.filter(x => x.id !== id));
    // Caller (App) removes tasks for deleted board on commit; we keep simple here.
    // Switch away if deleting current
    if (currentBoardId === id) {
      const fallback = boards.find(x => x.id !== id) || { id: "week-default" };
      setCurrentBoardId(fallback.id);
      setSelectedBoardId(fallback.id);
    }
  }

  function addColumn(boardId: string) {
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const col: ListColumn = { id: crypto.randomUUID(), name: `List ${b.columns.length + 1}` };
      return { ...b, columns: [...b.columns, col] };
    }));
  }

  function renameColumn(boardId: string, colId: string) {
    const name = prompt("Rename list");
    if (name == null) return;
    const nn = name.trim();
    if (!nn) return;
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      return { ...b, columns: b.columns.map(c => c.id === colId ? { ...c, name: nn } : c) };
    }));
  }

  function deleteColumn(boardId: string, colId: string) {
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      if (b.columns.length <= 1) return b; // keep at least one
      return { ...b, columns: b.columns.filter(c => c.id !== colId) };
    }));
  }

  return (
    <Modal onClose={onClose} title="Settings">
      <div className="space-y-6">
        {/* Week start */}
        <section>
          <div className="text-sm font-medium mb-2">Week starts on</div>
          <div className="flex gap-2">
            <button className={`px-3 py-2 rounded-xl ${settings.weekStart === 6 ? "bg-emerald-600" : "bg-neutral-800"}`} onClick={() => setSettings({ weekStart: 6 })}>Saturday</button>
            <button className={`px-3 py-2 rounded-xl ${settings.weekStart === 0 ? "bg-emerald-600" : "bg-neutral-800"}`} onClick={() => setSettings({ weekStart: 0 })}>Sunday</button>
            <button className={`px-3 py-2 rounded-xl ${settings.weekStart === 1 ? "bg-emerald-600" : "bg-neutral-800"}`} onClick={() => setSettings({ weekStart: 1 })}>Monday</button>
          </div>
          <div className="text-xs text-neutral-400 mt-2">Affects when weekly recurring tasks re-appear.</div>
        </section>

        {/* Boards & Columns */}
        <section className="rounded-xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Boards & Lists</div>
            <div className="ml-auto" />
          </div>

          {/* Create board */}
          <div className="flex gap-2 mb-3">
            <input
              value={newBoardName}
              onChange={e=>setNewBoardName(e.target.value)}
              placeholder="New board (e.g., Groceries)"
              className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
            />
            <button className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500" onClick={addBoard}>Create</button>
          </div>

          {/* Pick board to manage */}
          <div className="flex items-center gap-2 mb-2">
            <div className="text-sm">Manage:</div>
            <select
              value={selectedBoardId}
              onChange={(e)=>setSelectedBoardId(e.target.value)}
              className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
            >
              {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>renameBoard(selectedBoardId)}>Rename</button>
            <button
              className={`px-3 py-2 rounded-xl ${boards.find(b=>b.id===selectedBoardId)?.kind==="week" ? "bg-neutral-800 text-neutral-500 cursor-not-allowed":"bg-rose-600/80 hover:bg-rose-600"}`}
              disabled={boards.find(b=>b.id===selectedBoardId)?.kind==="week"}
              onClick={()=>deleteBoard(selectedBoardId)}
            >
              Delete
            </button>
          </div>

          {/* Columns (for lists boards) */}
          {selectedBoard?.kind === "lists" ? (
            <div className="mt-3">
              <div className="text-sm font-medium mb-2">Lists in “{selectedBoard.name}”</div>
              <ul className="space-y-2">
                {selectedBoard.columns.map(col => (
                  <li key={col.id} className="p-2 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center gap-2">
                    <div className="text-sm">{col.name}</div>
                    <div className="ml-auto flex gap-2">
                      <button className="px-3 py-1 rounded-full bg-neutral-700 hover:bg-neutral-600" onClick={()=>renameColumn(selectedBoard.id, col.id)}>Rename</button>
                      <button
                        className={`px-3 py-1 rounded-full ${selectedBoard.columns.length<=1 ? "bg-neutral-700 text-neutral-500 cursor-not-allowed":"bg-rose-600/80 hover:bg-rose-600"}`}
                        disabled={selectedBoard.columns.length<=1}
                        onClick={()=>deleteColumn(selectedBoard.id, col.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-2">
                <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>addColumn(selectedBoard.id)}>Add list</button>
              </div>
              <div className="text-xs text-neutral-400 mt-2">Tasks can be dragged between lists directly on the board.</div>
            </div>
          ) : (
            <div className="text-xs text-neutral-400 mt-2">The Week board has fixed columns (Sun–Sat, Bounties).</div>
          )}
        </section>

        <div className="flex justify-end">
          <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}