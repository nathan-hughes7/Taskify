import React, { useEffect, useMemo, useRef, useState } from "react";

/* ===== Types ===== */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type ColumnKey = Weekday | "bounty";
const WD_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"] as const;
const COLUMN_LABEL: Record<ColumnKey,string> = {
  0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat","bounty":"Bounties"
};

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
  dueISO: string;              // used for day columns
  bucket?: "bounty";           // when present, lives in Bounties column
  completed?: boolean;
  completedAt?: string;
  recurrence?: Recurrence;
};

const R_NONE: Recurrence = { type: "none" };
const LS_KEY = "taskify_mvp_v1";

/* ===== Dates/recurrence helpers ===== */
function startOfDay(d: Date) { const nd = new Date(d); nd.setHours(0,0,0,0); return nd; }
function isoForWeekday(target: Weekday, base = new Date()): string {
  const today = startOfDay(base);
  const diff = target - (today.getDay() as Weekday);
  return new Date(today.getTime() + diff*86400000).toISOString();
}
function nextOccurrence(currentISO: string, rule: Recurrence): string | null {
  const cur = startOfDay(new Date(currentISO));
  const addDays = (d: number) => startOfDay(new Date(cur.getTime() + d*86400000)).toISOString();
  switch (rule.type) {
    case "none": return null;
    case "daily": return addDays(1);
    case "weekly": {
      if (!rule.days.length) return null;
      for (let i=1;i<=14;i++) {
        const cand = addDays(i);
        const wd = new Date(cand).getDay() as Weekday;
        if (rule.days.includes(wd)) return cand;
      }
      return null;
    }
    case "every": return addDays(rule.unit === "day" ? rule.n : rule.n*7);
    case "monthlyDay": {
      const y = cur.getFullYear(); const m = cur.getMonth();
      const next = new Date(y, m+1, Math.min(rule.day, 28));
      return startOfDay(next).toISOString();
    }
  }
}

/* ===== Local storage ===== */
function useLocalTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem(LS_KEY, JSON.stringify(tasks)); }, [tasks]);
  return [tasks, setTasks] as const;
}

/* ===== App ===== */
export default function App() {
  const [tasks, setTasks] = useLocalTasks();
  const [view, setView] = useState<"board"|"completed">("board");

  // Add form
  const [newTitle, setNewTitle] = useState("");
  const [quickRule, setQuickRule] = useState<"none"|"daily"|"weeklyMonFri"|"weeklyWeekends"|"every2d"|"custom">("none");
  const [activeColumn, setActiveColumn] = useState<ColumnKey>((new Date().getDay() as Weekday));

  // Advanced recurrence modal
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedRule, setAdvancedRule] = useState<Recurrence>(R_NONE);

  // Edit modal
  const [editing, setEditing] = useState<Task|null>(null);

  // Undo snackbar
  const [undoVisible, setUndoVisible] = useState(false);
  const undoTimer = useRef<number | null>(null);
  const lastSnapshot = useRef<Task[] | null>(null);
  const lastDeletedTitle = useRef<string>("");

  // Preserve array order (important for reordering)
  const columns = useMemo(() => groupByColumnPreserveOrder(tasks.filter(t => !t.completed)), [tasks]);
  const completed = useMemo(() => (
    tasks.filter(t => !!t.completed)
         .sort((a,b)=> (b.completedAt||"").localeCompare(a.completedAt||""))
  ), [tasks]);

  const confettiRef = useRef<HTMLDivElement>(null);
  function burst() {
    const el = confettiRef.current; if (!el) return;
    for (let i=0;i<18;i++) {
      const s = document.createElement("span");
      s.textContent = ["🎉","✨","🎊","💥"][i%4];
      s.style.position = "absolute"; s.style.left = Math.random()*100+"%"; s.style.top = "-10px";
      s.style.transition = "transform 1s ease, opacity 1.1s ease";
      el.appendChild(s);
      requestAnimationFrame(() => {
        s.style.transform = `translateY(${80+Math.random()*120}px) rotate(${(Math.random()*360)|0}deg)`;
        s.style.opacity = "0";
        setTimeout(()=> el.removeChild(s), 1200);
      });
    }
  }

  function resolveQuickRule(): Recurrence {
    switch (quickRule) {
      case "none": return R_NONE;
      case "daily": return { type: "daily" };
      case "weeklyMonFri": return { type: "weekly", days: [1,2,3,4,5] };
      case "weeklyWeekends": return { type: "weekly", days: [0,6] };
      case "every2d": return { type: "every", n: 2, unit: "day" };
      case "custom": return advancedRule;
    }
  }

  function addTask(col: ColumnKey) {
    const title = newTitle.trim(); if (!title) return;
    const rule = resolveQuickRule();
    const base: Task = {
      id: crypto.randomUUID(),
      title,
      dueISO: typeof col === "number" ? isoForWeekday(col) : startOfDay(new Date()).toISOString(),
      completed: false,
      recurrence: rule.type === "none" ? undefined : rule
    };
    const t = col === "bounty" ? { ...base, bucket: "bounty" as const } : base;
    setTasks(prev => [...prev, t]);
    setNewTitle(""); setQuickRule("none");
  }

  // Move/insert within a column (and handle moving across columns)
  function moveTaskToColumnIndex(id: string, column: ColumnKey, targetIndex: number) {
    setTasks(prev => {
      const idx = prev.findIndex(t => t.id === id);
      if (idx === -1) return prev;
      const moving = prev[idx];

      const next = prev.slice();
      next.splice(idx, 1);

      // Build list of indices for tasks in destination column after removal
      const destIdxs: number[] = [];
      for (let i = 0; i < next.length; i++) {
        const t = next[i];
        const key: ColumnKey = t.bucket === "bounty" ? "bounty" : (new Date(t.dueISO).getDay() as Weekday);
        if (!t.completed && key === column) destIdxs.push(i);
      }
      const clamped = Math.max(0, Math.min(destIdxs.length, targetIndex));

      // global insert position
      const insertAt = (clamped >= destIdxs.length)
        ? (destIdxs.length ? destIdxs[destIdxs.length - 1] + 1 : next.length)
        : destIdxs[clamped];

      const updated: Task = {
        ...moving,
        bucket: column === "bounty" ? "bounty" : undefined,
        dueISO: column === "bounty"
          ? moving.dueISO
          : isoForWeekday(column as Weekday)
      };
      next.splice(insertAt, 0, updated);
      return next;
    });
  }

  function rescheduleTaskToDay(id: string, day: Weekday) {
    setTasks(prev => prev.map(t => t.id===id ? ({ ...t, bucket: undefined, dueISO: isoForWeekday(day) }) : t));
  }

  // Complete → may spawn next instance
  function completeTask(id: string) {
    setTasks(prev => {
      const cur = prev.find(t => t.id === id);
      if (!cur) return prev;

      const now = new Date().toISOString();
      const updated = prev.map(t => t.id===id ? { ...t, completed: true, completedAt: now } : t);

      const baseISO = cur.bucket === "bounty" ? startOfDay(new Date()).toISOString() : cur.dueISO;
      const nextISO = cur.recurrence ? nextOccurrence(baseISO, cur.recurrence) : null;
      if (nextISO) {
        const clone: Task = {
          ...cur,
          id: crypto.randomUUID(),
          completed: false,
          completedAt: undefined,
          bucket: cur.bucket, // keep bounty status
          dueISO: nextISO
        };
        return [...updated, clone];
      }
      return updated;
    });
    burst();
  }

  function deleteTask(id: string) {
    // snapshot + snackbar
    lastSnapshot.current = tasks;
    const victim = tasks.find(t => t.id === id);
    lastDeletedTitle.current = victim?.title ?? "Task";
    setTasks(prev => prev.filter(t => t.id !== id));

    setUndoVisible(true);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoVisible(false), 4000);
  }

  function undoDelete() {
    if (lastSnapshot.current) setTasks(lastSnapshot.current);
    lastSnapshot.current = null;
    setUndoVisible(false);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = null;
  }

  function restoreTask(id: string) {
    setTasks(prev => prev.map(t => t.id===id ? { ...t, completed: false, completedAt: undefined } : t));
    setView("board");
  }

  function clearCompleted() {
    setTasks(prev => prev.filter(t => !t.completed));
  }

  function saveEdit(updated: Task) {
    setTasks(prev => prev.map(t => t.id===updated.id ? updated : t));
    setEditing(null);
  }

  // Column order: Sun..Sat, Bounties
  const COLUMN_ORDER: ColumnKey[] = [0,1,2,3,4,5,6,"bounty"];

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="flex items-center gap-3 mb-6">
          <h1 className="text-3xl font-semibold tracking-tight">Taskify</h1>
          <div ref={confettiRef} className="relative h-0 w-full" />
          <div className="ml-auto flex items-center gap-2">
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
              <button
                className={`px-3 py-2 ${view==="board" ? "bg-neutral-800" : ""}`}
                onClick={()=>setView("board")}
              >Board</button>
              <button
                className={`px-3 py-2 ${view==="completed" ? "bg-neutral-800" : ""}`}
                onClick={()=>setView("completed")}
              >Completed</button>
            </div>
          </div>
        </header>

        {view === "board" ? (
          <>
            {/* Add bar */}
            <div className="flex flex-wrap gap-2 items-center mb-5">
              <input
                value={newTitle}
                onChange={e=>setNewTitle(e.target.value)}
                placeholder="New task…"
                className="flex-1 min-w-[220px] px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 outline-none"
              />

              {/* Column selector (days + Bounties) */}
              <select
                value={String(activeColumn)}
                onChange={e=>{
                  const v = e.target.value;
                  setActiveColumn(v === "bounty" ? "bounty" : (Number(v) as Weekday));
                }}
                className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              >
                {([0,1,2,3,4,5,6] as Weekday[]).map(d => (
                  <option key={d} value={d}>{WD_SHORT[d]}</option>
                ))}
                <option value="bounty">Bounties</option>
              </select>

              {/* Quick recurrence */}
              <select
                value={quickRule}
                onChange={(e)=> {
                  const v = e.target.value as typeof quickRule;
                  setQuickRule(v);
                  if (v === "custom") setShowAdvanced(true);
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

              <button onClick={()=>addTask(activeColumn)}
                      className="px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-medium">
                Add
              </button>
            </div>

            {/* Board */}
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-8">
              {COLUMN_ORDER.map(colKey => (
                <Column
                  key={String(colKey)}
                  columnKey={colKey}
                  title={COLUMN_LABEL[colKey]}
                  items={columns.get(colKey) || []}
                  onDropToIndex={(id, idx)=> moveTaskToColumnIndex(id, colKey, idx)}
                  onComplete={completeTask}
                  onEdit={setEditing}
                  onDelete={deleteTask}
                />
              ))}
            </div>
          </>
        ) : (
          /* Completed view */
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
                {completed.map(t => (
                  <li key={t.id} className="p-3 rounded-xl bg-neutral-800 border border-neutral-700">
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                        <div className="text-sm font-medium">{t.title}</div>
                        <div className="text-xs text-neutral-400">
                          {t.bucket === "bounty"
                            ? "Bounty"
                            : `Due ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}`}
                          {t.completedAt ? ` • Completed ${new Date(t.completedAt).toLocaleString()}` : ""}
                        </div>
                        {!!t.note && <div className="text-xs text-neutral-400 mt-1">{t.note}</div>}
                      </div>
                      <div className="flex gap-1">
                        <IconButton label="Edit" onClick={()=>setEditing(t)}>✎</IconButton>
                        <IconButton label="Restore" onClick={()=>restoreTask(t.id)} intent="success">↩︎</IconButton>
                        <IconButton label="Delete" onClick={()=>deleteTask(t.id)} intent="danger">🗑</IconButton>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Undo snackbar */}
      {undoVisible && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-neutral-900 text-neutral-100 border border-neutral-700 rounded-full shadow px-4 py-2 flex items-center gap-3">
          <span>Deleted “{lastDeletedTitle.current}”</span>
          <button
            className="px-3 py-1 rounded-full bg-neutral-800 hover:bg-neutral-700"
            onClick={undoDelete}
          >
            Undo
          </button>
        </div>
      )}

      {/* Advanced recurrence modal */}
      {showAdvanced && (
        <Modal onClose={()=>setShowAdvanced(false)} title="Custom recurrence">
          <RecurrencePicker value={advancedRule} onChange={setAdvancedRule} />
          <div className="mt-4 text-sm text-neutral-400">Selected: {labelOf(advancedRule)}</div>
          <div className="mt-3 flex justify-end">
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>setShowAdvanced(false)}>Close</button>
          </div>
        </Modal>
      )}

      {/* Edit modal */}
      {editing && (
        <EditModal
          task={editing}
          onCancel={()=>setEditing(null)}
          onDelete={()=>{ deleteTask(editing.id); setEditing(null); }}
          onSave={saveEdit}
          onOpenAdvanced={()=>setShowAdvanced(true)}
        />
      )}
    </div>
  );
}

/* ===== Grouping (preserve order) ===== */
function groupByColumnPreserveOrder(tasks: Task[]) {
  const m = new Map<ColumnKey, Task[]>();
  for (const t of tasks) {
    const key: ColumnKey = t.bucket === "bounty" ? "bounty" : (new Date(t.dueISO).getDay() as Weekday);
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(t);
  }
  return m;
}

function labelOf(r: Recurrence): string {
  switch (r.type) {
    case "none": return "None";
    case "daily": return "Daily";
    case "weekly": return `Weekly on ${r.days.map(d=>WD_SHORT[d]).join(", ") || "(none)"}`;
    case "every": return `Every ${r.n} ${r.unit === "day" ? "day(s)" : "week(s)"}`;
    case "monthlyDay": return `Monthly on day ${r.day}`;
  }
}

function Column({
  columnKey, title, items, onDropToIndex, onComplete, onEdit, onDelete
}: {
  columnKey: ColumnKey;
  title: string;
  items: Task[];
  onDropToIndex: (id: string, targetIndex: number) => void;
  onComplete: (id: string)=>void;
  onEdit: (t: Task)=>void;
  onDelete: (id: string)=>void;
}) {
  const colRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  function computeIndex(clientY: number): number {
    const list = listRef.current;
    if (!list) return items.length;
    const children = Array.from(list.children) as HTMLElement[];
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (clientY < mid) return i;
    }
    return children.length;
  }

  return (
    <div
      ref={colRef}
      className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-3 min-h-[18rem]"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer?.getData("text/task-id");
        if (!id) return;
        const idx = computeIndex(e.clientY);
        onDropToIndex(id, idx);
      }}
    >
      <div className="font-semibold text-neutral-200 mb-2">{title}</div>
      <div ref={listRef} className="space-y-2">
        {items.map((t) => (
          <Card
            key={t.id}
            task={t}
            onComplete={()=>onComplete(t.id)}
            onEdit={()=>onEdit(t)}
            onDelete={()=>onDelete(t.id)}
          />
        ))}
      </div>
    </div>
  );
}

function Card({ task, onComplete, onEdit, onDelete }: {
  task: Task; onComplete: ()=>void; onEdit: ()=>void; onDelete: ()=>void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  function onDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
  }

  // Swipe: right => complete, left => delete (less sensitive: 180px)
  // Also prevent horizontal page/board pan with touch-action and left-edge guard.
  useEffect(()=>{
    const THRESH = 180;
    const EDGE_GUARD = 24; // ignore swipes starting within 24px of card's left edge
    const el = cardRef.current!;
    let startX = 0, dx = 0, enabled = true;

    const onTouchStart = (e: TouchEvent) => {
      const rect = el.getBoundingClientRect();
      startX = e.touches[0].clientX; dx = 0;
      enabled = (startX - rect.left) >= EDGE_GUARD; // avoid iOS back-swipe from screen edge
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!enabled) return;
      dx = e.touches[0].clientX - startX;
      el.style.transform = `translateX(${dx}px)`;
      el.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx)/320));
    };
    const onTouchEnd = () => {
      if (enabled) {
        if (dx > THRESH) onComplete();
        else if (dx < -THRESH) onDelete();
      }
      el.style.transform = ""; el.style.opacity = "";
    };
    el.addEventListener("touchstart", onTouchStart, {passive:true});
    el.addEventListener("touchmove", onTouchMove, {passive:true});
    el.addEventListener("touchend", onTouchEnd);
    return ()=>{
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [onComplete, onDelete]);

  return (
    <div
      ref={cardRef}
      className="group relative p-3