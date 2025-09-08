import React, { useEffect, useMemo, useRef, useState } from "react";

/* ===== Types ===== */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type Recurrence =
  | { type: "none" }
  | { type: "daily" }
  | { type: "weekly"; days: Weekday[] }
  | { type: "every"; n: number; unit: "day" | "week" }
  | { type: "monthlyDay"; day: number };

type Task = {
  id: string;
  title: string;
  note?: string;
  dueISO: string; // midnight ISO date
  completed?: boolean;
  completedAt?: string;
  recurrence?: Recurrence;
  column?: "day" | "bounties";
};

const R_NONE: Recurrence = { type: "none" };
const LS_KEY = "taskify_mvp_v1";

/* ===== Helpers ===== */
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
      for (let i = 1; i <= 14; i++) {
        const cand = addDays(i);
        const wd = new Date(cand).getDay() as Weekday;
        if (rule.days.includes(wd)) return cand;
      }
      return null;
    }
    case "every":
      return addDays(rule.unit === "day" ? rule.n : rule.n * 7);
    case "monthlyDay": {
      const y = cur.getFullYear();
      const m = cur.getMonth();
      const next = new Date(y, m + 1, Math.min(rule.day, 28));
      return startOfDay(next).toISOString();
    }
  }
}

/* ===== Local storage ===== */
function useLocalTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    } catch {
      return [];
    }
  });
  useEffect(
    () => {
      localStorage.setItem(LS_KEY, JSON.stringify(tasks));
    },
    [tasks]
  );
  return [tasks, setTasks] as const;
}

/* ===== App ===== */
export default function App() {
  const [tasks, setTasks] = useLocalTasks();
  const [newTitle, setNewTitle] = useState("");
  const [activeDay, setActiveDay] = useState<Weekday>(
    new Date().getDay() as Weekday
  );
  const [quickRule, setQuickRule] = useState<
    "none" | "daily" | "weeklyMonFri" | "weeklyWeekends" | "every2d"
  >("none");

  const [undoTask, setUndoTask] = useState<Task | null>(null);

  const byDay = useMemo(
    () => groupByDay(tasks.filter((t) => !t.completed && t.column !== "bounties")),
    [tasks]
  );
  const bounties = useMemo(
    () => tasks.filter((t) => !t.completed && t.column === "bounties"),
    [tasks]
  );

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
    }
  }

  function addTask(day: Weekday, column: "day" | "bounties" = "day") {
    const title = newTitle.trim();
    if (!title) return;
    const rule = resolveQuickRule();
    const t: Task = {
      id: crypto.randomUUID(),
      title,
      dueISO: isoForWeekday(day),
      completed: false,
      recurrence: rule.type === "none" ? undefined : rule,
      column,
    };
    setTasks((prev) => [...prev, t]);
    setNewTitle("");
    setQuickRule("none");
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
      if (nextISO) {
        const clone: Task = {
          ...cur,
          id: crypto.randomUUID(),
          completed: false,
          completedAt: undefined,
          dueISO: nextISO,
        };
        return [...updated, clone];
      }
      return updated;
    });
  }

  function deleteTask(id: string) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    setUndoTask(t);
    setTasks((prev) => prev.filter((x) => x.id !== id));
    setTimeout(() => setUndoTask(null), 4000);
  }

  function undoDelete() {
    if (undoTask) {
      setTasks((prev) => [...prev, undoTask]);
      setUndoTask(null);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Add bar */}
        <div className="flex flex-wrap gap-2 mb-5">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New task…"
            className="flex-1 min-w-[200px] px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
          />
          <select
            value={activeDay}
            onChange={(e) => setActiveDay(Number(e.target.value) as Weekday)}
            className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
          >
            {WD_SHORT.map((d, i) => (
              <option key={i} value={i}>
                {d}
              </option>
            ))}
          </select>
          <select
            value={quickRule}
            onChange={(e) => setQuickRule(e.target.value as any)}
            className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
          >
            <option value="none">No recurrence</option>
            <option value="daily">Daily</option>
            <option value="weeklyMonFri">Mon–Fri</option>
            <option value="weeklyWeekends">Weekends</option>
            <option value="every2d">Every 2 days</option>
          </select>
          <button
            onClick={() => addTask(activeDay)}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
          >
            Add
          </button>
          <button
            onClick={() => addTask(0, "bounties")}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500"
          >
            Add to Bounties
          </button>
        </div>

        {/* Board */}
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
          {([0, 1, 2, 3, 4, 5, 6] as Weekday[]).map((day) => (
            <Column
              key={day}
              day={day}
              items={byDay.get(day) || []}
              onComplete={completeTask}
              onDelete={deleteTask}
            />
          ))}
          {/* Bounties Column */}
          <div className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-3 min-h-[18rem]">
            <div className="font-semibold mb-2">Bounties</div>
            <div className="space-y-2">
              {bounties.map((t) => (
                <Card
                  key={t.id}
                  task={t}
                  onComplete={() => completeTask(t.id)}
                  onDelete={() => deleteTask(t.id)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

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
    </div>
  );
}

/* ===== Components ===== */
function groupByDay(tasks: Task[]) {
  const m = new Map<Weekday, Task[]>();
  for (const t of tasks) {
    const wd = new Date(t.dueISO).getDay() as Weekday;
    if (!m.has(wd)) m.set(wd, []);
    m.get(wd)!.push(t);
  }
  for (const [k, arr] of m)
    m.set(
      k,
      arr.sort((a, b) => a.dueISO.localeCompare(b.dueISO))
    );
  return m;
}

function Column({
  day,
  items,
  onComplete,
  onDelete,
}: {
  day: Weekday;
  items: Task[];
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-3 min-h-[18rem]">
      <div className="font-semibold mb-2">{WD_SHORT[day]}</div>
      <div className="space-y-2">
        {items.map((t) => (
          <Card
            key={t.id}
            task={t}
            onComplete={() => onComplete(t.id)}
            onDelete={() => onDelete(t.id)}
          />
        ))}
      </div>
    </div>
  );
}

function Card({
  task,
  onComplete,
  onDelete,
}: {
  task: Task;
  onComplete: () => void;
  onDelete: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Drag to reorder (within column) not yet implemented
  function onDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
  }

  // Swipe gestures
  useEffect(() => {
    const THRESH = 180;
    const el = cardRef.current!;
    let startX = 0,
      dx = 0;
    const onTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      dx = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      dx = e.touches[0].clientX - startX;
      el.style.transform = `translateX(${dx}px)`;
      el.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 320));
    };
    const onTouchEnd = () => {
      if (dx > THRESH) onComplete();
      else if (dx < -THRESH) onDelete();
      el.style.transform = "";
      el.style.opacity = "";
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [onComplete, onDelete]);

  return (
    <div
      ref={cardRef}
      className="group relative p-3 rounded-xl bg-neutral-800 border border-neutral-700 select-none"
      draggable
      onDragStart={onDragStart}
    >
      <div className="flex items-center gap-3">
        {/* Circle button */}
        <button
          onClick={onComplete}
          className="flex items-center justify-center w-8 h-8 rounded-full border border-neutral-600 text-neutral-300 hover:text-emerald-500 hover:border-emerald-500 transition"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            className="pointer-events-none"
          >
            <circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
        </button>
        <div className="flex-1">
          <div className="text-sm font-medium">{task.title}</div>
          {!!task.note && (
            <div className="text-xs text-neutral-400">{task.note}</div>
          )}
        </div>
        <button
          onClick={onDelete}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-rose-600/70 hover:bg-rose-600 transition text-white"
        >
          🗑
        </button>
      </div>
    </div>
  );
}