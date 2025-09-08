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

type Task = {
  id: string;
  title: string;
  note?: string;
  dueISO: string;              // midnight ISO (which “day column” it’s on)
  completed?: boolean;
  completedAt?: string;        // ISO timestamp when completed
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
  const [activeDay, setActiveDay] = useState<Weekday>(new Date().getDay() as Weekday);

  // Advanced recurrence modal (still available via “Custom…” or Edit)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedRule, setAdvancedRule] = useState<Recurrence>(R_NONE);

  // Edit modal
  const [editing, setEditing] = useState<Task|null>(null);

  const byDay = useMemo(() => groupByDay(tasks.filter(t => !t.completed)), [tasks]);
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

  function addTask(day: Weekday) {
    const title = newTitle.trim(); if (!title) return;
    const rule = resolveQuickRule();
    const t: Task = {
      id: crypto.randomUUID(),
      title,
      dueISO: isoForWeekday(day),
      completed: false,
      recurrence: rule.type === "none" ? undefined : rule
    };
    setTasks(prev => [...prev, t]);
    setNewTitle(""); setQuickRule("none");
  }

  function rescheduleTask(id: string, day: Weekday) {
    const newISO = isoForWeekday(day);
    setTasks(prev => prev.map(t => t.id===id ? { ...t, dueISO: newISO } : t));
  }

  // Mark complete → keep original task (completed=true, completedAt=now) + spawn next if recurring
  function completeTask(id: string) {
    setTasks(prev => {
      const cur = prev.find(t => t.id === id);
      if (!cur) return prev;

      const now = new Date().toISOString();
      const updated = prev.map(t => t.id===id ? { ...t, completed: true, completedAt: now } : t);

      const nextISO = cur.recurrence ? nextOccurrence(cur.dueISO, cur.recurrence) : null;
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
              <select
                value={activeDay}
                onChange={e=>setActiveDay(Number(e.target.value) as Weekday)}
                className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              >
                {WD_SHORT.map((d,i)=>(<option key={i} value={i}>{d}</option>))}
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

              <button onClick={()=>addTask(activeDay)}
                      className="px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-medium">
                Add
              </button>
            </div>

            {/* Board */}
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
              {(Array.from({length:7}, (_,i)=>i as Weekday)).map(day => (
                <Column
                  key={day}
                  day={day}
                  items={byDay.get(day) || []}
                  onDrop={(id)=>rescheduleTask(id, day)}
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
                          Due {WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}
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

      {/* Advanced recurrence modal (opened via “Custom…” or inside Edit) */}
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

/* ===== Subcomponents ===== */
function groupByDay(tasks: Task[]) {
  const m = new Map<Weekday, Task[]>();
  for (const t of tasks) {
    const wd = new Date(t.dueISO).getDay() as Weekday;
    if (!m.has(wd)) m.set(wd, []);
    m.get(wd)!.push(t);
  }
  for (const [k, arr] of m) m.set(k, arr.sort((a,b)=>a.dueISO.localeCompare(b.dueISO)));
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
  day, items, onDrop, onComplete, onEdit, onDelete
}: {
  day: Weekday;
  items: Task[];
  onDrop: (id: string)=>void;
  onComplete: (id: string)=>void;
  onEdit: (t: Task)=>void;
  onDelete: (id: string)=>void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const el = ref.current!;
    const prevent = (e: DragEvent) => e.preventDefault();
    el.addEventListener("dragover", prevent);
    el.addEventListener("drop", (e)=>{
      e.preventDefault();
      const id = e.dataTransfer?.getData("text/task-id");
      if (id) onDrop(id);
    });
    return ()=> el.removeEventListener("dragover", prevent);
  }, [onDrop]);

  return (
    <div ref={ref} className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-3 min-h-[18rem]">
      <div className="font-semibold text-neutral-200 mb-2">{WD_SHORT[day]}</div>
      <div className="space-y-2">
        {items.map(t => (
          <Card key={t.id} task={t}
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

  // swipe right complete
  useEffect(()=>{
    const el = cardRef.current!;
    let startX = 0, dx = 0;
    const onTouchStart = (e: TouchEvent) => { startX = e.touches[0].clientX; dx = 0; };
    const onTouchMove = (e: TouchEvent) => {
      dx = e.touches[0].clientX - startX;
      el.style.transform = `translateX(${Math.max(0, dx)}px)`; el.style.opacity = dx > 0 ? String(Math.max(0.4, 1 - dx/240)) : "1";
    };
    const onTouchEnd = () => { if (dx > 120) onComplete(); el.style.transform = ""; el.style.opacity = ""; };
    el.addEventListener("touchstart", onTouchStart, {passive:true});
    el.addEventListener("touchmove", onTouchMove, {passive:true});
    el.addEventListener("touchend", onTouchEnd);
    return ()=>{ el.removeEventListener("touchstart", onTouchStart); el.removeEventListener("touchmove", onTouchMove); el.removeEventListener("touchend", onTouchEnd); };
  }, [onComplete]);

  return (
    <div
      ref={cardRef}
      className="group relative p-3 rounded-xl bg-neutral-800 border border-neutral-700 select-none"
      draggable
      onDragStart={onDragStart}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={onComplete}
          className="px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-600 text-sm"
          title="Complete"
        >
          ✓
        </button>
        <div className="flex-1 cursor-pointer" onClick={onEdit}>
          <div className="text-sm font-medium leading-5">{task.title}</div>
          {!!task.note && <div className="text-xs text-neutral-400">{task.note}</div>}
        </div>
        {/* Subtle icon actions: hidden until hover/focus */}
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <IconButton label="Edit" onClick={onEdit}>✎</IconButton>
          <IconButton label="Delete" onClick={onDelete} intent="danger">🗑</IconButton>
        </div>
      </div>
    </div>
  );
}

/* Small, low-emphasis icon button */
function IconButton({
  children, onClick, label, intent
}: React.PropsWithChildren<{ onClick: ()=>void; label: string; intent?: "danger"|"success" }>) {
  const base =
    "px-2 py-1 rounded text-xs border border-transparent bg-neutral-700/40 hover:bg-neutral-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500";
  const danger = " bg-rose-700/30 hover:bg-rose-700/50";
  const success = " bg-emerald-700/30 hover:bg-emerald-700/50";
  const cls = base + (intent==="danger" ? danger : intent==="success" ? success : "");
  return (
    <button aria-label={label} title={label} className={cls} onClick={onClick}>
      {children}
    </button>
  );
}

/* ===== Modals ===== */
function Modal({ children, onClose, title }: React.PropsWithChildren<{ onClose: ()=>void; title?: string }>) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[min(680px,92vw)] max-h-[80vh] overflow-auto bg-neutral-900 border border-neutral-700 rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-lg font-semibold">{title}</div>
          <button className="ml-auto px-3 py-1 rounded bg-neutral-800" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
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

  function toggleDay(d: Weekday) {
    const next = new Set(weekly);
    next.has(d) ? next.delete(d) : next.add(d);
    setWeekly(next);
    const sorted = Array.from(next).sort((a,b)=>a-b);
    onChange(sorted.length ? { type: "weekly", days: sorted } : R_NONE);
  }

  return (
    <div className="space-y-4">
      <section>
        <div className="text-sm font-medium mb-2">Preset</div>
        <div className="flex gap-2">
          <button className="px-3 py-2 rounded bg-neutral-800" onClick={()=>onChange(R_NONE)}>None</button>
          <button className="px-3 py-2 rounded bg-neutral-800" onClick={()=>onChange({type:"daily"})}>Daily</button>
        </div>
      </section>

      <section>
        <div className="text-sm font-medium mb-2">Weekly</div>
        <div className="grid grid-cols-3 gap-2">
          {(Array.from({length:7}, (_,i)=>i as Weekday)).map(d => {
            const on = weekly.has(d);
            return (
              <button key={d} onClick={()=>toggleDay(d)}
                      className={`px-2 py-2 rounded ${on? "bg-emerald-600":"bg-neutral-800"}`}>{WD_SHORT[d]}</button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="text-sm font-medium mb-2">Every N</div>
        <div className="flex items-center gap-2">
          <input type="number" min={2} max={30} value={everyN}
                 onChange={e=>setEveryN(parseInt(e.target.value||"2",10))}
                 className="w-20 px-2 py-2 rounded bg-neutral-900 border border-neutral-800"/>
          <select value={unit} onChange={e=>setUnit(e.target.value as "day"|"week")}
                  className="px-2 py-2 rounded bg-neutral-900 border border-neutral-800">
            <option value="day">Days</option><option value="week">Weeks</option>
          </select>
          <button className="ml-2 px-3 py-2 rounded bg-neutral-800"
                  onClick={()=>onChange({ type:"every", n: everyN, unit })}>Apply</button>
        </div>
      </section>

      <section>
        <div className="text-sm font-medium mb-2">Monthly</div>
        <div className="flex items-center gap-2">
          <input type="range" min={1} max={28} value={monthDay}
                 onChange={e=>setMonthDay(parseInt(e.target.value,10))}/>
          <div>Day {monthDay}</div>
          <button className="ml-2 px-3 py-2 rounded bg-neutral-800"
                  onClick={()=>onChange({ type:"monthlyDay", day: monthDay })}>Apply</button>
        </div>
      </section>
    </div>
  );
}

function EditModal({ task, onCancel, onDelete, onSave, onOpenAdvanced }: {
  task: Task; onCancel: ()=>void; onDelete: ()=>void; onSave: (t: Task)=>void; onOpenAdvanced: ()=>void;
}) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note || "");
  const [rule, setRule] = useState<Recurrence>(task.recurrence ?? R_NONE);

  return (
    <Modal onClose={onCancel} title="Edit task">
      <div className="space-y-3">
        <input value={title} onChange={e=>setTitle(e.target.value)}
               className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
               placeholder="Title"/>
        <textarea value={note} onChange={e=>setNote(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
                  rows={3} placeholder="Notes (optional)"/>
        <div>
          <div className="text-sm mb-2 flex items-center gap-2">
            <span>Recurrence</span>
            <button className="px-2 py-1 text-xs rounded bg-neutral-800" onClick={onOpenAdvanced}>Open advanced…</button>
          </div>
          <RecurrencePicker value={rule} onChange={setRule}/>
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
    </Modal>
  );
}