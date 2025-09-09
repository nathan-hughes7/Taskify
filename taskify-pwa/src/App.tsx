/* eslint-disable no-empty, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions, react-refresh/only-export-components */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { finalizeEvent, getPublicKey, generateSecretKey, type EventTemplate, nip19 } from "nostr-tools";

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
  createdBy?: string;             // nostr pubkey of task creator
  title: string;
  note?: string;
  images?: string[];              // base64 data URLs for pasted images
  dueISO: string;                 // for week board day grouping
  completed?: boolean;
  completedAt?: string;
  recurrence?: Recurrence;
  // Week board columns:
  column?: "day" | "bounties";
  // Custom boards (multi-list):
  columnId?: string;
  hiddenUntilISO?: string;        // controls visibility (appear at/after this date)
  bounty?: {
    id: string;                   // bounty id (uuid)
    token: string;                // cashu token string (locked or unlocked)
    amount?: number;              // optional, sats
    mint?: string;                // optional hint
    lock?: "p2pk" | "htlc" | "none" | "unknown";
    owner?: string;               // hex pubkey of task creator (who can unlock)
    sender?: string;              // hex pubkey of funder (who can revoke)
    state: "locked" | "unlocked" | "revoked" | "claimed";
    updatedAt: string;            // iso
    enc?: {                       // optional encrypted form (hidden until funder reveals)
      alg: "aes-gcm-256";
      iv: string;                // base64
      ct: string;                // base64
    };
  };
};

type ListColumn = { id: string; name: string };

type BoardBase = {
  id: string;
  name: string;
  // Optional Nostr sharing metadata
  nostr?: { boardId: string; relays: string[] };
};

type Board =
  | (BoardBase & { kind: "week" }) // fixed Sun–Sat + Bounties
  | (BoardBase & { kind: "lists"; columns: ListColumn[] }); // multiple customizable columns

type Settings = {
  weekStart: Weekday; // 0=Sun, 1=Mon, 6=Sat
};

const R_NONE: Recurrence = { type: "none" };
const LS_TASKS = "taskify_tasks_v4";
const LS_SETTINGS = "taskify_settings_v2";
const LS_BOARDS = "taskify_boards_v2";
const LS_NOSTR_RELAYS = "taskify_nostr_relays_v1";
const LS_NOSTR_SK = "taskify_nostr_sk_v1";

/* ================= Nostr minimal client ================= */
type NostrEvent = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

type NostrUnsignedEvent = Omit<NostrEvent, "id" | "sig" | "pubkey"> & {
  pubkey?: string;
};

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (e: NostrUnsignedEvent) => Promise<NostrEvent>;
    };
  }
}

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
];

function loadDefaultRelays(): string[] {
  try {
    const raw = localStorage.getItem(LS_NOSTR_RELAYS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr;
    }
  } catch {}
  return DEFAULT_RELAYS;
}

function saveDefaultRelays(relays: string[]) {
  localStorage.setItem(LS_NOSTR_RELAYS, JSON.stringify(relays));
}

type NostrPool = {
  ensureRelay: (url: string) => void;
  setRelays: (urls: string[]) => void;
  subscribe: (
    relays: string[],
    filters: any[],
    onEvent: (ev: NostrEvent, from: string) => void,
    onEose?: (from: string) => void
  ) => () => void;
  publish: (relays: string[], event: NostrUnsignedEvent) => Promise<void>;
  publishEvent: (relays: string[], event: NostrEvent) => void;
};

function createNostrPool(): NostrPool {
  type Relay = {
    url: string;
    ws: WebSocket | null;
    status: "idle" | "opening" | "open" | "closed";
    queue: any[]; // messages to send when open
  };

  const relays = new Map<string, Relay>();
  const subs = new Map<
    string,
    {
      onEvent: (ev: NostrEvent, from: string) => void;
      onEose?: (from: string) => void;
    }
  >();

  function getOrCreate(url: string): Relay {
    let r = relays.get(url);
    if (!r) {
      r = { url, ws: null, status: "idle", queue: [] };
      relays.set(url, r);
    }
    if (r.status === "idle" || r.status === "closed") {
      try {
        r.status = "opening";
        r.ws = new WebSocket(url);
        r.ws.onopen = () => {
          r!.status = "open";
          // flush queue
          const q = r!.queue.slice();
          r!.queue.length = 0;
          for (const msg of q) r!.ws?.send(JSON.stringify(msg));
        };
        r.ws.onclose = () => {
          r!.status = "closed";
          // try to reopen after a delay
          setTimeout(() => {
            if (relays.has(url)) getOrCreate(url);
          }, 2500);
        };
        r.ws.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (!Array.isArray(data)) return;
            const [type, ...rest] = data;
            if (type === "EVENT") {
              const [subId, ev] = rest as [string, NostrEvent];
              const s = subs.get(subId);
              if (s && ev && typeof ev.kind === "number") s.onEvent(ev, url);
            } else if (type === "EOSE") {
              const [subId] = rest as [string];
              const s = subs.get(subId);
              if (s?.onEose) s.onEose(url);
            }
          } catch {}
        };
      } catch {}
    }
    return r;
  }

  function send(url: string, msg: any) {
    const r = getOrCreate(url);
    const payload = JSON.stringify(msg);
    if (r.status === "open" && r.ws?.readyState === WebSocket.OPEN) {
      try { r.ws.send(payload); } catch { r.queue.push(msg); }
    } else {
      r.queue.push(msg);
    }
  }

  const api: NostrPool = {
    ensureRelay(url: string) { getOrCreate(url); },
    setRelays(urls: string[]) {
      // open new
      for (const u of urls) getOrCreate(u);
      // close removed
      for (const [u, r] of relays) {
        if (!urls.includes(u)) {
          try { r.ws?.close(); } catch {}
          relays.delete(u);
        }
      }
    },
    subscribe(relayUrls, filters, onEvent, onEose) {
      const subId = `taskify-${Math.random().toString(36).slice(2, 10)}`;
      subs.set(subId, { onEvent, onEose });
      for (const u of relayUrls) {
        send(u, ["REQ", subId, ...filters]);
      }
      return () => {
        for (const u of relayUrls) send(u, ["CLOSE", subId]);
        subs.delete(subId);
      };
    },
    async publish(relayUrls, unsigned) {
      // This method remains for backward compatibility if needed.
      const now = Math.floor(Date.now() / 1000);
      const toSend: any = { ...unsigned, created_at: unsigned.created_at || now };
      for (const u of relayUrls) send(u, ["EVENT", toSend]);
    },
    publishEvent(relayUrls, event) {
      for (const u of relayUrls) send(u, ["EVENT", event]);
    }
  };
  return api;
}

/* ================== Crypto helpers (AES-GCM via local Nostr key) ================== */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(h);
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function concatBytes(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveAesKeyFromLocalSk(): Promise<CryptoKey> {
  // Derive a stable AES key from local Nostr SK: AES-GCM 256 with SHA-256(sk || label)
  const skHex = localStorage.getItem(LS_NOSTR_SK) || "";
  if (!skHex || !/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  const label = new TextEncoder().encode("taskify-ecash-v1");
  const raw = concatBytes(hexToBytes(skHex), label);
  const digest = await sha256(raw);
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt","decrypt"]);
}
export async function encryptEcashTokenForFunder(plain: string): Promise<{alg:"aes-gcm-256";iv:string;ct:string}> {
  const key = await deriveAesKeyFromLocalSk();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return { alg: "aes-gcm-256", iv: b64encode(iv), ct: b64encode(ctBuf) };
}
export async function decryptEcashTokenForFunder(enc: {alg:"aes-gcm-256";iv:string;ct:string}): Promise<string> {
  if (enc.alg !== "aes-gcm-256") throw new Error("Unsupported cipher");
  const key = await deriveAesKeyFromLocalSk();
  const iv = b64decode(enc.iv);
  const ct = b64decode(enc.ct);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

async function fileToDataURL(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1024;
        let { width, height } = img;
        if (width > height) {
          if (width > max) {
            height = Math.round((height * max) / width);
            width = max;
          }
        } else {
          if (height > max) {
            width = Math.round((width * max) / height);
            height = max;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(fr.result as string);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => reject(new Error("Image load error"));
      img.src = fr.result as string;
    };
    fr.readAsDataURL(file);
  });
}

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
  useEffect(() => {
    try {
      localStorage.setItem(LS_TASKS, JSON.stringify(tasks));
    } catch (e) {
      console.error("Failed to save tasks", e);
    }
  }, [tasks]);
  return [tasks, setTasks] as const;
}

/* ================= App ================= */
export default function App() {
  const [boards, setBoards] = useBoards();
  const [currentBoardId, setCurrentBoardId] = useState(boards[0]?.id || "");
  const currentBoard = boards.find(b => b.id === currentBoardId);

  const [tasks, setTasks] = useTasks();
  const [settings, setSettings] = useSettings();
  const [defaultRelays, setDefaultRelays] = useState<string[]>(() => loadDefaultRelays());
  useEffect(() => { saveDefaultRelays(defaultRelays); }, [defaultRelays]);

  // Nostr pool + merge indexes
  const pool = useMemo(() => createNostrPool(), []);
  // In-app Nostr key (secp256k1/Schnorr) for signing
  function bytesToHex(b: Uint8Array): string {
    return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  const [nostrSK, setNostrSK] = useState<Uint8Array>(() => {
    try {
      const existing = localStorage.getItem(LS_NOSTR_SK);
      if (existing && /^[0-9a-fA-F]{64}$/.test(existing)) return hexToBytes(existing);
    } catch {}
    const sk = generateSecretKey();
    try { localStorage.setItem(LS_NOSTR_SK, bytesToHex(sk)); } catch {}
    return sk;
  });
  const [nostrPK, setNostrPK] = useState<string>(() => {
    try { return getPublicKey(nostrSK); } catch { return ""; }
  });
  useEffect(() => { (window as any).nostrPK = nostrPK; }, [nostrPK]);
  // allow manual key rotation later if needed
  const rotateNostrKey = () => {
    const sk = generateSecretKey();
    setNostrSK(sk);
    const pk = getPublicKey(sk);
    setNostrPK(pk);
    try { localStorage.setItem(LS_NOSTR_SK, bytesToHex(sk)); } catch {}
  };

  const setCustomNostrKey = (key: string) => {
    try {
      let hex = key.trim();
      if (hex.startsWith("nsec")) {
        const dec = nip19.decode(hex);
        if (typeof dec.data !== "string") throw new Error();
        hex = dec.data;
      }
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error();
      const sk = hexToBytes(hex);
      setNostrSK(sk);
      const pk = getPublicKey(sk);
      setNostrPK(pk);
      try { localStorage.setItem(LS_NOSTR_SK, hex); } catch {}
    } catch {
      alert("Invalid private key");
    }
  };

  async function nostrPublish(relays: string[], template: EventTemplate) {
    const ev = finalizeEvent(template, nostrSK);
    pool.publishEvent(relays, ev as unknown as NostrEvent);
  }
  type NostrIndex = {
    boardMeta: Map<string, number>; // nostrBoardId -> created_at
    taskClock: Map<string, Map<string, number>>; // nostrBoardId -> (taskId -> created_at)
  };
  const nostrIdxRef = useRef<NostrIndex>({ boardMeta: new Map(), taskClock: new Map() });
  const boardsRef = useRef<Board[]>(boards);
  useEffect(() => { boardsRef.current = boards; }, [boards]);

  // header view
  const [view, setView] = useState<"board" | "completed">("board");
  const [showSettings, setShowSettings] = useState(false);

  // add bar
  const [newTitle, setNewTitle] = useState("");
  const [newImages, setNewImages] = useState<string[]>([]);
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
    if (!currentBoard || currentBoard.kind !== "week") return new Map<Weekday, Task[]>();
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
    () => currentBoard?.kind === "week"
      ? tasksForBoard.filter(t => !t.completed && t.column === "bounties" && isVisibleNow(t))
      : [],
    [tasksForBoard, currentBoard.kind]
  );

  // Custom list boards
  const listColumns = (currentBoard?.kind === "lists") ? currentBoard.columns : [];
  const itemsByColumn = useMemo(() => {
    if (!currentBoard || currentBoard.kind !== "lists") return new Map<string, Task[]>();
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

  // --------- Nostr helpers
  function tagValue(ev: NostrEvent, name: string): string | undefined {
    const t = ev.tags.find((x) => x[0] === name);
    return t ? t[1] : undefined;
  }
  function isShared(board: Board) { return !!board.nostr?.boardId; }
  function getBoardRelays(board: Board): string[] {
    return (board.nostr?.relays?.length ? board.nostr!.relays : defaultRelays).filter(Boolean);
  }
  function publishBoardMetadata(board: Board) {
    if (!board.nostr?.boardId) return;
    const relays = getBoardRelays(board);
    const tags: string[][] = [["d", board.nostr.boardId],["b", board.nostr.boardId],["k", board.kind],["name", board.name]];
    const content = board.kind === "lists" ? JSON.stringify({ columns: board.columns }) : "";
    nostrPublish(relays, { kind: 30300, tags, content, created_at: Math.floor(Date.now()/1000) });
  }
  function publishTaskDeleted(t: Task) {
    const b = boards.find((x) => x.id === t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const colTag = (b.kind === "week") ? (t.column === "bounties" ? "bounties" : "day") : (t.columnId || "");
    const tags: string[][] = [["d", t.id],["b", boardId],["col", String(colTag)],["status","deleted"]];
    const content = JSON.stringify({ title: t.title, note: t.note || "", dueISO: t.dueISO, completedAt: t.completedAt, recurrence: t.recurrence, hiddenUntilISO: t.hiddenUntilISO });
    nostrPublish(relays, { kind: 30301, tags, content, created_at: Math.floor(Date.now()/1000) });
  }
  function maybePublishTask(t: Task) {
    const b = boards.find((x) => x.id === t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const status = t.completed ? "done" : "open";
    const colTag = (b.kind === "week") ? (t.column === "bounties" ? "bounties" : "day") : (t.columnId || "");
    const tags: string[][] = [["d", t.id],["b", boardId],["col", String(colTag)],["status", status]];
    const body: any = { title: t.title, note: t.note || "", dueISO: t.dueISO, completedAt: t.completedAt, recurrence: t.recurrence, hiddenUntilISO: t.hiddenUntilISO, createdBy: t.createdBy };
    // Include explicit null to signal bounty removal when undefined
    body.bounty = (typeof t.bounty === 'undefined') ? null : t.bounty;
    const content = JSON.stringify(body);
    nostrPublish(relays, { kind: 30301, tags, content, created_at: Math.floor(Date.now()/1000) });
  }
  function applyBoardEvent(ev: NostrEvent) {
    const d = tagValue(ev, "d");
    if (!d) return;
    const boardId = d;
    const last = nostrIdxRef.current.boardMeta.get(boardId) || 0;
    if (ev.created_at <= last) return;
    nostrIdxRef.current.boardMeta.set(boardId, ev.created_at);
    const kindTag = tagValue(ev, "k");
    const name = tagValue(ev, "name");
    let payload: any = {};
    try { payload = ev.content ? JSON.parse(ev.content) : {}; } catch {}
    setBoards(prev => prev.map(b => {
      if (b.nostr?.boardId !== boardId) return b;
      const nm = name || b.name;
      if (kindTag === "week") return { id: b.id, name: nm, nostr: b.nostr, kind: "week" } as Board;
      if (kindTag === "lists") {
        const cols: ListColumn[] = Array.isArray(payload.columns) ? payload.columns : (b.kind === "lists" ? b.columns : [{ id: crypto.randomUUID(), name: "Items" }]);
        return { id: b.id, name: nm, nostr: b.nostr, kind: "lists", columns: cols } as Board;
      }
      return b;
    }));
  }
  function applyTaskEvent(ev: NostrEvent) {
    const boardId = tagValue(ev, "b");
    const taskId = tagValue(ev, "d");
    if (!boardId || !taskId) return;
    if (!nostrIdxRef.current.taskClock.has(boardId)) nostrIdxRef.current.taskClock.set(boardId, new Map());
    const m = nostrIdxRef.current.taskClock.get(boardId)!;
    const last = m.get(taskId) || 0;
    if (ev.created_at <= last) return;
    m.set(taskId, ev.created_at);

    const lb = boardsRef.current.find((b) => b.nostr?.boardId === boardId);
    if (!lb) return;
    let payload: any = {};
    try { payload = ev.content ? JSON.parse(ev.content) : {}; } catch {}
    const status = tagValue(ev, "status");
    const col = tagValue(ev, "col");
    const base: Task = {
      id: taskId,
      boardId: lb.id,
      createdBy: payload.createdBy,
      title: payload.title || "Untitled",
      note: payload.note || "",
      dueISO: payload.dueISO || isoForWeekday(0),
      completed: status === "done",
      completedAt: payload.completedAt,
      recurrence: payload.recurrence,
      hiddenUntilISO: payload.hiddenUntilISO,
    };
    if (lb.kind === "week") base.column = col === "bounties" ? "bounties" : "day";
    else if (lb.kind === "lists") base.columnId = col || (lb.columns[0]?.id || "");
    setTasks(prev => {
      const idx = prev.findIndex(x => x.id === taskId && x.boardId === lb.id);
      if (status === "deleted") {
        return idx >= 0 ? prev.filter((_,i)=>i!==idx) : prev;
      }
      // Improved bounty merge with clocks and auth; incoming may be null (explicit removal)
      const mergeBounty = (oldB?: Task["bounty"], incoming?: Task["bounty"] | null) => {
        if (incoming === null) return undefined; // explicit removal
        if (!incoming) return oldB;
        if (!oldB) return incoming;
        // Prefer the bounty with the latest updatedAt; fallback to event created_at
        const oldT = Date.parse(oldB.updatedAt || '') || 0;
        const incT = Date.parse(incoming.updatedAt || '') || 0;
        const incNewer = incT > oldT || (incT === oldT && ev.created_at > (nostrIdxRef.current.taskClock.get(boardId)?.get(taskId) || 0));

        // Different ids: pick the newer one
        if (oldB.id !== incoming.id) return incNewer ? incoming : oldB;

        const next = { ...oldB };
        // accept token/content updates if incoming is newer
        if (incNewer) {
          if (typeof incoming.amount === 'number') next.amount = incoming.amount;
          next.mint = incoming.mint ?? next.mint;
          next.lock = incoming.lock ?? next.lock;
          // Only overwrite token if sender/owner published or token becomes visible
          if (incoming.token) next.token = incoming.token;
          next.enc = incoming.enc !== undefined ? incoming.enc : next.enc;
          next.updatedAt = incoming.updatedAt || next.updatedAt;
        }
        // Auth for state transitions (allow owner or sender to unlock; owner or sender to revoke; anyone to mark claimed)
        if (incoming.state && incoming.state !== oldB.state) {
          const isOwner = !!(oldB.owner && ev.pubkey === oldB.owner);
          const isSender = !!(oldB.sender && ev.pubkey === oldB.sender);
          if (incoming.state === 'unlocked' && (isOwner || isSender)) next.state = 'unlocked';
          if (incoming.state === 'revoked' && (isOwner || isSender)) next.state = 'revoked';
          if (incoming.state === 'claimed') next.state = 'claimed';
        }
        return next;
      };

      if (idx >= 0) {
        const copy = prev.slice();
        const current = prev[idx];
        // Determine incoming bounty raw (preserve explicit null removal)
        const incomingB: Task["bounty"] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'bounty') ? payload.bounty : undefined;
        copy[idx] = { ...current, ...base, bounty: mergeBounty(current.bounty, incomingB as any) };
        return copy;
      } else {
        const incomingB: Task["bounty"] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'bounty') ? payload.bounty : undefined;
        return [...prev, { ...base, bounty: incomingB === null ? undefined : incomingB }];
      }
    });
  }

  async function handleAddPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs = Array.from(items).filter(it => it.type.startsWith("image/"));
    if (imgs.length) {
      e.preventDefault();
      const datas: string[] = [];
      for (const it of imgs) {
        const file = it.getAsFile();
        if (file) datas.push(await fileToDataURL(file));
      }
      setNewImages(prev => [...prev, ...datas]);
    }
  }

  function addTask() {
    const title = newTitle.trim() || (newImages.length ? "Image" : "");
    if ((!title && !newImages.length) || !currentBoard) return;

    const candidate = resolveQuickRule();
    const recurrence = candidate.type === "none" ? undefined : candidate;

    const t: Task = {
      id: crypto.randomUUID(),
      boardId: currentBoard.id,
      createdBy: nostrPK || undefined,
      title,
      dueISO: isoForWeekday(0),
      completed: false,
      recurrence,
    };
    if (newImages.length) t.images = newImages;

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
    // Publish to Nostr if board is shared
    try { maybePublishTask(t); } catch {}
    setNewTitle("");
    setNewImages([]);
    setQuickRule("none");
    setAddCustomRule(R_NONE);
  }

  function completeTask(id: string) {
    setTasks(prev => {
      const cur = prev.find(t => t.id === id);
      if (!cur) return prev;
      const now = new Date().toISOString();
      const updated = prev.map(t => t.id===id ? ({...t, completed:true, completedAt:now}) : t);
      const doneOne = updated.find(x => x.id === id);
      if (doneOne) { try { maybePublishTask(doneOne); } catch {} }
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
        try { maybePublishTask(clone); } catch {}
        return [...updated, clone];
      }
      return updated;
    });
    burst();
  }

  function deleteTask(id: string) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    // Require confirmation if the task has a bounty that is not claimed yet
    if (t.bounty && t.bounty.state !== 'claimed') {
      const ok = confirm('This task has an ecash bounty that is not marked as claimed. Delete anyway?');
      if (!ok) return;
    }
    setUndoTask(t);
    setTasks(prev => prev.filter(x => x.id !== id));
    try { publishTaskDeleted(t); } catch {}
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
    try {
      for (const t of tasksForBoard) if (t.completed) maybePublishTask(t);
    } catch {}
    setTasks(prev => prev.filter(t => !t.completed));
  }

  function saveEdit(updated: Task) {
    setTasks(prev => prev.map(t => t.id===updated.id ? updated : t));
    try { maybePublishTask(updated); } catch {}
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

      const updated: Task = { ...task };
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
      try { maybePublishTask(updated); } catch {}
      return arr;
    });
  }

  // Subscribe to Nostr for all shared boards
  const nostrBoardsKey = useMemo(() => {
    const items = boards
      .filter(b => b.nostr?.boardId)
      .map(b => ({ id: b.nostr!.boardId, relays: getBoardRelays(b).join(",") }))
      .sort((a,b) => (a.id + a.relays).localeCompare(b.id + b.relays));
    return JSON.stringify(items);
  }, [boards, defaultRelays]);

  useEffect(() => {
    let parsed: Array<{id:string; relays:string}> = [];
    try { parsed = JSON.parse(nostrBoardsKey || "[]"); } catch {}
    const unsubs: Array<() => void> = [];
    for (const it of parsed) {
      const rls = it.relays.split(",").filter(Boolean);
      if (!rls.length) continue;
      pool.setRelays(rls);
      const filters = [
        { kinds: [30300, 30301], "#b": [it.id], limit: 500 },
        { kinds: [30300], "#d": [it.id], limit: 1 },
      ];
      const unsub = pool.subscribe(rls, filters, (ev) => {
        if (ev.kind === 30300) applyBoardEvent(ev);
        else if (ev.kind === 30301) applyTaskEvent(ev);
      });
      unsubs.push(unsub);
    }
    return () => { unsubs.forEach(u => u()); };
  }, [nostrBoardsKey, pool]);

  // reset dayChoice when board changes
  useEffect(() => {
    if (!currentBoard) return;
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
              {boards.length === 0 ? (
                <option value="">No boards</option>
              ) : (
                boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)
              )}
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
        {view === "board" && currentBoard && (
          <div className="flex flex-wrap gap-2 items-center mb-4">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onPaste={handleAddPaste}
              placeholder="New task…"
              className="flex-1 min-w-[220px] px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 outline-none"
            />
            {newImages.length > 0 && (
              <div className="w-full flex gap-2 mt-2">
                {newImages.map((img, i) => (
                  <img key={i} src={img} className="h-16 rounded-lg" />
                ))}
              </div>
            )}

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
          !currentBoard ? (
            <div className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-6 text-center text-sm text-neutral-400">No boards. Open Settings to create one.</div>
          ) : currentBoard.kind === "week" ? (
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
                          {currentBoard?.kind === "week"
                            ? `Due ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}`
                            : "Completed item"}
                          {t.completedAt ? ` • Completed ${new Date(t.completedAt).toLocaleString()}` : ""}
                        </div>
                        <TaskMedia task={t} />
                        {t.bounty && (
                          <div className="mt-2">
                            <span className={`text-[11px] px-2 py-0.5 rounded-full border ${t.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : t.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : t.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-neutral-700/30 border-neutral-600'}`}>
                              Bounty {typeof t.bounty.amount==='number' ? `• ${t.bounty.amount} sats` : ''} • {t.bounty.state}
                            </span>
                          </div>
                        )}
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
                        {currentBoard?.kind === "week"
                          ? `Due ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}`
                          : "Hidden item"}
                        {t.hiddenUntilISO ? ` • Reveals ${new Date(t.hiddenUntilISO).toLocaleDateString()}` : ""}
                      </div>
                      <TaskMedia task={t} />
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
          <button onClick={undoDelete} className="pressable px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500">Undo</button>
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
          defaultRelays={defaultRelays}
          setDefaultRelays={setDefaultRelays}
          pubkeyHex={nostrPK}
          onGenerateKey={rotateNostrKey}
          onSetKey={setCustomNostrKey}
          onShareBoard={(boardId, relayCsv) => {
            const r = (relayCsv || "").split(",").map(s=>s.trim()).filter(Boolean);
            const relays = r.length ? r : defaultRelays;
            setBoards(prev => prev.map(b => {
              if (b.id !== boardId) return b;
              const nostrId = b.nostr?.boardId || (/^[0-9a-f-]{8}-[0-9a-f-]{4}-[1-5][0-9a-f-]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.id) ? b.id : crypto.randomUUID());
              const nb: Board = b.kind === "week" ? { ...b, nostr: { boardId: nostrId, relays } } : { ...b, nostr: { boardId: nostrId, relays } };
              setTimeout(() => publishBoardMetadata(nb), 0);
              return nb;
            }));
          }}
          onJoinBoard={(nostrId, name, relayCsv) => {
            const relays = (relayCsv || "").split(",").map(s=>s.trim()).filter(Boolean);
            const id = nostrId.trim();
            if (!id) return;
            const defaultCols: ListColumn[] = [{ id: crypto.randomUUID(), name: "Items" }];
            const newBoard: Board = { id, name: name || "Shared Board", kind: "lists", columns: defaultCols, nostr: { boardId: id, relays: relays.length ? relays : defaultRelays } };
            setBoards(prev => [...prev, newBoard]);
            setCurrentBoardId(id);
          }}
          onBoardChanged={(boardId) => {
            const b = boards.find(x => x.id === boardId);
            if (b) publishBoardMetadata(b);
          }}
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

type PreviewData = { url: string; title: string; description?: string; image?: string };
const previewCache: Record<string, PreviewData | null> = {};

function UrlPreview({ text }: { text: string }) {
  const [data, setData] = useState<PreviewData | null>(null);
  useEffect(() => {
    const m = text.match(/https?:\/\/[^\s)]+/i);
    if (!m) return;
    const url = m[0];
    if (previewCache[url] !== undefined) {
      setData(previewCache[url]);
      return;
    }
    previewCache[url] = null;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("https://r.jina.ai/" + url);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const title =
          doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
          doc.title || url;
        const description =
          doc.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
          doc.querySelector('meta[name="description"]')?.getAttribute("content") ||
          undefined;
        const rawImg = doc
          .querySelector('meta[property="og:image"]')
          ?.getAttribute("content") || undefined;
        let image: string | undefined;
        if (rawImg) {
          try {
            image = new URL(rawImg, url).href;
          } catch {
            image = rawImg;
          }
        }
        const p: PreviewData = { url, title, description, image };
        previewCache[url] = p;
        if (!cancelled) setData(p);
      } catch {
        previewCache[url] = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (!data) return null;
  return (
    <a
      href={data.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block border border-neutral-700 rounded-lg overflow-hidden mt-2"
    >
      {data.image && <img src={data.image} className="w-full h-40 object-cover" />}
      <div className="p-2 text-xs">
        <div className="font-medium truncate">{data.title}</div>
        {data.description && (
          <div className="text-neutral-400 overflow-hidden text-ellipsis" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
            {data.description}
          </div>
        )}
      </div>
    </a>
  );
}

function TaskMedia({ task }: { task: Task }) {
  return (
    <>
      {!!task.note && (
        <div className="text-xs text-neutral-400 mt-1 break-words">{autolink(task.note)}</div>
      )}
      {task.images?.length ? (
        <div className="mt-2 space-y-2">
          {task.images.map((img, i) => (
            <img key={i} src={img} className="max-h-40 rounded-lg" />
          ))}
        </div>
      ) : null}
      <UrlPreview text={`${task.title} ${task.note || ""}`} />
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
          <TaskMedia task={task} />
          {/* Bounty badge */}
          {task.bounty && (
            <div className="mt-2">
              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${task.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : task.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : task.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-neutral-700/30 border-neutral-600'}`}>
                Bounty {typeof task.bounty.amount==='number' ? `• ${task.bounty.amount} sats` : ''} • {task.bounty.state}
              </span>
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
  const [images, setImages] = useState<string[]>(task.images || []);
  const [rule, setRule] = useState<Recurrence>(task.recurrence ?? R_NONE);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [bountyToken, setBountyToken] = useState(task.bounty?.token || "");
  const [bountyAmount, setBountyAmount] = useState<number | "">(task.bounty?.amount ?? "");
  const [bountyState, setBountyState] = useState<Task["bounty"]["state"]>(task.bounty?.state || "locked");
  const [encryptWhenAttach, setEncryptWhenAttach] = useState(true);
  const myPubkey = (window as any).nostrPK as string | undefined;
  const iAmFunder = !!(task.bounty?.sender && myPubkey && task.bounty.sender === myPubkey);

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs = Array.from(items).filter(it => it.type.startsWith("image/"));
    if (imgs.length) {
      e.preventDefault();
      const datas: string[] = [];
      for (const it of imgs) {
        const file = it.getAsFile();
        if (file) datas.push(await fileToDataURL(file));
      }
      setImages(prev => [...prev, ...datas]);
    }
  }

  return (
    <Modal onClose={onCancel} title="Edit task">
      <div className="space-y-4">
        <input value={title} onChange={e=>setTitle(e.target.value)}
               className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" placeholder="Title"/>
        <textarea value={note} onChange={e=>setNote(e.target.value)} onPaste={handlePaste}
                  className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" rows={3}
                  placeholder="Notes (optional)"/>
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative">
                <img src={img} className="max-h-40 rounded-lg" />
                <button type="button" className="absolute top-1 right-1 bg-black/70 rounded-full px-1 text-xs" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* Recurrence section */}
        <div className="rounded-xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">Recurrence</div>
            <div className="ml-auto text-xs text-neutral-400">{labelOf(rule)}</div>
          </div>
          <div className="mt-2 flex gap-2 flex-wrap">
            <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setRule(R_NONE)}>None</button>
            <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setRule({ type: "daily" })}>Daily</button>
            <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setRule({ type: "weekly", days: [1,2,3,4,5] })}>Mon–Fri</button>
            <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setRule({ type: "weekly", days: [0,6] })}>Weekends</button>
            <button className="pressable ml-auto px-3 py-2 rounded-xl bg-neutral-800" onClick={() => setShowAdvanced(true)} title="Advanced recurrence…">Advanced…</button>
          </div>
        </div>

        {/* Bounty (ecash) */}
        <div className="rounded-xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">Bounty (ecash)</div>
            {task.bounty && (
              <div className="ml-auto flex items-center gap-2 text-[11px]">
                <span className={`px-2 py-0.5 rounded-full border ${task.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : task.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : task.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-neutral-700/30 border-neutral-600'}`}>{task.bounty.state}</span>
                {task.createdBy && (window as any).nostrPK === task.createdBy && <span className="px-2 py-0.5 rounded-full bg-neutral-800 border border-neutral-700" title="You created the task">owner: you</span>}
                {task.bounty.sender && (window as any).nostrPK === task.bounty.sender && <span className="px-2 py-0.5 rounded-full bg-neutral-800 border border-neutral-700" title="You funded the bounty">funder: you</span>}
              </div>
            )}
          </div>
          {!task.bounty ? (
            <div className="mt-2 space-y-2">
              <textarea
                value={bountyToken}
                onChange={(e)=>setBountyToken(e.target.value)}
                placeholder="Paste Cashu token (can be locked to your pubkey)"
                rows={3}
                className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              />
              <label className="flex items-center gap-2 text-xs text-neutral-300">
                <input type="checkbox" checked={encryptWhenAttach} onChange={(e)=>setEncryptWhenAttach(e.target.checked)} />
                Hide/encrypt token until I reveal (uses your local key)
              </label>
              <div className="flex items-center gap-2">
                <input type="number" min={1} value={bountyAmount as number || ""}
                       onChange={(e)=>setBountyAmount(e.target.value ? parseInt(e.target.value,10) : "")}
                       placeholder="Amount (sats)"
                       className="w-40 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"/>
                <button className="pressable px-3 py-2 rounded-xl bg-neutral-800"
                        onClick={async () => {
                          const tok = bountyToken.trim();
                          if (!tok) return;
                          const b: Task["bounty"] = {
                            id: crypto.randomUUID(),
                            token: tok,
                            amount: typeof bountyAmount === 'number' ? bountyAmount : undefined,
                            state: "locked",
                            owner: task.createdBy || (window as any).nostrPK || "",
                            sender: (window as any).nostrPK || "",
                            updatedAt: new Date().toISOString(),
                            lock: tok.includes("pubkey") ? "p2pk" : tok.includes("hash") ? "htlc" : "unknown",
                          };
                          if (encryptWhenAttach) {
                            try {
                              const enc = await encryptEcashTokenForFunder(tok);
                              b.enc = enc;
                              b.token = "";
                            } catch (e) {
                              alert("Encryption failed: "+ (e as Error).message);
                              return;
                            }
                          }
                            onSave({ ...task, title, note: note || undefined, images: images.length ? images : undefined, recurrence: rule.type==="none"? undefined : rule, bounty: b });
                        }}
                >Attach</button>
              </div>
              <div className="text-xs text-neutral-400">Tip: Ask the funder to lock the token to your Nostr pubkey so only you can unlock it later.</div>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <div className="text-xs text-neutral-400">Amount</div>
              <input type="number" min={1} value={(bountyAmount as number) || task.bounty?.amount || ""}
                     onChange={(e)=>setBountyAmount(e.target.value ? parseInt(e.target.value,10) : "")}
                     className="w-40 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"/>
              <div className="text-xs text-neutral-400">Token</div>
              {task.bounty.enc && !task.bounty.token ? (
                <div className="rounded-lg border border-neutral-800 p-2 text-xs text-neutral-300 bg-neutral-900/60">
                  Hidden (encrypted by funder). Only the funder can reveal.
                </div>
              ) : (
                <textarea readOnly value={task.bounty.token || ""}
                          className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" rows={3}/>
              )}
              <div className="flex gap-2 flex-wrap">
                {task.bounty.token && (
                  <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={()=> navigator.clipboard?.writeText(task.bounty!.token!)}>
                    Copy token
                  </button>
                )}
                {task.bounty.enc && !task.bounty.token && (window as any).nostrPK && task.bounty.sender === (window as any).nostrPK && (
                  <button className="pressable px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
                          onClick={async () => {
                            try {
                                const pt = await decryptEcashTokenForFunder(task.bounty!.enc!);
                                onSave({ ...task, title, note: note || undefined, images: images.length ? images : undefined, recurrence: rule.type==="none"? undefined : rule, bounty: { ...task.bounty!, token: pt, enc: undefined, state: 'unlocked', updatedAt: new Date().toISOString() } });
                            } catch (e) { alert("Decrypt failed: " + (e as Error).message); }
                          }}>Reveal (decrypt)</button>
                )}
                <button
                  className={`px-3 py-2 rounded-xl ${task.bounty.token ? 'bg-neutral-800' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'}`}
                  disabled={!task.bounty.token}
                  onClick={() => {
                    if (!task.bounty.token) return;
                    setBountyState('claimed');
                      onSave({ ...task, title, note: note || undefined, images: images.length ? images : undefined, recurrence: rule.type==="none"? undefined : rule, bounty: { ...task.bounty!, state: 'claimed', updatedAt: new Date().toISOString() } });
                  }}
                >
                  Mark claimed
                </button>
                {task.bounty.state === 'locked' && (
                  <>
                    <button className="pressable px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
                            onClick={() => {
                              // Placeholder unlock: trust user has reissued unlocked token externally
                              const newTok = prompt('Paste unlocked token (after you reissued in your wallet):');
                              if (!newTok) return;
                                onSave({ ...task, title, note: note || undefined, images: images.length ? images : undefined, recurrence: rule.type==="none"? undefined : rule, bounty: { ...task.bounty!, token: newTok, state: 'unlocked', updatedAt: new Date().toISOString() } });
                            }}>Unlock…</button>
                    <button
                      className={`px-3 py-2 rounded-xl ${((window as any).nostrPK && (task.bounty!.sender === (window as any).nostrPK || task.createdBy === (window as any).nostrPK)) ? 'bg-rose-600/80 hover:bg-rose-600' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'}`}
                      disabled={!((window as any).nostrPK && (task.bounty!.sender === (window as any).nostrPK || task.createdBy === (window as any).nostrPK))}
                      onClick={() => {
                        if (!((window as any).nostrPK && (task.bounty!.sender === (window as any).nostrPK || task.createdBy === (window as any).nostrPK))) return;
                          onSave({ ...task, title, note: note || undefined, images: images.length ? images : undefined, recurrence: rule.type==="none"? undefined : rule, bounty: { ...task.bounty!, state: 'revoked', updatedAt: new Date().toISOString() } });
                      }}
                    >
                      Revoke
                    </button>
                  </>
                )}
                <button
                  className={`ml-auto px-3 py-2 rounded-xl ${task.bounty.state==='claimed' ? 'bg-neutral-800' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'}`}
                  disabled={task.bounty.state !== 'claimed'}
                  onClick={() => {
                    if (task.bounty.state !== 'claimed') return;
                      onSave({ ...task, title, note: note || undefined, images: images.length ? images : undefined, recurrence: rule.type==="none"? undefined : rule, bounty: undefined });
                  }}
                >
                  Remove bounty
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="pt-2 flex justify-between">
          <button className="pressable px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600" onClick={onDelete}>Delete</button>
          <div className="space-x-2">
            <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={onCancel}>Cancel</button>
              <button className="pressable px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
                      onClick={()=>onSave({...task, title, note: note || undefined, images: images.length ? images : undefined, recurrence: rule.type==="none"? undefined : rule})}>
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
        <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={onClose}>Cancel</button>
        <button className="pressable px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500" onClick={() => onApply(value)}>Apply</button>
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
          <button className="pressable ml-auto px-3 py-1 rounded bg-neutral-800" onClick={onClose}>Close</button>
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
          <button className="pressable ml-auto px-3 py-1 rounded bg-neutral-800" onClick={onClose}>Close</button>
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
  defaultRelays,
  setDefaultRelays,
  pubkeyHex,
  onGenerateKey,
  onSetKey,
  onShareBoard,
  onJoinBoard,
  onBoardChanged,
  onClose,
}: {
  settings: Settings;
  boards: Board[];
  currentBoardId: string;
  setSettings: (s: Settings) => void;
  setBoards: React.Dispatch<React.SetStateAction<Board[]>>;
  setCurrentBoardId: (id: string) => void;
  defaultRelays: string[];
  setDefaultRelays: (rls: string[]) => void;
  pubkeyHex: string;
  onGenerateKey: () => void;
  onSetKey: (hex: string) => void;
  onShareBoard: (boardId: string, relaysCsv?: string) => void;
  onJoinBoard: (nostrId: string, name?: string, relaysCsv?: string) => void;
  onBoardChanged: (boardId: string) => void;
  onClose: () => void;
}) {
  const [newBoardName, setNewBoardName] = useState("");
  const [selectedBoardId, setSelectedBoardId] = useState(currentBoardId);
  const selectedBoard = boards.find(b => b.id === selectedBoardId);
  const [relaysCsv, setRelaysCsv] = useState("");
  const [joinId, setJoinId] = useState("");
  const [joinRelays, setJoinRelays] = useState("");
  const [joinName, setJoinName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customSk, setCustomSk] = useState("");

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
    const sb = boards.find(x => x.id === id);
    if (sb?.nostr) onBoardChanged(id);
  }

  function deleteBoard(id: string) {
    const b = boards.find(x => x.id === id);
    if (!b) return;
    if (!confirm(`Delete board “${b.name}”? This will also remove its tasks.`)) return;
    setBoards(prev => {
      const next = prev.filter(x => x.id !== id);
      if (currentBoardId === id) {
        const newId = next[0]?.id || "";
        setCurrentBoardId(newId);
        setSelectedBoardId(newId);
      }
      return next;
    });
  }

  function addColumn(boardId: string) {
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const col: ListColumn = { id: crypto.randomUUID(), name: `List ${b.columns.length + 1}` };
      const nb = { ...b, columns: [...b.columns, col] } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId); }, 0);
      return nb;
    }));
  }

  function renameColumn(boardId: string, colId: string) {
    const name = prompt("Rename list");
    if (name == null) return;
    const nn = name.trim();
    if (!nn) return;
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const nb = { ...b, columns: b.columns.map(c => c.id === colId ? { ...c, name: nn } : c) } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId); }, 0);
      return nb;
    }));
  }

  function deleteColumn(boardId: string, colId: string) {
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const nb = { ...b, columns: b.columns.filter(c => c.id !== colId) } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId); }, 0);
      return nb;
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
            <button className="pressable px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500" onClick={addBoard}>Create</button>
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
            <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>renameBoard(selectedBoardId)}>Rename</button>
            <button className="pressable px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600" onClick={()=>selectedBoardId && deleteBoard(selectedBoardId)}>Delete</button>
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
                      <button className="pressable px-3 py-1 rounded-full bg-rose-600/80 hover:bg-rose-600" onClick={()=>deleteColumn(selectedBoard.id, col.id)}>Delete</button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-2">
                <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>addColumn(selectedBoard.id)}>Add list</button>
              </div>
              <div className="text-xs text-neutral-400 mt-2">Tasks can be dragged between lists directly on the board.</div>
            </div>
          ) : (
            <div className="text-xs text-neutral-400 mt-2">The Week board has fixed columns (Sun–Sat, Bounties).</div>
          )}
        </section>

        {showAdvanced ? (
        <section className="rounded-xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Nostr (Shared boards)</div>
            <div className="ml-auto" />
          </div>
          {/* Public key */}
          <div className="mb-3">
            <div className="text-xs text-neutral-400 mb-1">Your Nostr public key (hex)</div>
            <div className="flex gap-2 items-center">
              <input readOnly value={pubkeyHex || "(generating…)"}
                     className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"/>
              <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>{if(pubkeyHex) navigator.clipboard?.writeText(pubkeyHex);}}>Copy</button>
            </div>
          </div>

          {/* Private key options */}
          <div className="mb-3 space-y-2">
            <div className="text-xs text-neutral-400 mb-1">Custom Nostr private key (hex or nsec)</div>
            <div className="flex gap-2 items-center">
              <input value={customSk} onChange={e=>setCustomSk(e.target.value)}
                     className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" placeholder="nsec or hex"/>
              <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>{onSetKey(customSk); setCustomSk('');}}>Use</button>
            </div>
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={onGenerateKey}>Generate new key</button>
          </div>

          {/* Default relays */}
          <div className="mb-3">
            <div className="text-xs text-neutral-400 mb-1">Default relays (CSV)</div>
            <input
              value={defaultRelays.join(",")}
              onChange={(e)=>setDefaultRelays(e.target.value.split(",").map(s=>s.trim()).filter(Boolean))}
              className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              placeholder="wss://relay1, wss://relay2"
            />
          </div>

          {/* Share current board */}
          <div className="mb-3">
            <div className="text-sm font-medium">Share current board</div>
            {selectedBoard?.nostr ? (
              <div className="mt-2 space-y-2">
                <div className="text-xs text-neutral-400">Board ID</div>
                <div className="flex gap-2 items-center">
                  <input readOnly value={selectedBoard.nostr.boardId}
                         className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"/>
                  <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>{navigator.clipboard?.writeText(selectedBoard.nostr!.boardId);}}>Copy</button>
                </div>
                <div className="text-xs text-neutral-400">Relays (CSV)</div>
                <input value={(selectedBoard.nostr.relays || []).join(",")} onChange={(e)=>{
                  const relays = e.target.value.split(",").map(s=>s.trim()).filter(Boolean);
                  setBoards(prev => prev.map(b => b.id === selectedBoard.id ? ({...b, nostr: { boardId: selectedBoard.nostr!.boardId, relays } }) : b));
                }} className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"/>
                <div className="flex gap-2">
                  <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>onBoardChanged(selectedBoard.id)}>Republish metadata</button>
                  <button className="px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600" onClick={()=>{
                    setBoards(prev => prev.map(b => b.id === selectedBoard.id ? (b.kind === 'week' ? { id: b.id, name: b.name, kind: 'week' } as Board : { id: b.id, name: b.name, kind: 'lists', columns: b.columns } as Board) : b));
                  }}>Stop sharing</button>
                </div>
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                <div className="text-xs text-neutral-400">Relays override (optional, CSV)</div>
                <input value={relaysCsv} onChange={(e)=>setRelaysCsv(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" placeholder="wss://relay1, wss://relay2"/>
                <button className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500" onClick={()=>onShareBoard(selectedBoard.id, relaysCsv)}>Share this board</button>
              </div>
            )}
          </div>

          {/* Join a shared board */}
          <div>
            <div className="text-sm font-medium">Join a shared board</div>
            <div className="mt-2 space-y-2">
              <input value={joinId} onChange={e=>setJoinId(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" placeholder="Board ID (d tag)"/>
              <input value={joinName} onChange={e=>setJoinName(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" placeholder="Local name (optional)"/>
              <input value={joinRelays} onChange={e=>setJoinRelays(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" placeholder="Relays (optional CSV)"/>
              <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>onJoinBoard(joinId, joinName, joinRelays)}>Join</button>
            </div>
          </div>
          <div className="mt-3">
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>setShowAdvanced(false)}>Hide advanced</button>
          </div>
        </section>
        ) : (
          <div>
            <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>setShowAdvanced(true)}>Show advanced settings</button>
          </div>
        )}

        <div className="flex justify-end">
          <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
