import React, { useEffect, useMemo, useRef, useState } from "react";

/* ================= Types ================= */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun
type DayChoice =
  | Weekday
  | "bounties"
  | "items"
  | { kind: "custom"; columnId: string };

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
  dueISO: string; // used for week board grouping
  completed?: boolean;
  completedAt?: string;
  recurrence?: Recurrence;
  column?: "day" | "bounties" | "items"; // legacy/simple
  customColumnId?: string; // for custom boards
  hiddenUntilISO?: string;
};

type BoardColumn = { id: string; name: string };
type Board =
  | { id: string; name: string; kind: "week" }
  | { id: string; name: string; kind: "custom"; columns: BoardColumn[] };

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
      const y = cur.getFullYear(),
        m = cur.getMonth();
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
  const ws = weekStart === 1 || weekStart === 6 ? weekStart : 0;
  let diff = current - ws;
  if (diff < 0) diff += 7;
  return new Date(sd.getTime() - diff * 86400000);
}
function hiddenUntilForNext(
  nextISO: string,
  rule: Recurrence,
  weekStart: Weekday
): string | undefined {
  const nextMidnight = startOfDay(new Date(nextISO));
  if (rule.type === "daily") {
    return nextMidnight.toISOString();
  }
  if (rule.type === "weekly") {
    const sow = startOfWeek(nextMidnight, weekStart);
    return sow.toISOString();
  }
  const dayBefore = new Date(nextMidnight.getTime() - 86400000);
  return startOfDay(dayBefore).toISOString();
}

/* ================= Storage hooks ================= */
function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_SETTINGS) || "") || {
        weekStart: 0,
      };
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
    const boards = stored as Board[];
    if (!Array.isArray(boards)) return null;
    let changed = false;
    const out = boards.map((b: any) => {
      if (b.kind === "list") {
        changed = true;
        return {
          id: b.id,
          name: b.name,
          kind: "custom",
          columns: [{ id: "items", name: "Items" }],
        } as Board;
      }
      return b;
    });
    return changed ? out : boards;
  } catch {
    return null;
  }
}

function useBoards() {
  const [boards, setBoards] = useState<Board[]>(() => {
    const raw = localStorage.getItem(LS_BOARDS);
    if (raw) {
      const migrated = migrateBoards(JSON.parse(raw));
      if (migrated && migrated.length) return migrated;
    }
    return [{ id: "week-default", name: "Week", kind: "week" }];
  });
  useEffect(() => {
    localStorage.setItem(LS_BOARDS, JSON.stringify(boards));
  }, [boards]);
  return [boards, setBoards] as const;
}

function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_TASKS) || "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem(LS_TASKS, JSON.stringify(tasks));
  }, [tasks]);
  return [tasks, setTasks] as const;
}

/* ================= App ================= */
export default function App() {
  const [boards, setBoards] = useBoards();
  const [currentBoardId, setCurrentBoardId] = useState(boards[0].id);
  const currentBoard = boards.find((b) => b.id === currentBoardId)!;

  const [tasks, setTasks] = useTasks();
  const [settings, setSettings] = useSettings();

  // header view
  const [view, setView] = useState<"board" | "completed">("board");
  const [showSettings, setShowSettings] = useState(false);

  // add bar
  const defaultDay: DayChoice =
    currentBoard?.kind === "custom"
      ? { kind: "custom", columnId: currentBoard.columns[0].id }
      : (new Date().getDay() as Weekday);
  const [newTitle, setNewTitle] = useState("");
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
    () => tasks.filter((t) => t.boardId === currentBoardId),
    [tasks, currentBoardId]
  );

  const byDay = useMemo(() => {
    if (currentBoard.kind !== "week") return new Map<Weekday, Task[]>();
    const visible = tasksForBoard.filter(
      (t) =>
        !t.completed &&
        t.column !== "bounties" &&
        !t.customColumnId &&
        isVisibleNow(t)
    );
    const m = new Map<Weekday, Task[]>();
    for (const t of visible) {
      const wd = new Date(t.dueISO).getDay() as Weekday;
      if (!m.has(wd)) m.set(wd, []);
      m.get(wd)!.push(t);
    }
    return m;
  }, [tasksForBoard, currentBoard.kind]);

  const bounties = useMemo(
    () =>
      currentBoard.kind === "week"
        ? tasksForBoard.filter(
            (t) =>
              !t.completed &&
              t.column === "bounties" &&
              !t.customColumnId &&
              isVisibleNow(t)
          )
        : [],
    [tasksForBoard, currentBoard.kind]
  );

  // custom board columns map
  const customColumns = (currentBoard.kind === "custom"
    ? currentBoard.columns
    : []) as BoardColumn[];

  const byCustomColumn = useMemo(() => {
    if (currentBoard.kind !== "custom") return new Map<string, Task[]>();
    const visible = tasksForBoard.filter(
      (t) => !t.completed && t.customColumnId && isVisibleNow(t)
    );
    const m = new Map<string, Task[]>();
    for (const t of visible) {
      const key = t.customColumnId!;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(t);
    }
    return m;
  }, [tasksForBoard, currentBoard.kind]);

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
  function renderTitleWithLink(title: string, note?: string) {
    const url = firstUrl(note || "");
    if (!url) return title;
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-neutral-500 hover:decoration-emerald-500"
      >
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
            <a
              key={i}
              href={p}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-neutral-500 hover:decoration-emerald-500 break-words"
            >
              {p}
            </a>
          ) : (
            <span key={i}>{p}</span>
          )
        )}
      </>
    );
  }

  function resolveQuickRule(): Recurrence {
    switch (quickRule) {
      case "none":
        return R_NONE;
      case "daily":
        return { type: "daily" };
      case "weeklyMonFri":
        return { type: "weekly", days: [1, 2, 3, 4, 5] };
      case "weeklyWeekends":
        return { type: "weekly", days: [0, 6] };
      case "every2d":
        return { type: "every", n: 2, unit: "day" };
      case "custom":
        return addCustomRule;
    }
  }

  function addTask() {
    if (!newTitle.trim()) return;
    const title = newTitle.trim();
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
      const colId =
        typeof dayChoice === "object" && dayChoice.kind === "custom"
          ? dayChoice.columnId
          : currentBoard.columns[0].id;
      t.customColumnId = colId;
      t.dueISO = isoForWeekday(0);
    }

    setTasks((prev) => [...prev, t]);
    setNewTitle("");
    setQuickRule("none");
    setAddCustomRule(R_NONE);
  }

  function completeTask(id: string) {
    setTasks((prev) => {
      const cur = prev.find((t) => t.id === id);
      if (!cur) return prev;
      const now = new Date().toISOString();
      const updated = prev.map((t) =>
        t.id === id ? { ...t, completed: true, completedAt: now } : t
      );
      const nextISO = cur.recurrence
        ? nextOccurrence(cur.dueISO, cur.recurrence)
        : null;
      if (nextISO && cur.recurrence) {
        const clone: Task = {
          ...cur,
          id: crypto.randomUUID(),
          completed: false,
          completedAt: undefined,
          dueISO: nextISO,
          hiddenUntilISO: hiddenUntilForNext(
            nextISO,
            cur.recurrence,
            settings.weekStart
          ),
        };
        return [...updated, clone];
      }
      return updated;
    });
    burst();
  }

  function deleteTask(id: string) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    setUndoTask(t);
    setTasks((prev) => prev.filter((x) => x.id !== id));
    setTimeout(() => setUndoTask(null), 5000);
  }
  function undoDelete() {
    if (undoTask) {
      setTasks((prev) => [...prev, undoTask]);
      setUndoTask(null);
    }
  }
  function restoreTask(id: string) {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, completed: false, completedAt: undefined } : t
      )
    );
    setView("board");
  }
  function clearCompleted() {
    setTasks((prev) => prev.filter((t) => !t.completed));
  }
  function saveEdit(updated: Task) {
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setEditing(null);
  }

  /* ---------- Drag & Drop: move or reorder ---------- */
  function moveTask(
    id: string,
    target:
      | { type: "day"; day: Weekday }
      | { type: "bounties" }
      | { type: "custom"; columnId: string },
    beforeId?: string
  ) {
    setTasks((prev) => {
      const arr = [...prev];
      const fromIdx = arr.findIndex((t) => t.id === id);
      if (fromIdx < 0) return prev;
      const task = arr[fromIdx];
      let updated: Task = { ...task };

      if (target.type === "day") {
        updated.column = "day";
        updated.customColumnId = undefined;
        updated.dueISO = isoForWeekday(target.day);
      } else if (target.type === "bounties") {
        updated.column = "bounties";
        updated.customColumnId = undefined;
        updated.dueISO = isoForWeekday(0);
      } else {
        updated.column = undefined;
        updated.customColumnId = target.columnId;
        updated.dueISO = isoForWeekday(0);
      }
      updated.hiddenUntilISO = undefined; // reveal if manually moved

      arr.splice(fromIdx, 1);
      let insertIdx =
        typeof beforeId === "string"
          ? arr.findIndex((t) => t.id === beforeId)
          : -1;
      if (insertIdx < 0) insertIdx = arr.length;
      arr.splice(insertIdx, 0, updated);
      return arr;
    });
  }

  // reset dayChoice when board changes
  useEffect(() => {
    if (currentBoard.kind === "custom") {
      setDayChoice({ kind: "custom", columnId: currentBoard.columns[0].id });
    } else {
      setDayChoice(new Date().getDay() as Weekday);
    }
  }, [currentBoardId]);

  /* ================= Render ================= */
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
              onChange={(e) => setCurrentBoardId(e.target.value)}
              className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              title="Boards"
            >
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
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
              <button
                className={`px-3 py-2 ${
                  view === "board" ? "bg-neutral-800" : ""
                }`}
                onClick={() => setView("board")}
              >
                Board
              </button>
              <button
                className={`px-3 py-2 ${
                  view === "completed" ? "bg-neutral-800" : ""
                }`}
                onClick={() => setView("completed")}
              >
                Completed
              </button>
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
                value={
                  dayChoice === "bounties" ? "bounties" : String(dayChoice)
                }
                onChange={(e) => {
                  const v = e.target.value;
                  setDayChoice(
                    v === "bounties" ? "bounties" : (Number(v) as Weekday)
                  );
                }}
                className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              >
                {WD_SHORT.map((d, i) => (
                  <option key={i} value={i}>
                    {d}
                  </option>
                ))}
                <option value="bounties">Bounties</option>
              </select>
            ) : (
              <select
                value={
                  typeof dayChoice === "object" && dayChoice.kind === "custom"
                    ? dayChoice.columnId
                    : (currentBoard.columns[0]?.id || "")
                }
                onChange={(e) =>
                  setDayChoice({ kind: "custom", columnId: e.target.value })
                }
                className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              >
                {currentBoard.columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
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
              <span className="text-xs text-neutral-400">
                ({labelOf(addCustomRule)})
              </span>
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
              {/* HORIZONTAL board (smooth) */}
              <div
                className="overflow-x-auto pb-4"
                style={{
                  WebkitOverflowScrolling: "touch",
                  scrollSnapType: "x mandatory",
                  overscrollBehaviorX: "contain",
                }}
              >
                <div className="flex gap-4 min-w-max">
                  {Array.from({ length: 7 }, (_, i) => i as Weekday).map(
                    (day) => (
                      <DroppableColumn
                        key={day}
                        title={WD_SHORT[day]}
                        snap
                        onDropCard={(payload) =>
                          moveTask(payload.id, { type: "day", day })
                        }
                      >
                        {(byDay.get(day) || []).map((t, idx, arr) => (
                          <Card
                            key={t.id}
                            task={t}
                            onComplete={() => completeTask(t.id)}
                            onEdit={() => setEditing(t)}
                            onDelete={() => deleteTask(t.id)}
                            onDropBefore={(dragId) =>
                              moveTask(dragId, { type: "day", day }, t.id)
                            }
                            isLast={idx === arr.length - 1}
                          />
                        ))}
                      </DroppableColumn>
                    )
                  )}

                  {/* Bounties */}
                  <DroppableColumn
                    title="Bounties"
                    snap
                    onDropCard={(payload) =>
                      moveTask(payload.id, { type: "bounties" })
                    }
                  >
                    {bounties.map((t, idx, arr) => (
                      <Card
                        key={t.id}
                        task={t}
                        onComplete={() => completeTask(t.id)}
                        onEdit={() => setEditing(t)}
                        onDelete={() => deleteTask(t.id)}
                        onDropBefore={(dragId) =>
                          moveTask(dragId, { type: "bounties" }, t.id)
                        }
                        isLast={idx === arr.length - 1}
                      />
                    ))}
                  </DroppableColumn>
                </div>
              </div>
            </>
          ) : (
            // CUSTOM board: multi-column, horizontal scroll
            <div
              className="overflow-x-auto pb-4"
              style={{
                WebkitOverflowScrolling: "touch",
                scrollSnapType: "x mandatory",
                overscrollBehaviorX: "contain",
              }}
            >
              <div className="flex gap-4 min-w-max">
                {customColumns.map((col) => (
                  <DroppableColumn
                    key={col.id}
                    title={col.name}
                    snap
                    onDropCard={(payload) =>
                      moveTask(payload.id, { type: "custom", columnId: col.id })
                    }
                  >
                    {(byCustomColumn.get(col.id) || []).map((t, idx, arr) => (
                      <Card
                        key={t.id}
                        task={t}
                        onComplete={() => completeTask(t.id)}
                        onEdit={() => setEditing(t)}
                        onDelete={() => deleteTask(t.id)}
                        onDropBefore={(dragId) =>
                          moveTask(
                            dragId,
                            { type: "custom", columnId: col.id },
                            t.id
                          )
                        }
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
              <div className="text-neutral-400 text-sm">
                No completed tasks yet.
              </div>
            ) : (
              <ul className="space-y-2">
                {completed.map((t) => (
                  <li
                    key={t.id}
                    className="p-3 rounded-xl bg-neutral-800 border border-neutral-700"
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                        <div className="text-sm font-medium">
                          {renderTitleWithLink(t.title, t.note)}
                        </div>
                        <div className="text-xs text-neutral-400">
                          {currentBoard.kind === "week"
                            ? `Due ${
                                WD_SHORT[new Date(t.dueISO).getDay() as Weekday]
                              }`
                            : "Completed item"}
                          {t.completedAt
                            ? ` • Completed ${new Date(
                                t.completedAt
                              ).toLocaleString()}`
                            : ""}
                        </div>
                        {!!t.note && (
                          <div className="text-xs text-neutral-400 mt-1 break-words">
                            {autolink(t.note)}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <IconButton
                          label="Restore"
                          onClick={() => restoreTask(t.id)}
                          intent="success"
                        >
                          ↩︎
                        </IconButton>
                        <IconButton
                          label="Delete"
                          onClick={() => deleteTask(t.id)}
                          intent="danger"
                        >
                          🗑
                        </IconButton>
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
                <li
                  key={t.id}
                  className="p-3 rounded-xl bg-neutral-900 border border-neutral-800"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <div className="text-sm font-medium">
                        {renderTitleWithLink(t.title, t.note)}
                      </div>
                      <div className="text-xs text-neutral-400">
                        {currentBoard.kind === "week"
                          ? `Due ${
                              WD_SHORT[new Date(t.dueISO).getDay() as Weekday]
                            }`
                          : "Hidden item"}
                        {t.hiddenUntilISO
                          ? ` • Reveals ${new Date(
                              t.hiddenUntilISO
                            ).toLocaleDateString()}`
                          : ""}
                      </div>
                      {!!t.note && (
                        <div className="text-xs text-neutral-400 mt-1 break-words">
                          {autolink(t.note)}
                        </div>
                      )}
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
                      onClick={() => {
                        setEditing(t);
                        setShowUpcoming(false);
                      }}
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
          <button
            onClick={undoDelete}
            className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500"
          >
            Undo
          </button>
        </div>
      )}

      {/* Edit Modal (with Advanced recurrence) */}
      {editing && (
        <EditModal
          task={editing}
          onCancel={() => setEditing(null)}
          onDelete={() => {
            deleteTask(editing.id);
            setEditing(null);
          }}
          onSave={saveEdit}
        />