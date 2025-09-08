import React, { useEffect, useMemo, useRef, useState } from "react";

/*
  Taskify PWA — single-file React MVP
  - Trello-style week board (Sun–Sat)
  - Add tasks per day
  - Drag card between days to reschedule (HTML5 drag/drop)
  - Swipe right to complete (touch) / click ✓
  - Confetti burst on complete
  - Recurrence rules: none, daily, weekly (multi-select), every N days/weeks, monthly day
  - Local persistence (localStorage)

  Notes:
  • This is a single-file MVP so it runs in the Canvas preview. In a real app, split into components.
  • For PWA, add manifest + service worker (instructions provided in chat).
*/

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun
const WD_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"] as const;

// Recurrence model
 type Recurrence =
  | { type: "none" }
  | { type: "daily" }
  | { type: "weekly"; days: Weekday[] }
  | { type: "every"; n: number; unit: "day" | "week" }
  | { type: "monthlyDay"; day: number };

const R_NONE: Recurrence = { type: "none" };

function nextOccurrence(currentISO: string, rule: Recurrence): string | null {
  const cur = startOfDay(new Date(currentISO));
  const addDays = (d: number) => startOfDay(new Date(cur.getTime() + d*86400000)).toISOString();
  switch (rule.type) {
    case "none": return null;
    case "daily": return addDays(1);
    case "weekly": {
      if (!rule.days.length) return null;
      const curWD = cur.getDay() as Weekday;
      for (let i=1;i<=14;i++) {
        const cand = addDays(i);
        const wd = new Date(cand).getDay() as Weekday;
        if (rule.days.includes(wd)) return cand;
      }
      return null;
    }
    case "every": {
      const step = rule.unit === "day" ? rule.n : rule.n*7;
      return addDays(step);
    }
    case "monthlyDay": {
      const y = cur.getFullYear();
      const m = cur.getMonth();
      const next = new Date(y, m+1, Math.min(rule.day, 28));
      return startOfDay(next).toISOString();
    }
  }
}

function startOfDay(d: Date) { const nd = new Date(d); nd.setHours(0,0,0,0); return nd; }
function isoForWeekday(target: Weekday, base=new Date()): string {
  const today = startOfDay(base);
  const diff = target - (today.getDay() as Weekday);
  const res = new Date(today.getTime() + diff*86400000);
  return res.toISOString();
}

// Types & storage
 type Task = {
  id: string;
  title: string;
  note?: string;
  dueISO: string;         // midnight ISO date
  completed?: boolean;
  recurrence?: Recurrence;// undefined treated as none
 };

const LS_KEY = "taskify_mvp_v1";

function useLocalTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem(LS_KEY, JSON.stringify(tasks)); }, [tasks]);
  return [tasks, setTasks] as const;
}

export default function App() {
  const [tasks, setTasks] = useLocalTasks();
  const [newTitle, setNewTitle] = useState<string>("");
  const [showRecurrence, setShowRecurrence] = useState<boolean>(false);
  const [recurrence, setRecurrence] = useState<Recurrence>(R_NONE);
  const [activeDay, setActiveDay] = useState<Weekday>(new Date().getDay() as Weekday);

  const byDay = useMemo(() => groupByDay(tasks), [tasks]);

  // Confetti
  const confettiRef = useRef<HTMLDivElement>(null);
  function burst() {
    const el = confettiRef.current;
    if (!el) return;
    // simple emoji burst fallback (no deps)
    for (let i=0;i<18;i++) {
      const s = document.createElement("span");
      s.textContent = ["🎉","✨","🎊","💥"][i%4];
      s.style.position = "absolute";
      s.style.left = Math.random()*100+"%";
      s.style.top = "-10px";
      s.style.transition = "transform 1s ease, opacity 1.1s ease";
      el.appendChild(s);
      requestAnimationFrame(() => {
        s.style.transform = `translateY(${80+Math.random()*120}px) rotate(${(Math.random()*360)|0}deg)`;
        s.style.opacity = "0";
        setTimeout(()=> el.removeChild(s), 1200);
      });
    }
  }

  function addTask(day: Weekday) {
    const title = newTitle.trim(); if (!title) return;
    const t: Task = {
      id: crypto.randomUUID(),
      title,
      dueISO: isoForWeekday(day),
      completed: false,
      recurrence: recurrence.type === "none" ? undefined : recurrence
    };
    setTasks(prev => [...prev, t]);
    setNewTitle("");
    setRecurrence(R_NONE);
  }

  function completeTask(id: string) {
    setTasks(prev => {
      const cur = prev.find(t => t.id === id)!;
      const nextISO = cur.recurrence ? nextOccurrence(cur.dueISO, cur.recurrence) : null;
      const updated = prev.map(t => t.id===id ? { ...t, completed: true } : t);
      // remove after short delay
      setTimeout(() => setTasks(p => p.filter(x => x.id !== id)), 500);
      // spawn next instance if recurring
      if (nextISO) {
        const clone: Task = { ...cur, id: crypto.randomUUID(), completed: false, dueISO: nextISO };
        setTimeout(() => setTasks(p => [...p, clone]), 520);
      }
      return updated;
    });
    burst();
  }

  function rescheduleTask(id: string, day: Weekday) {
    const newISO = isoForWeekday(day);
    setTasks(prev => prev.map(t => t.id===id ? { ...t, dueISO: newISO } : t));
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4">
      <div className="max-w-6xl mx-auto">
        <header className="flex items-center gap-3 mb-4">
          <h1 className="text-2xl font-semibold">Taskify (PWA)</h1>
          <div ref={confettiRef} className="relative h-0 w-full" />
          <div className="ml-auto flex gap-2">
            <button className="px-3 py-2 rounded bg-neutral-800" onClick={() => setShowRecurrence(true)}>Recurrence</button>
            <button className="px-3 py-2 rounded bg-neutral-800" onClick={() => {
              // install prompt (PWA) is browser-driven; show hint
              alert("To install: Share ▸ Add to Home Screen (iOS Safari), or install icon in Chrome");
            }}>Install</button>
          </div>
        </header>

        {/* Add task bar */}
        <div className="flex gap-2 mb-3">
          <input value={newTitle} onChange={e=>setNewTitle(e.target.value)} placeholder="New task…" className="flex-1 px-3 py-2 rounded bg-neutral-900 border border-neutral-800 outline-none" />
          <select value={activeDay} onChange={e=>setActiveDay(Number(e.target.value) as Weekday)} className="px-2 py-2 rounded bg-neutral-900 border border-neutral-800">
            {WD_SHORT.map((d,i)=>(<option key={i} value={i}>{d}</option>))}
          </select>
          <button onClick={()=>addTask(activeDay)} className="px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-500">Add</button>
        </div>

        {/* Board */}
        <div className="overflow-x-auto">
          <div className="grid grid-flow-col auto-cols-[minmax(16rem,18rem)] gap-3 pb-6">
            {([0,1,2,3,4,5,6] as Weekday[]).map(day => (
              <Column
                key={day}
                day={day}
                items={(byDay.get(day) || [])}
                onDrop={(id)=>rescheduleTask(id, day)}
                onComplete={completeTask}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Recurrence modal */}
      {showRecurrence && (
        <Modal onClose={()=>setShowRecurrence(false)} title="Recurrence">
          <RecurrencePicker value={recurrence} onChange={setRecurrence} />
          <div className="mt-4 text-sm text-neutral-400">Selected: {labelOf(recurrence)}</div>
        </Modal>
      )}
    </div>
  );
}

function groupByDay(tasks: Task[]) {
  const m = new Map<Weekday, Task[]>();
  for (const t of tasks) {
    const wd = new Date(t.dueISO).getDay() as Weekday;
    if (!m.has(wd)) m.set(wd, []);
    m.get(wd)!.push(t);
  }
  // sort stable by creation-ish (ISO)
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

// Column component with HTML5 drag/drop & swipe-to-complete
function Column({ day, items, onDrop, onComplete }: {
  day: Weekday;
  items: Task[];
  onDrop: (id: string)=>void;
  onComplete: (id: string)=>void;
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
    return ()=>{ el.removeEventListener("dragover", prevent); };
  }, [onDrop]);

  return (
    <div ref={ref} className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-3 min-h-[18rem]">
      <div className="font-medium mb-2">{WD_SHORT[day]}</div>
      <div className="space-y-2">
        {items.map(t => (
          <Card key={t.id} task={t} onComplete={()=>onComplete(t.id)} />
        ))}
      </div>
    </div>
  );
}

function Card({ task, onComplete }: { task: Task; onComplete: ()=>void }) {
  const cardRef = useRef<HTMLDivElement>(null);

  // drag
  function onDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
  }

  // simple swipe right detection (touch)
  useEffect(()=>{
    const el = cardRef.current!;
    let startX = 0, dx = 0;
    const onTouchStart = (e: TouchEvent) => { startX = e.touches[0].clientX; dx = 0; };
    const onTouchMove = (e: TouchEvent) => {
      dx = e.touches[0].clientX - startX;
      el.style.transform = `translateX(${Math.max(0, dx)}px)`;
      el.style.opacity = dx > 0 ? String(Math.max(0.4, 1 - dx/240)) : "1";
    };
    const onTouchEnd = () => {
      if (dx > 120) onComplete();
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
  }, [onComplete]);

  return (
    <div ref={cardRef}
         className="group relative p-3 rounded-xl bg-neutral-800 border border-neutral-700 select-none"
         draggable
         onDragStart={onDragStart}>
      <div className="flex items-center gap-2">
        <button onClick={onComplete} className="opacity-0 group-hover:opacity-100 transition px-2 py-1 rounded bg-emerald-600">✓</button>
        <div className="flex-1">
          <div className="text-sm font-medium">{task.title}</div>
          {!!task.note && <div className="text-xs text-neutral-400">{task.note}</div>}
        </div>
      </div>
    </div>
  );
}

// Simple modal
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

// Recurrence Picker (web)
function RecurrencePicker({ value, onChange }: { value: Recurrence; onChange: (r: Recurrence)=>void }) {
  const [weekly, setWeekly] = useState<Set<Weekday>>(new Set());
  const [everyN, setEveryN] = useState(2);
  const [unit, setUnit] = useState<"day"|"week">("day");
  const [monthDay, setMonthDay] = useState(15);

  useEffect(()=>{
    // seed UI from value
    switch (value.type) {
      case "weekly": setWeekly(new Set(value.days)); break;
      case "every": setEveryN(value.n); setUnit(value.unit); break;
      case "monthlyDay": setMonthDay(value.day); break;
      default: setWeekly(new Set());
    }
  }, []);

  function toggleDay(d: Weekday) {
    const next = new Set(weekly);
    if (next.has(d)) next.delete(d); else next.add(d);
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
                className={`px-2 py-2 rounded ${on?"bg-emerald-600":"bg-neutral-800"}`}>{WD_SHORT[d]}</button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="text-sm font-medium mb-2">Every N</div>
        <div className="flex items-center gap-2">
          <input type="number" min={2} max={30} value={everyN} onChange={e=>setEveryN(parseInt(e.target.value||"2",10))}
                 className="w-20 px-2 py-2 rounded bg-neutral-900 border border-neutral-800"/>
          <select value={unit} onChange={e=>setUnit(e.target.value as any)} className="px-2 py-2 rounded bg-neutral-900 border border-neutral-800">
            <option value="day">Days</option>
            <option value="week">Weeks</option>
          </select>
          <button className="ml-2 px-3 py-2 rounded bg-neutral-800" onClick={()=>onChange({ type:"every", n: everyN, unit })}>Apply</button>
        </div>
      </section>

      <section>
        <div className="text-sm font-medium mb-2">Monthly</div>
        <div className="flex items-center gap-2">
          <input type="range" min={1} max={28} value={monthDay} onChange={e=>setMonthDay(parseInt(e.target.value,10))} />
          <div>Day {monthDay}</div>
          <button className="ml-2 px-3 py-2 rounded bg-neutral-800" onClick={()=>onChange({ type:"monthlyDay", day: monthDay })}>Apply</button>
        </div>
      </section>
    </div>
  );
}
