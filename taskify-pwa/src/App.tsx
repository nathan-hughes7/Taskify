import React, { useEffect, useMemo, useRef, useState } from "react";

/* ================= Types ================= */
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
  dueISO: string;            // midnight ISO that places task in a weekday column
  completed?: boolean;
  completedAt?: string;
  recurrence?: Recurrence;
  column?: "day" | "bounties";
};

const R_NONE: Recurrence = { type: "none" };
const LS_KEY = "taskify_mvp_v1";

/* ================= Date helpers ================= */
function startOfDay(d: Date) { const nd = new Date(d); nd.setHours(0,0,0,0); return nd; }
function isoForWeekday(target: Weekday, base = new Date()): string {
  const today = startOfDay(base);
  const diff = target - (today.getDay() as Weekday);
  return new Date(today.getTime() + diff * 86400000).toISOString();
}
function nextOccurrence(currentISO: string, rule: Recurrence): string | null {
  const cur = startOfDay(new Date(currentISO));
  const addDays = (d: number) => startOfDay(new Date(cur.getTime() + d*86400000)).toISOString();
  switch (rule.type) {
    case "none": return null;
    case "daily": return addDays(1);
    case "weekly": {
      if (!rule.days.length) return null;
      for (let i=1; i<=14; i++) {
        const cand = addDays(i);
        const wd = new Date(cand).getDay() as Weekday;
        if (rule.days.includes(wd)) return cand;
      }
      return null;
    }
    case "every": return addDays(rule.unit === "day" ? rule.n : rule.n * 7);
    case "monthlyDay": {
      const y = cur.getFullYear(), m = cur.getMonth();
      const next = new Date(y, m + 1, Math.min(rule.day, 28));
      return startOfDay(next).toISOString();
    }
  }
}

/* ================= Local storage ================= */
function useLocalTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem(LS_KEY, JSON.stringify(tasks)); }, [tasks]);
  return [tasks, setTasks] as const;
}

/* ================= App ================= */
export default function App() {
  const [tasks, setTasks] = useLocalTasks();

  // header view
  const [view, setView] = useState<"board"|"completed">("board");

  // add bar
  const [newTitle, setNewTitle] = useState("");
  const [activeDay, setActiveDay] = useState<Weekday>(new Date().getDay() as Weekday);
  const [quickRule, setQuickRule] = useState<"none"|"daily"|"weeklyMonFri"|"weeklyWeekends"|"every2d">("none");

  // edit modal
  const [editing, setEditing] = useState<Task|null>(null);

  // undo snackbar
  const [undoTask, setUndoTask] = useState<Task|null>(null);

  // confetti (lightweight)
  const confettiRef = useRef<HTMLDivElement>(null);
  function burst() {
    const el = confettiRef.current; if (!el) return;
    for (let i=0;i<18;i++) {
      const s = document.createElement("span");
      s.textContent = ["🎉","✨","🎊","💥"][i%4];
      s.style.position="absolute"; s.style.left=Math.random()*100+"%"; s.style.top="-10px";
      s.style.transition="transform 1s ease, opacity 1.1s ease";
      el.appendChild(s);
      requestAnimationFrame(() => {
        s.style.transform=`translateY(${80+Math.random()*120}px) rotate(${(Math.random()*360)|0}deg)`;
        s.style.opacity="0";
        setTimeout(()=>el.removeChild(s), 1200);
      });
    }
  }

  // derived lists (preserve insertion order)
  const byDay = useMemo(() => groupByDayPreserveOrder(tasks.filter(t => !t.completed && t.column !== "bounties")), [tasks]);
  const bounties = useMemo(() => tasks.filter(t => !t.completed && t.column === "bounties"), [tasks]);
  const completed = useMemo(() =>
    tasks.filter(t => !!t.completed).sort((a,b)=> (b.completedAt||"").localeCompare(a.completedAt||""))
  , [tasks]);

  function resolveQuickRule(): Recurrence {
    switch (quickRule) {
      case "none": return R_NONE;
      case "daily": return { type: "daily" };
      case "weeklyMonFri": return { type: "weekly", days: [1,2,3,4,5] };
      case "weeklyWeekends": return { type: "weekly", days: [0,6] };
      case "every2d": return { type: "every", n: 2, unit: "day" };
    }
  }

  function addTask(day: Weekday, column: "day"|"bounties" = "day") {
    const title = newTitle.trim(); if (!title) return;
    const rule = resolveQuickRule();
    const t: Task = {
      id: crypto.randomUUID(),
      title,
      dueISO: isoForWeekday(day),
      completed: false,
      recurrence: rule.type === "none" ? undefined : rule,
      column
    };
    setTasks(prev => [...prev, t]);
    setNewTitle(""); setQuickRule("none");
  }

  function completeTask(id: string) {
    setTasks(prev => {
      const cur = prev.find(t => t.id === id); if (!cur) return prev;
      const now = new Date().toISOString();
      const updated = prev.map(t => t.id===id ? ({...t, completed:true, completedAt:now}) : t);
      const nextISO = cur.recurrence ? nextOccurrence(cur.dueISO, cur.recurrence) : null;
      if (nextISO) {
        const clone: Task = { ...cur, id: crypto.randomUUID(), completed:false, completedAt:undefined, dueISO: nextISO };
        return [...updated, clone];
      }
      return updated;
    });
    burst();
  }

  function deleteTask(id: string) {
    const t = tasks.find(x => x.id === id); if (!t) return;
    setUndoTask(t);
    setTasks(prev => prev.filter(x => x.id !== id));
    setTimeout(() => setUndoTask(null), 5000);
  }
  function undoDelete() { if (undoTask) { setTasks(prev => [...prev, undoTask]); setUndoTask(null); } }

  function restoreTask(id: string) {
    setTasks(prev => prev.map(t => t.id===id ? ({...t, completed:false, completedAt:undefined}) : t));
    setView("board");
  }
  function clearCompleted() { setTasks(prev => prev.filter(t => !t.completed)); }

  function saveEdit(updated: Task) {
    setTasks(prev => prev.map(t => t.id===updated.id ? updated : t));
    setEditing(null);
  }

  /* ---------- Drag & Drop: move or reorder ---------- */
  function moveTask(id: string, target: { type: "day", day: Weekday } | { type: "bounties" }, beforeId?: string) {
    setTasks(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(t => t.id === id);
      if (fromIdx < 0) return prev;
      const task = arr[fromIdx];
      const updated: Task = {
        ...task,
        column: target.type === "bounties" ? "bounties" : "day",
        dueISO: target.type === "bounties" ? isoForWeekday(0) : isoForWeekday(target.day)
      };
      // remove original
      arr.splice(fromIdx, 1);
      // figure insertion position (global array index) by locating beforeId
      let insertIdx = typeof beforeId === "string" ? arr.findIndex(t => t.id === beforeId) : -1;
      if (insertIdx < 0) insertIdx = arr.length;
      arr.splice(insertIdx, 0, updated);
      return arr;
    });
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="flex items-center gap-3 mb-6">
          <h1 className="text-3xl font-semibold tracking-tight">Taskify</h1>
          <div ref={confettiRef} className="relative h-0 w-full" />
          <div className="ml-auto">
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
              <button className={`px-3 py-2 ${view==="board" ? "bg-neutral-800":""}`} onClick={()=>setView("board")}>Board</button>
              <button className={`px-3 py-2 ${view==="completed" ? "bg-neutral-800":""}`} onClick={()=>setView("completed")}>Completed</button>
            </div>
          </div>
        </header>

        {view === "board" ? (
          <>
            {/* Add bar */}
            <div className="flex flex-wrap gap-2 items-center mb-5">
              <input value={newTitle} onChange={e=>setNewTitle(e.target.value)} placeholder="New task…"
                     className="flex-1 min-w-[220px] px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 outline-none" />
              <select value={activeDay} onChange={e=>setActiveDay(Number(e.target.value) as Weekday)}
                      className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800">
                {WD_SHORT.map((d,i)=>(<option key={i} value={i}>{d}</option>))}
              </select>
              <select value={quickRule} onChange={e=>setQuickRule(e.target.value as any)}
                      className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800">
                <option value="none">No recurrence</option>
                <option value="daily">Daily</option>
                <option value="weeklyMonFri">Mon–Fri</option>
                <option value="weeklyWeekends">Weekends</option>
                <option value="every2d">Every 2 days</option>
              </select>
              <button onClick={()=>addTask(activeDay)} className="px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-medium">Add</button>
              <button onClick={()=>addTask(0,"bounties")} className="px-4 py-2 rounded-2xl bg-blue-600 hover:bg-blue-500 font-medium">Add to Bounties</button>
            </div>

            {/* Board */}
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
              {(Array.from({length:7}, (_,i)=>i as Weekday)).map(day => (
                <DroppableColumn key={day}
                  title={WD_SHORT[day]}
                  onDropCard={(payload) => {
                    const { id } = payload;
                    moveTask(id, { type: "day", day });
                  }}>
                  {(byDay.get(day) || []).map((t, idx, arr) => (
                    <Card
                      key={t.id}
                      task={t}
                      onComplete={()=>completeTask(t.id)}
                      onEdit={()=>setEditing(t)}
                      onDelete={()=>deleteTask(t.id)}
                      onDragStart={(id)=>({ id, beforeId: undefined })}
                      onDropBefore={(dragId)=>moveTask(dragId, { type: "day", day }, t.id)}
                      isLast={idx === arr.length - 1}
                    />
                  ))}
                </DroppableColumn>
              ))}

              {/* Bounties column */}
              <DroppableColumn
                title="Bounties"
                onDropCard={(payload) => {
                  const { id } = payload;
                  moveTask(id, { type: "bounties" });
                }}
              >
                {bounties.map((t, idx, arr) => (
                  <Card
                    key={t.id}
                    task={t}
                    onComplete={()=>completeTask(t.id)}
                    onEdit={()=>setEditing(t)}
                    onDelete={()=>deleteTask(t.id)}
                    onDragStart={(id)=>({ id, beforeId: undefined })}
                    onDropBefore={(dragId)=>moveTask(dragId, { type: "bounties" }, t.id)}
                    isLast={idx === arr.length - 1}
                  />
                ))}
              </DroppableColumn>
            </div>
          </>
        ) : (
          // Completed view
          <div className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="text-lg font-semibold">Completed</div>
              <div className="ml-auto">
                <button className="px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600" onClick={clearCompleted}>Clear completed</button>
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

      {/* Undo Snackbar */}
      {undoTask && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-neutral-800 border border-neutral-700 text-sm px-4 py-2 rounded-xl shadow-lg flex items-center gap-3">
          Task deleted
          <button onClick={undoDelete} className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500">Undo</button>
        </div>
      )}

      {/* Edit Modal */}
      {editing && (
        <EditModal
          task={editing}
          onCancel={()=>setEditing(null)}
          onDelete={()=>{ deleteTask(editing.id); setEditing(null); }}
          onSave={saveEdit}
        />
      )}
    </div>
  );
}

/* ================= Subcomponents ================= */

// keep original array order (so user-defined ordering persists)
function groupByDayPreserveOrder(tasks: Task[]) {
  const m = new Map<Weekday, Task[]>();
  for (const t of tasks) {
    const wd = new Date(t.dueISO).getDay() as Weekday;
    if (!m.has(wd)) m.set(wd, []);
    m.get(wd)!.push(t);
  }
  return m;
}

/* A droppable column that accepts card drops anywhere in the column */
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
      className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-3 min-h-[18rem]"
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
  onDragStart,
  onDropBefore,
  isLast,
}: {
  task: Task;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDragStart: (id: string) => { id: string; beforeId?: string };
  onDropBefore: (dragId: string) => void;
  isLast: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [overBefore, setOverBefore] = useState(false);

  // HTML5 drag (desktop + iOS)
  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
  }
  function handleDragOver(e: React.DragEvent) {
    // Allow drop and show "insert before" indicator when hovering top half
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

  // swipe: right => complete, left => delete
  useEffect(()=>{
    const THRESH = 180;
    const el = cardRef.current!;
    let startX = 0, startY = 0, dx = 0, dy = 0, active = false;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY; dx = 0; dy = 0; active = true;
      el.style.willChange = "transform";
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!active) return;
      const t = e.touches[0];
      dx = t.clientX - startX;
      dy = t.clientY - startY;

      // If mostly horizontal drag, prevent page scroll/overscroll.
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) e.preventDefault();

      el.style.transform = `translateX(${dx}px)`;
      el.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx)/320));
    };
    const onTouchEnd = () => {
      if (!active) return;
      if (dx > THRESH) onComplete();
      else if (dx < -THRESH) onDelete();
      el.style.transform = ""; el.style.opacity = ""; el.style.willChange = "";
      active = false;
    };

    // IMPORTANT: non-passive to allow preventDefault
    el.addEventListener("touchstart", onTouchStart, {passive:false});
    el.addEventListener("touchmove", onTouchMove, {passive:false});
    el.addEventListener("touchend", onTouchEnd, {passive:false});
    return ()=>{
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [onComplete, onDelete]);

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
        {/* Unchecked circular "complete" button (fallback/desktop) */}
        <button
          onClick={onComplete}
          aria-label="Complete task"
          title="Mark complete"
          className="flex items-center justify-center w-8 h-8 rounded-full border border-neutral-600 text-neutral-300 hover:text-emerald-500 hover:border-emerald-500 transition"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" className="pointer-events-none">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2"/>
          </svg>
        </button>

        {/* Title/Note (tap to edit) */}
        <div className="flex-1 cursor-pointer" onClick={onEdit}>
          <div className="text-sm font-medium leading-5">{task.title}</div>
          {!!task.note && <div className="text-xs text-neutral-400">{task.note}</div>}
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

/* Edit modal (title + note only for now) */
function EditModal({ task, onCancel, onDelete, onSave }: {
  task: Task; onCancel: ()=>void; onDelete: ()=>void; onSave: (t: Task)=>void;
}) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note || "");
  return (
    <Modal onClose={onCancel} title="Edit task">
      <div className="space-y-3">
        <input value={title} onChange={e=>setTitle(e.target.value)}
               className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" placeholder="Title"/>
        <textarea value={note} onChange={e=>setNote(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" rows={3}
                  placeholder="Notes (optional)"/>
        <div className="pt-2 flex justify-between">
          <button className="px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600" onClick={onDelete}>Delete</button>
          <div className="space-x-2">
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={onCancel}>Cancel</button>
            <button className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
                    onClick={()=>onSave({...task, title, note: note || undefined})}>
              Save
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

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