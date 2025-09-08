import React, { useEffect, useMemo, useRef, useState } from "react";

/* ===== Types ===== */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const WD_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"] as const;

type Recurrence =
  | { type: "none" }
  | { type: "daily" }
  | { type: "weekly"; days: Weekday[] }
  | { type: "every"; n: number; unit: "day" | "week" }
  | { type: "monthlyDay"; day: number };

type Bucket = "day" | "bounty";

type Task = {
  id: string;
  title: string;
  note?: string;
  dueISO: string;              // midnight ISO if bucket==="day"
  bucket?: Bucket;             // default "day"; "bounty" goes to the Bounties column
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
  const [target, setTarget] = useState<{kind: "day"; day: Weekday} | {kind: "bounty"}>({kind:"day", day: new Date().getDay() as Weekday});

  // Advanced recurrence modal
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedRule, setAdvancedRule] = useState<Recurrence>(R_NONE);

  // Edit modal
  const [editing, setEditing] = useState<Task|null>(null);

  // Preserve array order (no sorting) to support manual reordering
  const dayMap = useMemo(() => groupByDayPreserveOrder(tasks.filter(t => !t.completed && (t.bucket ?? "day") === "day")), [tasks]);
  const bounties = useMemo(() => tasks.filter(t => !t.completed && (t.bucket ?? "day") === "bounty"), [tasks]);
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

  function addTask() {
    const title = newTitle.trim(); if (!title) return;
    const rule = resolveQuickRule();
    const base: Task = {
      id: crypto.randomUUID(),
      title,
      dueISO: isoForWeekday((target.kind === "day" ? target.day : (new Date().getDay() as Weekday))), // placeholder for bounty
      bucket: target.kind === "bounty" ? "bounty" : "day",
      completed: false,
      recurrence: rule.type === "none" ? undefined : rule
    };
    setTasks(prev => [...prev, base]);
    setNewTitle(""); setQuickRule("none");
  }

  // Reorder/move between day and bounty
  type DropTarget =
    | { kind: "day"; day: Weekday; index: number }
    | { kind: "bounty"; index: number };

  function moveTaskTo(id: string, drop: DropTarget) {
    setTasks(prev => {
      const curIdx = prev.findIndex(t => t.id === id);
      if (curIdx === -1) return prev;
      const moving = prev[curIdx];

      const next = prev.slice();
      next.splice(curIdx, 1);

      const isBounty = drop.kind === "bounty";

      const insertAt = computeInsertIndex(next, drop);
      const updated: Task = {
        ...moving,
        bucket: isBounty ? "bounty" : "day",
        dueISO: isBounty
          ? moving.dueISO // keep whatever; bucket drives column
          : isoForWeekday(drop.day)
      };
      next.splice(insertAt, 0, updated);
      return next;
    });
  }

  function computeInsertIndex(arr: Task[], drop: DropTarget): number {
    let indices: number[] = [];
    if (drop.kind === "bounty") {
      for (let i=0;i<arr.length;i++) if ((arr[i].bucket ?? "day") === "bounty" && !arr[i].completed) indices.push(i);
    } else {
      for (let i=0;i<arr.length;i++) {
        const t = arr[i];
        if ((t.bucket ?? "day") === "day" && !t.completed && (new Date(t.dueISO).getDay() as Weekday) === drop.day) {
          indices.push(i);
        }
      }
    }
    const clamped = Math.max(0, Math.min(indices.length, drop.index));
    return (clamped >= indices.length) ? (indices.length ? indices[indices.length-1] + 1 : arr.length) : indices[clamped];
  }

  function completeTask(id: string) {
    setTasks(prev => {
      const cur = prev.find(t => t.id === id);
      if (!cur) return prev;

      const now = new Date().toISOString();
      const updated = prev.map(t => t.id===id ? { ...t, completed: true, completedAt: now } : t);

      const nextISO = (cur.bucket ?? "day") === "day" && cur.recurrence
        ? nextOccurrence(cur.dueISO, cur.recurrence)
        : null;

      if (nextISO) {
        const clone: Task = { ...cur, id: crypto.randomUUID(), completed: false, completedAt: undefined, dueISO: nextISO };
        return [...updated, clone];
      }
      return updated;
    });
    burst();
  }

  function restoreTask(id: string) {
    setTasks(prev => prev.map(t => t.id===id ? { ...t, completed: false, completedAt: undefined } : t));
    setView("board");
  }

  function deleteTask(id: string) {
    setTasks(prev => prev.filter(t => t.id !== id));
  }

  function clearCompleted() {
    setTasks(prev => prev.filter(t => !t.completed));
  }

  function saveEdit(updated: Task) {
    setTasks(prev => prev.map(t => t.id===updated.id ? updated : t));
    setEditing(null);
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4 overflow-x-hidden">
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

              {/* where to add: Day or Bounties */}
              <select
                value={target.kind === "day" ? `day:${target.day}` : "bounty"}
                onChange={(e)=>{
                  const v = e.target.value;
                  if (v === "bounty") setTarget({kind:"bounty"});
                  else setTarget({kind:"day", day: Number(v.split(":")[1]) as Weekday});
                }}
                className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              >
                {WD_SHORT.map((d,i)=>(<option key={i} value={`day:${i}`}>{d}</option>))}
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

              <button onClick={addTask}
                      className="px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-medium">
                Add
              </button>
            </div>

            {/* Board */}
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-8">
              {(Array.from({length:7}, (_,i)=>i as Weekday)).map(day => (
                <DayColumn
                  key={day}
                  day={day}
                  items={dayMap.get(day) || []}
                  onDropToIndex={(id, idx)=> moveTaskTo(id, {kind:"day", day, index: idx})}
                  onComplete={completeTask}
                  onEdit={setEditing}
                  onDelete={deleteTask}
                />
              ))}
              <GenericColumn
                label="Bounties"
                items={bounties}
                onDropToIndex={(id, idx)=> moveTaskTo(id, {kind:"bounty", index: idx})}
                onComplete={completeTask}
                onEdit={setEditing}
                onDelete={deleteTask}
              />
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
                          {(t.bucket ?? "day") === "day" ? `Due ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}` : "Bounty"}
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

/* ===== Subcomponents & utils ===== */

// PRESERVE original array order
function groupByDayPreserveOrder(tasks: Task[]) {
  const m = new Map<Weekday, Task[]>();
  for (const t of tasks) {
    const wd = new Date(t.dueISO).getDay() as Weekday;
    if (!m.has(wd)) m.set(wd, []);
    m.get(wd)!.push(t);
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

function DayColumn({
  day, items, onDropToIndex, onComplete, onEdit, onDelete
}: {
  day: Weekday;
  items: Task[];
  onDropToIndex: (id: string, targetIndex: number) => void;
  onComplete: (id: string)=>void;
  onEdit: (t: Task)=>void;
  onDelete: (id: string)=>void;
}) {
  return (
    <GenericColumn
      label={WD_SHORT[day]}
      items={items}
      onDropToIndex={onDropToIndex}
      onComplete={onComplete}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

function GenericColumn({
  label, items, onDropToIndex, onComplete, onEdit, onDelete
}: {
  label: string;
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
      <div className="font-semibold text-neutral-200 mb-2">{label}</div>
      <div ref={listRef} className="space-y-2">
        {items.map((t) => (
          <Card