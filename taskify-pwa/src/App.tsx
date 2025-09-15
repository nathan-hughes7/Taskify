import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { finalizeEvent, getPublicKey, generateSecretKey, type EventTemplate, nip19, nip04 } from "nostr-tools";
import { CashuWalletModal } from "./components/CashuWalletModal";
import { useCashu } from "./context/CashuContext";
import { loadStore as loadProofStore, saveStore as saveProofStore, getActiveMint, setActiveMint } from "./wallet/storage";
import { encryptToBoard, decryptFromBoard, boardTag } from "./boardCrypto";
import { useToast } from "./context/ToastContext";

/* ================= Types ================= */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun
type DayChoice = Weekday | "bounties" | string; // string = custom list columnId
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type Recurrence =
  | { type: "none"; untilISO?: string }
  | { type: "daily"; untilISO?: string }
  | { type: "weekly"; days: Weekday[]; untilISO?: string }
  | { type: "every"; n: number; unit: "day" | "week"; untilISO?: string }
  | { type: "monthlyDay"; day: number; untilISO?: string };

type Subtask = {
  id: string;
  title: string;
  completed?: boolean;
};

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
  completedBy?: string;           // nostr pubkey of user who marked complete
  recurrence?: Recurrence;
  // Week board columns:
  column?: "day" | "bounties";
  // Custom boards (multi-list):
  columnId?: string;
  hiddenUntilISO?: string;        // controls visibility (appear at/after this date)
  order?: number;                 // order within the board for manual reordering
  streak?: number;                // consecutive completion count
  seriesId?: string;              // identifier for a recurring series
  subtasks?: Subtask[];           // optional list of subtasks
  bounty?: {
    id: string;                   // bounty id (uuid)
    token: string;                // cashu token string (locked or unlocked)
    amount?: number;              // optional, sats
    mint?: string;                // optional hint
    lock?: "p2pk" | "htlc" | "none" | "unknown";
    owner?: string;               // hex pubkey of task creator (who can unlock)
    sender?: string;              // hex pubkey of funder (who can revoke)
    receiver?: string;            // hex pubkey of intended recipient (who can decrypt nip04)
    state: "locked" | "unlocked" | "revoked" | "claimed";
    updatedAt: string;            // iso
    enc?:
      | {                         // optional encrypted form (hidden until funder reveals)
          alg: "aes-gcm-256";
          iv: string;            // base64
          ct: string;            // base64
        }
      | {
          alg: "nip04";         // encrypted to receiver's nostr pubkey (nip04 format)
          data: string;          // ciphertext returned by nip04.encrypt
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
  newTaskPosition: "top" | "bottom";
  streaksEnabled: boolean;
  completedTab: boolean;
  showFullWeekRecurring: boolean;
  // Add tasks via per-column boxes instead of global add bar
  inlineAdd: boolean;
  // Base UI font size in pixels; null uses the OS preferred size
  baseFontSize: number | null;
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
  "wss://solife.me/nostrrelay/1",
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
      relays: string[];
      filters: any[];
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
          // re-subscribe existing subscriptions on reconnect
          for (const [subId, sub] of subs) {
            if (sub.relays.includes(url)) {
              try { r!.ws?.send(JSON.stringify(["REQ", subId, ...sub.filters])); }
              catch { r!.queue.push(["REQ", subId, ...sub.filters]); }
            }
          }
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
      subs.set(subId, { relays: relayUrls.slice(), filters, onEvent, onEose });
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

// NIP-04 encryption for recipient
async function encryptEcashTokenForRecipient(recipientHex: string, plain: string): Promise<{ alg: "nip04"; data: string }> {
  const skHex = localStorage.getItem(LS_NOSTR_SK) || "";
  if (!/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  if (!/^[0-9a-fA-F]{64}$/.test(recipientHex)) throw new Error("Invalid recipient pubkey");
  const data = await nip04.encrypt(skHex, recipientHex, plain);
  return { alg: "nip04", data };
}

async function decryptEcashTokenForRecipient(senderHex: string, enc: { alg: "nip04"; data: string }): Promise<string> {
  const skHex = localStorage.getItem(LS_NOSTR_SK) || "";
  if (!/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  if (!/^[0-9a-fA-F]{64}$/.test(senderHex)) throw new Error("Invalid sender pubkey");
  return await nip04.decrypt(skHex, senderHex, enc.data);
}

async function fileToDataURL(file: File): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(fr.result as string);
    fr.readAsDataURL(file);
  });

  return await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1280;
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
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
  let next: string | null = null;
  switch (rule.type) {
    case "none":
      next = null; break;
    case "daily":
      next = addDays(1); break;
    case "weekly": {
      if (!rule.days.length) return null;
      for (let i = 1; i <= 28; i++) {
        const cand = addDays(i);
        const wd = new Date(cand).getDay() as Weekday;
        if (rule.days.includes(wd)) { next = cand; break; }
      }
      break;
    }
    case "every":
      next = addDays(rule.unit === "day" ? rule.n : rule.n * 7); break;
    case "monthlyDay": {
      const y = cur.getFullYear(), m = cur.getMonth();
      const n = new Date(y, m + 1, Math.min(rule.day, 28));
      next = startOfDay(n).toISOString();
      break;
    }
  }
  if (next && rule.untilISO) {
    const limit = startOfDay(new Date(rule.untilISO)).getTime();
    const n = startOfDay(new Date(next)).getTime();
    if (n > limit) return null;
  }
  return next;
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
  const sow = startOfWeek(nextMidnight, weekStart);
  return sow.toISOString();
}

/* ================= Storage hooks ================= */
function useSettings() {
  const [settings, setSettingsRaw] = useState<Settings>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}");
      let baseFontSize =
        typeof parsed.baseFontSize === "number" ? parsed.baseFontSize : null;
      if (baseFontSize === 16) baseFontSize = null; // default to system size
      return {
        weekStart: 0,
        newTaskPosition: "bottom",
        streaksEnabled: true,
        completedTab: true,
        showFullWeekRecurring: false,
        inlineAdd: false,
        ...parsed,
        baseFontSize,
      };
    } catch {
      return {
        weekStart: 0,
        newTaskPosition: "bottom",
        streaksEnabled: true,
        completedTab: true,
        showFullWeekRecurring: false,
        inlineAdd: false,
        baseFontSize: null,
      };
    }
  });
  const setSettings = (s: Partial<Settings>) => {
    setSettingsRaw(prev => ({ ...prev, ...s }));
  };
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
    try {
      const raw = JSON.parse(localStorage.getItem(LS_TASKS) || "[]");
      if (Array.isArray(raw)) {
        const orderMap = new Map<string, number>();
        return raw.map((t: Task) => {
          const next = orderMap.get(t.boardId) ?? 0;
          const order = typeof t.order === 'number' ? t.order : next;
          orderMap.set(t.boardId, order + 1);
          return { ...t, order } as Task;
        });
      }
      return [];
    } catch { return []; }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_TASKS, JSON.stringify(tasks));
    } catch (err) {
      console.error('Failed to save tasks', err);
    }
  }, [tasks]);
  return [tasks, setTasks] as const;
}

/* ================= App ================= */
export default function App() {
  const { show: showToast } = useToast();
  // Show toast on any successful clipboard write across the app
  useEffect(() => {
    const clip: any = (navigator as any).clipboard;
    if (!clip || typeof clip.writeText !== 'function') return;
    const original = clip.writeText.bind(clip);
    const patched = (text: string) => {
      try {
        const p = original(text);
        if (p && typeof p.then === 'function') {
          p.then(() => showToast()).catch(() => {});
        } else {
          showToast();
        }
        return p;
      } catch {
        // swallow, behave like original
        try { return original(text); } catch {}
      }
    };
    try { clip.writeText = patched; } catch {}
    return () => { try { clip.writeText = original; } catch {} };
  }, [showToast]);
  const [boards, setBoards] = useBoards();
  const [currentBoardId, setCurrentBoardId] = useState(boards[0]?.id || "");
  const currentBoard = boards.find(b => b.id === currentBoardId);

  const [tasks, setTasks] = useTasks();
  const [settings, setSettings] = useSettings();
  const [defaultRelays, setDefaultRelays] = useState<string[]>(() => loadDefaultRelays());
  useEffect(() => { saveDefaultRelays(defaultRelays); }, [defaultRelays]);

  useEffect(() => {
    if (!settings.showFullWeekRecurring) return;
    setTasks(prev => ensureWeekRecurrences(prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.showFullWeekRecurring, settings.weekStart]);

  // Apply font size setting to root; fall back to OS preferred size
  useEffect(() => {
    try {
      const base = settings.baseFontSize;
      if (typeof base === "number" && base >= 12) {
        const px = Math.min(22, base);
        document.documentElement.style.fontSize = `${px}px`;
      } else {
        document.documentElement.style.fontSize = "";
      }
    } catch {}
  }, [settings.baseFontSize]);

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

  const lastNostrCreated = useRef(0);
  async function nostrPublish(relays: string[], template: EventTemplate) {
    const now = Math.floor(Date.now() / 1000);
    let createdAt = typeof template.created_at === "number" ? template.created_at : now;
    if (createdAt <= lastNostrCreated.current) {
      createdAt = lastNostrCreated.current + 1;
    }
    lastNostrCreated.current = createdAt;
    const ev = finalizeEvent({ ...template, created_at: createdAt }, nostrSK);
    pool.publishEvent(relays, ev as unknown as NostrEvent);
    return createdAt;
  }
  type NostrIndex = {
    boardMeta: Map<string, number>; // nostrBoardId -> created_at
    taskClock: Map<string, Map<string, number>>; // nostrBoardId -> (taskId -> created_at)
  };
  const nostrIdxRef = useRef<NostrIndex>({ boardMeta: new Map(), taskClock: new Map() });
  const boardsRef = useRef<Board[]>(boards);
  useEffect(() => { boardsRef.current = boards; }, [boards]);
  const [nostrRefresh, setNostrRefresh] = useState(0);

  // header view
  const [view, setView] = useState<"board" | "completed">("board");
  const [showSettings, setShowSettings] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const { receiveToken } = useCashu();

  useEffect(() => {
    if (!settings.completedTab) setView("board");
  }, [settings.completedTab]);

  // add bar
  const newTitleRef = useRef<HTMLInputElement>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newImages, setNewImages] = useState<string[]>([]);
  const [dayChoice, setDayChoice] = useState<DayChoice>(() => {
    return (boards[0].kind === "lists")
      ? (boards[0] as Extract<Board, {kind:"lists"}>).columns[0]?.id || "items"
      : (new Date().getDay() as Weekday);
  });
  const [scheduleDate, setScheduleDate] = useState<string>("");
  const [inlineTitles, setInlineTitles] = useState<Record<string, string>>({});

  function handleBoardSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    setCurrentBoardId(val);
  }

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

  // drag-to-delete
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [trashHover, setTrashHover] = useState(false);
  const [upcomingHover, setUpcomingHover] = useState(false);
  const [boardDropOpen, setBoardDropOpen] = useState(false);
  const [boardDropPos, setBoardDropPos] = useState<{ top: number; left: number } | null>(null);
  const boardDropTimer = useRef<number>();
  const boardDropCloseTimer = useRef<number>();

  function scheduleBoardDropClose() {
    if (boardDropCloseTimer.current) window.clearTimeout(boardDropCloseTimer.current);
    boardDropCloseTimer.current = window.setTimeout(() => {
      setBoardDropOpen(false);
      setBoardDropPos(null);
      boardDropCloseTimer.current = undefined;
    }, 100);
  }

  function cancelBoardDropClose() {
    if (boardDropCloseTimer.current) {
      window.clearTimeout(boardDropCloseTimer.current);
      boardDropCloseTimer.current = undefined;
    }
  }

  function handleDragEnd() {
    setDraggingTaskId(null);
    setTrashHover(false);
    setUpcomingHover(false);
    setBoardDropOpen(false);
    setBoardDropPos(null);
    if (boardDropTimer.current) window.clearTimeout(boardDropTimer.current);
    if (boardDropCloseTimer.current) window.clearTimeout(boardDropCloseTimer.current);
  }

  // upcoming drawer (out-of-the-way FAB)
  const [showUpcoming, setShowUpcoming] = useState(false);

  // confetti
  const confettiRef = useRef<HTMLDivElement>(null);
  // fly-to-completed overlay + target
  const flyLayerRef = useRef<HTMLDivElement>(null);
  const completedTabRef = useRef<HTMLButtonElement>(null);
  // wallet button target for coin animation
  const boardSelectorRef = useRef<HTMLSelectElement>(null);
  const walletButtonRef = useRef<HTMLButtonElement>(null);
  const boardDropContainerRef = useRef<HTMLDivElement>(null);
  const boardDropListRef = useRef<HTMLDivElement>(null);
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

  function flyToCompleted(from: DOMRect) {
    const layer = flyLayerRef.current;
    const targetEl = completedTabRef.current;
    if (!layer || !targetEl) return;
    const target = targetEl.getBoundingClientRect();

    const startX = from.left + from.width / 2;
    const startY = from.top + from.height / 2;
    const endX = target.left + target.width / 2;
    const endY = target.top + target.height / 2;

    const rem = (() => {
      try { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; } catch { return 16; }
    })();
    const dotSize = 1.25 * rem; // 20px @ 16px base
    const dotFont = 0.875 * rem; // 14px @ 16px base

    const dot = document.createElement('div');
    dot.style.position = 'fixed';
    dot.style.left = `${startX - dotSize / 2}px`;
    dot.style.top = `${startY - dotSize / 2}px`;
    dot.style.width = `${dotSize}px`;
    dot.style.height = `${dotSize}px`;
    dot.style.borderRadius = '9999px';
    dot.style.background = '#10b981';
    dot.style.color = 'white';
    dot.style.display = 'grid';
    dot.style.placeItems = 'center';
    dot.style.fontSize = `${dotFont}px`;
    dot.style.lineHeight = `${dotSize}px`;
    dot.style.boxShadow = '0 0 0 2px rgba(16,185,129,0.3), 0 6px 16px rgba(0,0,0,0.35)';
    dot.style.zIndex = '1000';
    dot.style.transform = 'translate(0, 0) scale(1)';
    dot.style.transition = 'transform 600ms cubic-bezier(.2,.7,.3,1), opacity 300ms ease 420ms';
    dot.textContent = '✓';
    layer.appendChild(dot);

    requestAnimationFrame(() => {
      const dx = endX - startX;
      const dy = endY - startY;
      dot.style.transform = `translate(${dx}px, ${dy}px) scale(0.5)`;
      dot.style.opacity = '0.6';
      setTimeout(() => {
        try { layer.removeChild(dot); } catch {}
      }, 750);
    });
  }

  function flyCoinsToWallet(from: DOMRect) {
    const layer = flyLayerRef.current;
    const targetEl = walletButtonRef.current;
    if (!layer || !targetEl) return;
    const target = targetEl.getBoundingClientRect();

    const startX = from.left + from.width / 2;
    const startY = from.top + from.height / 2;
    const endX = target.left + target.width / 2;
    const endY = target.top + target.height / 2;

    const rem = (() => {
      try { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; } catch { return 16; }
    })();
    const coinSize = 1.25 * rem; // 20px @ 16px base
    const coinFont = 0.875 * rem; // 14px @ 16px base

    const makeCoin = () => {
      const coin = document.createElement('div');
      coin.style.position = 'fixed';
      coin.style.left = `${startX - coinSize / 2}px`;
      coin.style.top = `${startY - coinSize / 2}px`;
      coin.style.width = `${coinSize}px`;
      coin.style.height = `${coinSize}px`;
      coin.style.borderRadius = '9999px';
      coin.style.display = 'grid';
      coin.style.placeItems = 'center';
      coin.style.fontSize = `${coinFont}px`;
      coin.style.lineHeight = `${coinSize}px`;
      coin.style.background = 'radial-gradient(circle at 30% 30%, #fde68a, #f59e0b)';
      coin.style.boxShadow = '0 0 0 1px rgba(245,158,11,0.5), 0 6px 16px rgba(0,0,0,0.35)';
      coin.style.zIndex = '1000';
      coin.style.transform = 'translate(0, 0) scale(1)';
      coin.style.transition = 'transform 700ms cubic-bezier(.2,.7,.3,1), opacity 450ms ease 450ms';
      coin.textContent = '🪙';
      return coin;
    };

    for (let i = 0; i < 3; i++) {
      const coin = makeCoin();
      layer.appendChild(coin);
      const dx = endX - startX;
      const dy = endY - startY;
      // slight horizontal variance per coin
      const wobble = (i - 1) * (0.5 * rem); // -0.5rem, 0, +0.5rem
      setTimeout(() => {
        coin.style.transform = `translate(${dx + wobble}px, ${dy}px) scale(0.6)`;
        coin.style.opacity = '0.35';
        setTimeout(() => {
          try { layer.removeChild(coin); } catch {}
        }, 800);
      }, i * 140);
    }
  }

  /* ---------- Derived: board-scoped lists ---------- */
  const tasksForBoard = useMemo(() => {
    return tasks
      .filter(t => t.boardId === currentBoardId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [tasks, currentBoardId]);

  // Week board
  const byDay = useMemo(() => {
    if (!currentBoard || currentBoard.kind !== "week") return new Map<Weekday, Task[]>();
    const visible = tasksForBoard.filter(t => {
      const pendingBounty = t.completed && t.bounty && t.bounty.state !== "claimed";
      return ((!t.completed || pendingBounty || !settings.completedTab) && t.column !== "bounties" && isVisibleNow(t));
    });
    const m = new Map<Weekday, Task[]>();
    for (const t of visible) {
      const wd = new Date(t.dueISO).getDay() as Weekday;
      if (!m.has(wd)) m.set(wd, []);
      m.get(wd)!.push(t);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.completed === b.completed ? (a.order ?? 0) - (b.order ?? 0) : a.completed ? 1 : -1));
    }
    return m;
  }, [tasksForBoard, currentBoard, settings.completedTab]);

  const bounties = useMemo(
    () => currentBoard?.kind === "week"
      ? tasksForBoard
          .filter(t => {
            const pendingBounty = t.completed && t.bounty && t.bounty.state !== "claimed";
            return ((!t.completed || pendingBounty || !settings.completedTab) && t.column === "bounties" && isVisibleNow(t));
          })
          .sort((a, b) => (a.completed === b.completed ? (a.order ?? 0) - (b.order ?? 0) : a.completed ? 1 : -1))
      : [],
    [tasksForBoard, currentBoard.kind, settings.completedTab]
  );

  // Custom list boards
  const listColumns = (currentBoard?.kind === "lists") ? currentBoard.columns : [];
  const itemsByColumn = useMemo(() => {
    if (!currentBoard || currentBoard.kind !== "lists") return new Map<string, Task[]>();
    const m = new Map<string, Task[]>();
    const visible = tasksForBoard.filter(t => {
      const pendingBounty = t.completed && t.bounty && t.bounty.state !== "claimed";
      return ((!t.completed || pendingBounty || !settings.completedTab) && t.columnId && isVisibleNow(t));
    });
    for (const col of currentBoard.columns) m.set(col.id, []);
    for (const t of visible) {
      const arr = m.get(t.columnId!);
      if (arr) arr.push(t);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.completed === b.completed ? (a.order ?? 0) - (b.order ?? 0) : a.completed ? 1 : -1));
    }
    return m;
  }, [tasksForBoard, currentBoard, settings.completedTab]);

  const completed = useMemo(
    () =>
      tasksForBoard
        .filter((t) => t.completed && (!t.bounty || t.bounty.state === "claimed"))
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
  const tagValue = useCallback((ev: NostrEvent, name: string): string | undefined => {
    const t = ev.tags.find((x) => x[0] === name);
    return t ? t[1] : undefined;
  }, []);
  const isShared = (board: Board) => !!board.nostr?.boardId;
  const getBoardRelays = useCallback((board: Board): string[] => {
    return (board.nostr?.relays?.length ? board.nostr!.relays : defaultRelays).filter(Boolean);
  }, [defaultRelays]);
  async function publishBoardMetadata(board: Board) {
    if (!board.nostr?.boardId) return;
    const relays = getBoardRelays(board);
    const idTag = boardTag(board.nostr.boardId);
    const tags: string[][] = [["d", idTag],["b", idTag],["k", board.kind],["name", board.name]];
    const raw = board.kind === "lists" ? JSON.stringify({ columns: board.columns }) : "";
    const content = await encryptToBoard(board.nostr.boardId, raw);
    const createdAt = await nostrPublish(relays, {
      kind: 30300,
      tags,
      content,
      created_at: Math.floor(Date.now() / 1000),
    });
    nostrIdxRef.current.boardMeta.set(idTag, createdAt);
  }
  async function publishTaskDeleted(t: Task) {
    const b = boards.find((x) => x.id === t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    await publishBoardMetadata(b);
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const bTag = boardTag(boardId);
    const colTag = (b.kind === "week") ? (t.column === "bounties" ? "bounties" : "day") : (t.columnId || "");
    const tags: string[][] = [["d", t.id],["b", bTag],["col", String(colTag)],["status","deleted"]];
    const raw = JSON.stringify({ title: t.title, note: t.note || "", dueISO: t.dueISO, completedAt: t.completedAt, recurrence: t.recurrence, hiddenUntilISO: t.hiddenUntilISO, streak: t.streak, subtasks: t.subtasks, seriesId: t.seriesId });
    const content = await encryptToBoard(boardId, raw);
    const createdAt = await nostrPublish(relays, {
      kind: 30301,
      tags,
      content,
      created_at: Math.floor(Date.now() / 1000),
    });
    if (!nostrIdxRef.current.taskClock.has(bTag)) {
      nostrIdxRef.current.taskClock.set(bTag, new Map());
    }
    nostrIdxRef.current.taskClock.get(bTag)!.set(t.id, createdAt);
  }
  async function maybePublishTask(t: Task, boardOverride?: Board) {
    const b = boardOverride || boards.find((x) => x.id === t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    await publishBoardMetadata(b);
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const bTag = boardTag(boardId);
    const status = t.completed ? "done" : "open";
    const colTag = (b.kind === "week") ? (t.column === "bounties" ? "bounties" : "day") : (t.columnId || "");
    const tags: string[][] = [["d", t.id],["b", bTag],["col", String(colTag)],["status", status]];
    const body: any = { title: t.title, note: t.note || "", dueISO: t.dueISO, completedAt: t.completedAt, completedBy: t.completedBy, recurrence: t.recurrence, hiddenUntilISO: t.hiddenUntilISO, createdBy: t.createdBy, order: t.order, streak: t.streak, seriesId: t.seriesId };
    // Include explicit nulls to signal removals when undefined
    body.images = (typeof t.images === 'undefined') ? null : t.images;
    body.bounty = (typeof t.bounty === 'undefined') ? null : t.bounty;
    body.subtasks = (typeof t.subtasks === 'undefined') ? null : t.subtasks;
    const raw = JSON.stringify(body);
    const content = await encryptToBoard(boardId, raw);
    const createdAt = await nostrPublish(relays, {
      kind: 30301,
      tags,
      content,
      created_at: Math.floor(Date.now() / 1000),
    });
    // Update local task clock so immediate refreshes don't revert state
    if (!nostrIdxRef.current.taskClock.has(bTag)) {
      nostrIdxRef.current.taskClock.set(bTag, new Map());
    }
    nostrIdxRef.current.taskClock.get(bTag)!.set(t.id, createdAt);
  }

  function regenerateBoardId(id: string) {
    let updated: Board | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== id || !b.nostr) return b;
      const nb: Board = { ...b, nostr: { ...b.nostr, boardId: crypto.randomUUID() } };
      updated = nb;
      return nb;
    }));
    if (updated) {
      setTimeout(() => {
        publishBoardMetadata(updated!).catch(() => {});
        tasks
          .filter(t => t.boardId === updated!.id)
          .forEach(t => { maybePublishTask(t, updated!).catch(() => {}); });
      }, 0);
    }
  }
  const applyBoardEvent = useCallback(async (ev: NostrEvent) => {
    const d = tagValue(ev, "d");
    if (!d) return;
    const last = nostrIdxRef.current.boardMeta.get(d) || 0;
    if (ev.created_at < last) return;
    // Accept events with the same timestamp to avoid missing updates
    nostrIdxRef.current.boardMeta.set(d, ev.created_at);
    const board = boardsRef.current.find((b) => b.nostr?.boardId && boardTag(b.nostr.boardId) === d);
    if (!board || !board.nostr) return;
    const boardId = board.nostr.boardId;
    const kindTag = tagValue(ev, "k");
    const name = tagValue(ev, "name");
    let payload: any = {};
    try {
      const dec = await decryptFromBoard(boardId, ev.content);
      payload = dec ? JSON.parse(dec) : {};
    } catch {
      try { payload = ev.content ? JSON.parse(ev.content) : {}; } catch {}
    }
    setBoards(prev => prev.map(b => {
      if (b.id !== board.id) return b;
      const nm = name || b.name;
      if (kindTag === "week") return { id: b.id, name: nm, nostr: b.nostr, kind: "week" } as Board;
      if (kindTag === "lists") {
        const cols: ListColumn[] = Array.isArray(payload.columns) ? payload.columns : (b.kind === "lists" ? b.columns : [{ id: crypto.randomUUID(), name: "Items" }]);
        return { id: b.id, name: nm, nostr: b.nostr, kind: "lists", columns: cols } as Board;
      }
      return b;
    }));
  }, [setBoards, tagValue]);
  const applyTaskEvent = useCallback(async (ev: NostrEvent) => {
    const bTag = tagValue(ev, "b");
    const taskId = tagValue(ev, "d");
    if (!bTag || !taskId) return;
    if (!nostrIdxRef.current.taskClock.has(bTag)) nostrIdxRef.current.taskClock.set(bTag, new Map());
    const m = nostrIdxRef.current.taskClock.get(bTag)!;
    const last = m.get(taskId) || 0;
    if (ev.created_at < last) return;
    // Accept equal timestamps so rapid consecutive updates still apply
    m.set(taskId, ev.created_at);

    const lb = boardsRef.current.find((b) => b.nostr?.boardId && boardTag(b.nostr.boardId) === bTag);
    if (!lb || !lb.nostr) return;
    const boardId = lb.nostr.boardId;
    let payload: any = {};
    try {
      const dec = await decryptFromBoard(boardId, ev.content);
      payload = dec ? JSON.parse(dec) : {};
    } catch {
      try { payload = ev.content ? JSON.parse(ev.content) : {}; } catch {}
    }
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
      completedBy: payload.completedBy,
      recurrence: payload.recurrence,
      hiddenUntilISO: payload.hiddenUntilISO,
      order: typeof payload.order === 'number' ? payload.order : undefined,
      streak: typeof payload.streak === 'number' ? payload.streak : undefined,
      seriesId: payload.seriesId,
      subtasks: Array.isArray(payload.subtasks) ? payload.subtasks : undefined,
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
      const incNewer = incT > oldT || (incT === oldT && ev.created_at > (nostrIdxRef.current.taskClock.get(bTag)?.get(taskId) || 0));

        // Different ids: pick the newer one
        if (oldB.id !== incoming.id) return incNewer ? incoming : oldB;

        const next = { ...oldB } as Task["bounty"];
        // accept token/content updates if incoming is newer
        if (incNewer) {
          if (typeof incoming.amount === 'number') next.amount = incoming.amount;
          next.mint = incoming.mint ?? next.mint;
          next.lock = incoming.lock ?? next.lock;
          // Only overwrite token if sender/owner published or token becomes visible
          if (incoming.token) next.token = incoming.token;
          next.enc = incoming.enc !== undefined ? incoming.enc : next.enc;
          if (incoming.receiver) next.receiver = incoming.receiver;
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
        // Determine incoming images raw (allow explicit null removal)
        const incomingImgs: string[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'images') ? payload.images : undefined;
        const mergedImages = incomingImgs === undefined ? current.images : incomingImgs === null ? undefined : incomingImgs;
        const newOrder = typeof base.order === 'number' ? base.order : current.order;
        const incomingStreak: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'streak') ? payload.streak : undefined;
        const newStreak = incomingStreak === undefined ? current.streak : incomingStreak === null ? undefined : incomingStreak;
        const incomingSubs: Subtask[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'subtasks') ? payload.subtasks : undefined;
        const mergedSubs = incomingSubs === undefined ? current.subtasks : incomingSubs === null ? undefined : incomingSubs;
        copy[idx] = { ...current, ...base, order: newOrder, images: mergedImages, bounty: mergeBounty(current.bounty, incomingB as any), streak: newStreak, subtasks: mergedSubs };
        return copy;
      } else {
        const incomingB: Task["bounty"] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'bounty') ? payload.bounty : undefined;
        const incomingImgs: string[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'images') ? payload.images : undefined;
        const imgs = incomingImgs === null ? undefined : Array.isArray(incomingImgs) ? incomingImgs : undefined;
        const incomingStreak: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'streak') ? payload.streak : undefined;
        const st = incomingStreak === null ? undefined : typeof incomingStreak === 'number' ? incomingStreak : undefined;
        const incomingSubs: Subtask[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'subtasks') ? payload.subtasks : undefined;
        const subs = incomingSubs === null ? undefined : Array.isArray(incomingSubs) ? incomingSubs : undefined;
        const newOrder = typeof base.order === 'number' ? base.order : 0;
        return [...prev, { ...base, order: newOrder, images: imgs, bounty: incomingB === null ? undefined : incomingB, streak: st, subtasks: subs }];
      }
    });
  }, [setTasks, tagValue]);

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

  function applyHiddenForFuture(t: Task) {
    const due = startOfDay(new Date(t.dueISO));
    const nowSow = startOfWeek(new Date(), settings.weekStart);
    const dueSow = startOfWeek(due, settings.weekStart);
    if (dueSow.getTime() > nowSow.getTime()) t.hiddenUntilISO = dueSow.toISOString();
    else t.hiddenUntilISO = undefined;
  }

  function nextOrderForBoard(boardId: string, arr: Task[]): number {
    const boardTasks = arr.filter(x => x.boardId === boardId);
    if (settings.newTaskPosition === "top") {
      const minOrder = boardTasks.reduce((min, t) => Math.min(min, t.order ?? 0), 0);
      return minOrder - 1;
    }
    return boardTasks.reduce((max, t) => Math.max(max, t.order ?? -1), -1) + 1;
  }

  function sameSeries(a: Task, b: Task): boolean {
    if (a.seriesId && b.seriesId) return a.seriesId === b.seriesId;
    return (
      a.boardId === b.boardId &&
      a.title === b.title &&
      a.note === b.note &&
      a.recurrence && b.recurrence &&
      JSON.stringify(a.recurrence) === JSON.stringify(b.recurrence)
    );
  }

  function ensureWeekRecurrences(arr: Task[], sources?: Task[]): Task[] {
    const sow = startOfWeek(new Date(), settings.weekStart).getTime();
    const out = [...arr];
    let changed = false;
    const src = sources ?? arr;
    for (const t of src) {
      if (!t.recurrence) continue;
      const seriesId = t.seriesId || t.id;
      if (!t.seriesId) {
        const idx = out.findIndex(x => x.id === t.id);
        if (idx >= 0 && out[idx].seriesId !== seriesId) {
          out[idx] = { ...out[idx], seriesId };
          changed = true;
        }
      }
      let nextISO = nextOccurrence(t.dueISO, t.recurrence);
      while (nextISO) {
        const nextDate = new Date(nextISO);
        const nsow = startOfWeek(nextDate, settings.weekStart).getTime();
        if (nsow > sow) break;
        if (nsow === sow) {
          const exists = out.some(x =>
            sameSeries(x, { ...t, seriesId }) &&
            startOfDay(new Date(x.dueISO)).getTime() === startOfDay(nextDate).getTime()
          );
          if (!exists) {
            const clone: Task = {
              ...t,
              id: crypto.randomUUID(),
              seriesId,
              completed: false,
              completedAt: undefined,
              completedBy: undefined,
              dueISO: nextISO,
              hiddenUntilISO: undefined,
              order: nextOrderForBoard(t.boardId, out),
              subtasks: t.subtasks?.map(s => ({ ...s, completed: false })),
            };
            maybePublishTask(clone).catch(() => {});
            out.push(clone);
            changed = true;
          }
        }
        nextISO = nextOccurrence(nextISO, t.recurrence);
      }
    }
    return changed ? out : arr;
  }

  function addTask(keepKeyboard = false) {
    if (!currentBoard) return;

    const raw = newTitle.trim();
    if (raw) {
      try {
        const parsed: any = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.title && parsed.dueISO) {
          const nextOrder = nextOrderForBoard(currentBoard.id, tasks);
          const id = crypto.randomUUID();
          const imported: Task = {
            ...parsed,
            id,
            seriesId: parsed.recurrence ? (parsed.seriesId || id) : undefined,
            boardId: currentBoard.id,
            order: typeof parsed.order === "number" ? parsed.order : nextOrder,
          };
          applyHiddenForFuture(imported);
          setTasks(prev => {
            const out = [...prev, imported];
            return settings.showFullWeekRecurring && imported.recurrence ? ensureWeekRecurrences(out, [imported]) : out;
          });
          maybePublishTask(imported).catch(() => {});
          setNewTitle("");
          setNewImages([]);
          setQuickRule("none");
          setAddCustomRule(R_NONE);
          setScheduleDate("");
          if (keepKeyboard) newTitleRef.current?.focus();
          else newTitleRef.current?.blur();
          return;
        }
      } catch {}
    }

    const title = raw || (newImages.length ? "Image" : "");
    if ((!title && !newImages.length)) return;

    const candidate = resolveQuickRule();
    const recurrence = candidate.type === "none" ? undefined : candidate;
    let dueISO = isoForWeekday(0);
    if (scheduleDate) {
      dueISO = new Date(scheduleDate + "T00:00").toISOString();
    } else if (currentBoard.kind === "week" && dayChoice !== "bounties") {
      dueISO = isoForWeekday(dayChoice as Weekday);
    }

    const nextOrder = nextOrderForBoard(currentBoard.id, tasks);
    const id = crypto.randomUUID();
    const t: Task = {
      id,
      seriesId: recurrence ? id : undefined,
      boardId: currentBoard.id,
      createdBy: nostrPK || undefined,
      title,
      dueISO,
      completed: false,
      recurrence,
      order: nextOrder,
      streak: recurrence && (recurrence.type === "daily" || recurrence.type === "weekly") ? 0 : undefined,
    };
    if (newImages.length) t.images = newImages;
    if (currentBoard.kind === "week") {
      t.column = dayChoice === "bounties" ? "bounties" : "day";
    } else {
      // lists board
      const firstCol = currentBoard.columns[0];
      const selectedColId = typeof dayChoice === "string" ? dayChoice : firstCol?.id;
      t.columnId = selectedColId || firstCol?.id;
    }
    applyHiddenForFuture(t);
    setTasks(prev => {
      const out = [...prev, t];
      return settings.showFullWeekRecurring && recurrence ? ensureWeekRecurrences(out, [t]) : out;
    });
    // Publish to Nostr if board is shared
    maybePublishTask(t).catch(() => {});
    setNewTitle("");
    setNewImages([]);
    setQuickRule("none");
    setAddCustomRule(R_NONE);
    setScheduleDate("");
    if (keepKeyboard) newTitleRef.current?.focus();
    else newTitleRef.current?.blur();
  }

  function addInlineTask(key: string) {
    if (!currentBoard) return;
    const raw = (inlineTitles[key] || "").trim();
    if (!raw) return;

    let dueISO = isoForWeekday(0);
    const nextOrder = nextOrderForBoard(currentBoard.id, tasks);
    const id = crypto.randomUUID();
    const t: Task = {
      id,
      boardId: currentBoard.id,
      createdBy: nostrPK || undefined,
      title: raw,
      dueISO,
      completed: false,
      order: nextOrder,
    };
    if (currentBoard.kind === "week") {
      if (key === "bounties") t.column = "bounties";
      else {
        t.column = "day";
        dueISO = isoForWeekday(Number(key) as Weekday);
        t.dueISO = dueISO;
      }
    } else {
      t.columnId = key;
    }
    applyHiddenForFuture(t);
    setTasks(prev => [...prev, t]);
    maybePublishTask(t).catch(() => {});
    setInlineTitles(prev => ({ ...prev, [key]: "" }));
  }

  function completeTask(id: string) {
    setTasks(prev => {
      const cur = prev.find(t => t.id === id);
      if (!cur) return prev;
      const now = new Date().toISOString();
      let newStreak = typeof cur.streak === "number" ? cur.streak : 0;
      if (
        settings.streaksEnabled &&
        cur.recurrence &&
        (cur.recurrence.type === "daily" || cur.recurrence.type === "weekly")
      ) {
        // Previously the streak only incremented when completing a task on the
        // same day it was due. This prevented users from keeping their streak
        // if they forgot to check the app and completed the task a day later.
        // Now the streak simply increments whenever the task is completed,
        // regardless of the current timestamp.
        newStreak = newStreak + 1;
      }
      const toPublish: Task[] = [];
      let nextId: string | null = null;
      if (
        settings.showFullWeekRecurring &&
        settings.streaksEnabled &&
        cur.recurrence &&
        (cur.recurrence.type === "daily" || cur.recurrence.type === "weekly")
      ) {
        nextId =
          prev
            .filter(
              t =>
                t.id !== id &&
                !t.completed &&
                t.recurrence &&
                sameSeries(t, cur) &&
                new Date(t.dueISO) > new Date(cur.dueISO)
            )
            .sort(
              (a, b) =>
                new Date(a.dueISO).getTime() - new Date(b.dueISO).getTime()
            )[0]?.id || null;
      }
      const updated = prev.map(t => {
        if (t.id === id) {
          const done = {
            ...t,
            seriesId: t.seriesId || t.id,
            completed: true,
            completedAt: now,
            completedBy: (window as any).nostrPK || undefined,
            streak: newStreak,
          };
          toPublish.push(done);
          return done;
        }
        if (t.id === nextId) {
          const upd = { ...t, seriesId: t.seriesId || t.id, streak: newStreak };
          toPublish.push(upd);
          return upd;
        }
        return t;
      });
      toPublish.forEach(t => {
        maybePublishTask(t).catch(() => {});
      });
      const nextISO = cur.recurrence ? nextOccurrence(cur.dueISO, cur.recurrence) : null;
      if (nextISO && cur.recurrence) {
        let shouldClone = true;
        if (settings.showFullWeekRecurring) {
          const nextDate = new Date(nextISO);
          const nsow = startOfWeek(nextDate, settings.weekStart).getTime();
          const csow = startOfWeek(new Date(), settings.weekStart).getTime();
          if (nsow === csow) {
            const exists = updated.some(x =>
              sameSeries(x, cur) &&
              startOfDay(new Date(x.dueISO)).getTime() === startOfDay(nextDate).getTime()
            );
            if (exists) shouldClone = false;
          }
        }
        if (shouldClone) {
          const nextOrder = nextOrderForBoard(cur.boardId, updated);
          const clone: Task = {
            ...cur,
            id: crypto.randomUUID(),
            seriesId: cur.seriesId || cur.id,
            completed: false,
            completedAt: undefined,
            completedBy: undefined,
            dueISO: nextISO,
            hiddenUntilISO: hiddenUntilForNext(nextISO, cur.recurrence, settings.weekStart),
            order: nextOrder,
            streak: newStreak,
            subtasks: cur.subtasks?.map(s => ({ ...s, completed: false })),
          };
          maybePublishTask(clone).catch(() => {});
          return [...updated, clone];
        }
      }
      return updated;
    });
    burst();
  }

  function toggleSubtask(taskId: string, subId: string) {
    setTasks(prev =>
      prev.map((t) => {
        if (t.id !== taskId) return t;
        const subs = (t.subtasks || []).map((s) =>
          s.id === subId ? { ...s, completed: !s.completed } : s
        );
        const updated: Task = { ...t, subtasks: subs };
        maybePublishTask(updated).catch(() => {});
        return updated;
      })
    );
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
    setTasks(prev => {
      const arr = prev.filter(x => x.id !== id);
      const toPublish: Task[] = [];
      if (
        settings.showFullWeekRecurring &&
        settings.streaksEnabled &&
        t.recurrence &&
        (t.recurrence.type === "daily" || t.recurrence.type === "weekly")
      ) {
        const next = arr
          .filter(x => !x.completed && x.recurrence && sameSeries(x, t) && new Date(x.dueISO) > new Date(t.dueISO))
          .sort((a, b) => new Date(a.dueISO).getTime() - new Date(b.dueISO).getTime())[0];
        if (next) {
          const idx = arr.findIndex(x => x.id === next.id);
          arr[idx] = { ...next, seriesId: next.seriesId || next.id, streak: 0 };
          toPublish.push(arr[idx]);
        }
      }
      toPublish.forEach(x => maybePublishTask(x).catch(() => {}));
      return arr;
    });
    publishTaskDeleted(t).catch(() => {});
    setTimeout(() => setUndoTask(null), 5000); // undo duration
  }
  function undoDelete() {
    if (undoTask) { setTasks(prev => [...prev, undoTask]); setUndoTask(null); }
  }

  function restoreTask(id: string) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const toPublish: Task[] = [];
    const recurringStreak =
      settings.streaksEnabled &&
      t.recurrence &&
      (t.recurrence.type === "daily" || t.recurrence.type === "weekly") &&
      typeof t.streak === "number";
    const newStreak = recurringStreak ? Math.max(0, t.streak! - 1) : t.streak;
    setTasks(prev => {
      const arr = prev.map(x => {
        if (x.id !== id) return x;
        const upd: Task = {
          ...x,
          completed: false,
          completedAt: undefined,
          completedBy: undefined,
          streak: newStreak,
        };
        toPublish.push(upd);
        return upd;
      });
      if (recurringStreak) {
        const future = arr.filter(
          x =>
            x.id !== id &&
            !x.completed &&
            x.recurrence &&
            sameSeries(x, t) &&
            new Date(x.dueISO) > new Date(t.dueISO)
        );
        future.forEach(f => {
          const idx = arr.findIndex(x => x.id === f.id);
          const upd = { ...f, seriesId: f.seriesId || f.id, streak: newStreak };
          arr[idx] = upd;
          toPublish.push(upd);
        });
      }
      return arr;
    });
    toPublish.forEach(x => maybePublishTask(x).catch(() => {}));
  }
  function clearCompleted() {
    for (const t of tasksForBoard)
      if (t.completed && (!t.bounty || t.bounty.state === 'claimed'))
        publishTaskDeleted(t).catch(() => {});
    setTasks(prev => prev.filter(t => !(t.completed && (!t.bounty || t.bounty.state === 'claimed'))));
  }

  function postponeTaskOneWeek(id: string) {
    let updated: Task | undefined;
    setTasks(prev => prev.map(t => {
      if (t.id !== id) return t;
      const nextDue = startOfDay(new Date(t.dueISO));
      nextDue.setDate(nextDue.getDate() + 7);
      updated = {
        ...t,
        dueISO: nextDue.toISOString(),
        hiddenUntilISO: startOfWeek(nextDue, settings.weekStart).toISOString(),
      };
      return updated!;
    }));
    if (updated) {
      maybePublishTask(updated).catch(() => {});
      showToast('Task moved to next week');
    }
  }

  async function revealBounty(id: string) {
    const t = tasks.find(x => x.id === id);
    if (!t || !t.bounty || t.bounty.state !== 'locked' || !t.bounty.enc) return;
    try {
      let pt = "";
      const enc = t.bounty.enc as any;
      const me = (window as any).nostrPK as string | undefined;
      if (enc.alg === 'aes-gcm-256') {
        if (!me || t.bounty.sender !== me) throw new Error('Only the funder can reveal this token.');
        pt = await decryptEcashTokenForFunder(enc);
      } else if (enc.alg === 'nip04') {
        if (!me || t.bounty.receiver !== me) throw new Error('Only the intended recipient can decrypt this token.');
        if (!t.bounty.sender) throw new Error('Missing sender pubkey');
        pt = await decryptEcashTokenForRecipient(t.bounty.sender, enc);
      } else {
        throw new Error('Unsupported cipher');
      }
      const updated: Task = {
        ...t,
        bounty: { ...t.bounty, token: pt, enc: undefined, state: 'unlocked', updatedAt: new Date().toISOString() },
      };
      setTasks(prev => prev.map(x => x.id === id ? updated : x));
      maybePublishTask(updated).catch(() => {});
    } catch (e) {
      alert('Decrypt failed: ' + (e as Error).message);
    }
  }

  async function claimBounty(id: string, from?: DOMRect) {
    const t = tasks.find(x => x.id === id);
    if (!t || !t.bounty || t.bounty.state !== 'unlocked' || !t.bounty.token) return;
    try {
      const res = await receiveToken(t.bounty.token);
      if (res.crossMint) {
        alert(`Redeemed to a different mint: ${res.usedMintUrl}. Switch to that mint to view the balance.`);
      }
      try { if (from) flyCoinsToWallet(from); } catch {}
      const updated: Task = {
        ...t,
        bounty: { ...t.bounty, token: '', state: 'claimed', updatedAt: new Date().toISOString() },
      };
      setTasks(prev => prev.map(x => x.id === id ? updated : x));
      maybePublishTask(updated).catch(() => {});
    } catch (e) {
      alert('Redeem failed: ' + (e as Error).message);
    }
  }

  function saveEdit(updated: Task) {
    setTasks(prev => {
      let edited: Task | null = null;
      const arr = prev.map(t => {
        if (t.id !== updated.id) return t;
        let next = updated;
        if (
          settings.streaksEnabled &&
          t.recurrence &&
          (t.recurrence.type === "daily" || t.recurrence.type === "weekly") &&
          !t.completed
        ) {
          const prevDue = startOfDay(new Date(t.dueISO));
          const newDue = startOfDay(new Date(updated.dueISO));
          if (newDue.getTime() > prevDue.getTime()) {
            next = { ...updated, streak: 0 };
          }
        }
        if (next.recurrence) next = { ...next, seriesId: next.seriesId || next.id };
        else next = { ...next, seriesId: undefined };
        maybePublishTask(next).catch(() => {});
        edited = next;
        return next;
      });
      return settings.showFullWeekRecurring && edited?.recurrence
        ? ensureWeekRecurrences(arr, [edited])
        : arr;
    });
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
      const prevDue = startOfDay(new Date(task.dueISO));
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
      const newDue = startOfDay(new Date(updated.dueISO));
      if (
        settings.streaksEnabled &&
        task.recurrence &&
        (task.recurrence.type === "daily" || task.recurrence.type === "weekly") &&
        !task.completed &&
        newDue.getTime() > prevDue.getTime()
      ) {
        updated.streak = 0;
      }
      // reveal if user manually places it
      updated.hiddenUntilISO = undefined;

      // un-complete only if it doesn't have a pending bounty
      if (updated.completed && (!updated.bounty || updated.bounty.state === "claimed")) {
        updated.completed = false;
        updated.completedAt = undefined;
        updated.completedBy = undefined;
      }

      // remove original
      arr.splice(fromIdx, 1);
      // compute insert index relative to new array
      let insertIdx = typeof beforeId === "string" ? arr.findIndex(t => t.id === beforeId) : -1;
      if (insertIdx < 0) insertIdx = arr.length;
      arr.splice(insertIdx, 0, updated);

      // recompute order for all tasks on this board
      const boardTasks: Task[] = [];
      let order = 0;
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (t.boardId === updated.boardId) {
          if (t === updated) {
            updated.order = order;
          } else {
            arr[i] = { ...t, order };
          }
          boardTasks.push(arr[i]);
          order++;
        }
      }
      try {
        for (const t of boardTasks) maybePublishTask(t).catch(() => {});
      } catch {}

      return arr;
    });
  }

  function moveTaskToBoard(id: string, boardId: string) {
    setTasks(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(t => t.id === id);
      if (fromIdx < 0) return prev;
      const task = arr[fromIdx];
      const targetBoard = boards.find(b => b.id === boardId);
      if (!targetBoard) return prev;

      // remove from source
      arr.splice(fromIdx, 1);

      // recompute order for source board
      const sourceTasks: Task[] = [];
      let order = 0;
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (t.boardId === task.boardId) {
          arr[i] = { ...t, order };
          sourceTasks.push(arr[i]);
          order++;
        }
      }

      const updated: Task = { ...task, boardId };
      if (targetBoard.kind === "week") {
        updated.column = "day";
        updated.columnId = undefined;
      } else {
        updated.column = undefined;
        updated.columnId = targetBoard.columns[0]?.id;
        updated.dueISO = isoForWeekday(0);
      }

      arr.push(updated);

      const targetTasks: Task[] = [];
      order = 0;
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (t.boardId === boardId) {
          if (t === updated) {
            updated.order = order;
          } else {
            arr[i] = { ...t, order };
          }
          targetTasks.push(arr[i]);
          order++;
        }
      }

      try {
        for (const t of [...sourceTasks, ...targetTasks]) maybePublishTask(t).catch(() => {});
      } catch {}

      return arr;
    });
  }

  // Subscribe to Nostr for all shared boards
  const nostrBoardsKey = useMemo(() => {
    const items = boards
      .filter(b => b.nostr?.boardId)
      .map(b => ({ id: boardTag(b.nostr!.boardId), relays: getBoardRelays(b).join(",") }))
      .sort((a,b) => (a.id + a.relays).localeCompare(b.id + b.relays));
    return JSON.stringify(items);
  }, [boards, getBoardRelays]);

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
        if (ev.kind === 30300) applyBoardEvent(ev).catch(() => {});
        else if (ev.kind === 30301) applyTaskEvent(ev).catch(() => {});
      });
      unsubs.push(unsub);
    }
    return () => { unsubs.forEach(u => u()); };
  }, [nostrBoardsKey, pool, applyBoardEvent, applyTaskEvent, nostrRefresh]);

  // reset dayChoice when board/view changes and center current day for week boards
  useEffect(() => {
    if (!currentBoard || view !== "board") return;
    if (currentBoard.kind === "lists") {
      const firstCol = currentBoard.columns[0];
      const valid = currentBoard.columns.some(c => c.id === dayChoice);
      if (!valid) setDayChoice(firstCol?.id || crypto.randomUUID());
    } else {
      const today = new Date().getDay() as Weekday;
      setDayChoice(today);
      requestAnimationFrame(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const el = scroller.querySelector(`[data-day='${today}']`) as HTMLElement | null;
        if (!el) return;
        const offset = el.offsetLeft - scroller.clientWidth / 2 + el.clientWidth / 2;
        scroller.scrollTo({ left: offset, behavior: "smooth" });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBoardId, currentBoard?.columns, currentBoard?.kind, view]);

  // horizontal scroller ref to enable iOS momentum scrolling
  const scrollerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="mb-4">
          <div className="flex items-center mb-4">
            <h1 className="text-2xl font-semibold tracking-tight">Taskify</h1>
            <div className="ml-auto flex items-center gap-2">
              {/* Refresh (if shared) */}
              {currentBoard?.nostr?.boardId && (
                <button
                  className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
                  onClick={() => setNostrRefresh(n => n + 1)}
                  title="Refresh shared board"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="w-5 h-5 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0114.13-3.36L23 10" />
                    <path d="M20.49 15a9 9 0 01-14.13 3.36L1 14" />
                  </svg>
                </button>
              )}
              {/* Wallet */}
              <button
                ref={walletButtonRef}
                className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
                onClick={() => setShowWallet(true)}
                title="Wallet"
              >
                💰
              </button>
              {/* Settings */}
              <button
                className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
                onClick={() => setShowSettings(true)}
                title="Settings"
              >
                ⚙️
              </button>
            </div>
          </div>
          <div ref={confettiRef} className="relative h-0 w-full" />
          <div className="flex items-center gap-3 w-full overflow-x-auto overflow-y-visible">
            {/* Board switcher */}
            <div className="flex items-center gap-2">
              <div
                ref={boardDropContainerRef}
                className="relative"
                onDragOver={e => {
                  if (!draggingTaskId) return;
                  e.preventDefault();
                  cancelBoardDropClose();
                  if (!boardDropOpen && !boardDropTimer.current) {
                    boardDropTimer.current = window.setTimeout(() => {
                      const rect = boardDropContainerRef.current?.getBoundingClientRect();
                      if (rect) {
                        setBoardDropPos({ top: rect.top, left: rect.right });
                      }
                      setBoardDropOpen(true);
                      boardDropTimer.current = undefined;
                    }, 500);
                  }
                }}
                onDragLeave={() => {
                  if (!draggingTaskId) return;
                  if (boardDropTimer.current) {
                    window.clearTimeout(boardDropTimer.current);
                    boardDropTimer.current = undefined;
                  }
                  scheduleBoardDropClose();
                }}
              >
                <select
                  ref={boardSelectorRef}
                  value={currentBoardId}
                  onChange={handleBoardSelect}
                  className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
                  title="Boards"
                >
                  {boards.length === 0 ? (
                    <option value="">No boards</option>
                  ) : (
                    boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)
                  )}
                </select>
                {boardDropOpen && boardDropPos &&
                  createPortal(
                    <div
                      ref={boardDropListRef}
                      className="fixed w-48 rounded-xl border border-neutral-800 bg-neutral-900 z-50"
                      style={{ top: boardDropPos.top, left: boardDropPos.left }}
                      onDragOver={e => {
                        if (!draggingTaskId) return;
                        e.preventDefault();
                        cancelBoardDropClose();
                      }}
                      onDragLeave={() => {
                        if (!draggingTaskId) return;
                        scheduleBoardDropClose();
                      }}
                    >
                      {boards.map(b => (
                        <div
                          key={b.id}
                          className="px-3 py-2 hover:bg-neutral-800"
                          onDragOver={e => { if (draggingTaskId) e.preventDefault(); }}
                          onDrop={e => {
                            if (!draggingTaskId) return;
                            e.preventDefault();
                            moveTaskToBoard(draggingTaskId, b.id);
                            handleDragEnd();
                          }}
                        >
                          {b.name}
                        </div>
                      ))}
                    </div>,
                    document.body
                  )}
              </div>
            </div>
            <div className="ml-auto flex-shrink-0">
              {settings.completedTab ? (
                <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden flex">
                  <button className={`px-3 py-2 flex-1 ${view==="board" ? "bg-neutral-800":""}`} onClick={()=>setView("board")}>Board</button>
                  <button ref={completedTabRef} className={`px-3 py-2 flex-1 ${view==="completed" ? "bg-neutral-800":""}`} onClick={()=>setView("completed")}>Completed</button>
                </div>
              ) : (
                <button
                  className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 disabled:opacity-50"
                  onClick={clearCompleted}
                  disabled={completed.length === 0}
                >
                  Clear completed
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Animation overlay for fly effects (coins, etc.) */}
        <div ref={flyLayerRef} className="pointer-events-none fixed inset-0 z-[9999]" />

        {/* Add bar */}
        {(view === "board" || !settings.completedTab) && currentBoard && !settings.inlineAdd && (
          <div className="flex flex-wrap gap-2 items-center mb-4">
            <input
              ref={newTitleRef}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onPaste={handleAddPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTask(true);
                }
              }}
              placeholder="New task…"
              className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 outline-none"
            />
            <button
              onClick={() => addTask()}
              className="shrink-0 px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-medium"
            >
              Add
            </button>
            {newImages.length > 0 && (
              <div className="w-full flex gap-2 mt-2">
                {newImages.map((img, i) => (
                  <img key={i} src={img} className="h-16 rounded-lg" />
                ))}
              </div>
            )}

            {/* Column picker and recurrence */}
            <div className="w-full flex gap-2 items-center">
              {currentBoard.kind === "week" ? (
                <select
                  value={dayChoice === "bounties" ? "bounties" : String(dayChoice)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDayChoice(v === "bounties" ? "bounties" : (Number(v) as Weekday));
                    setScheduleDate("");
                  }}
                  className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 truncate"
                >
                  {WD_SHORT.map((d,i)=>(<option key={i} value={i}>{d}</option>))}
                  <option value="bounties">Bounties</option>
                </select>
              ) : (
                <select
                  value={String(dayChoice)}
                  onChange={(e)=>setDayChoice(e.target.value)}
                  className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 truncate"
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
                className="shrink-0 w-fit px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
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
                <span className="flex-shrink-0 text-xs text-neutral-400">({labelOf(addCustomRule)})</span>
              )}
            </div>
          </div>
        )}

        {/* Board/Completed */}
        {view === "board" || !settings.completedTab ? (
          !currentBoard ? (
            <div className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-6 text-center text-sm text-neutral-400">No boards. Open Settings to create one.</div>
          ) : currentBoard.kind === "week" ? (
            <>
              {/* HORIZONTAL board: single row, side-scroll */}
              <div
                ref={scrollerRef}
                className="overflow-x-auto pb-4 w-full"
                style={{ WebkitOverflowScrolling: "touch" }} // fluid momentum scroll on iOS
              >
                <div className="flex gap-4 min-w-max">
                  {Array.from({ length: 7 }, (_, i) => i as Weekday).map((day) => (
                    <DroppableColumn
                      key={day}
                      title={WD_SHORT[day]}
                      onTitleClick={() => { setDayChoice(day); setScheduleDate(""); }}
                      onDropCard={(payload) => moveTask(payload.id, { type: "day", day })}
                      onDropEnd={handleDragEnd}
                      data-day={day}
                      scrollable={settings.inlineAdd}
                      footer={settings.inlineAdd ? (
                        <form
                          className="mt-2 flex gap-1"
                          onSubmit={(e) => { e.preventDefault(); addInlineTask(String(day)); }}
                        >
                          <input
                            value={inlineTitles[String(day)] || ""}
                            onChange={(e) => setInlineTitles(prev => ({ ...prev, [String(day)]: e.target.value }))}
                            className="flex-1 min-w-0 px-2 py-1 rounded-xl bg-neutral-900 border border-neutral-800 text-sm"
                            placeholder="Add task"
                          />
                          <button type="submit" className="rounded-xl bg-emerald-600 hover:bg-emerald-500">+</button>
                        </form>
                      ) : undefined}
                    >
                        {(byDay.get(day) || []).map((t) => (
                        <Card
                          key={t.id}
                          task={t}
                          onFlyToCompleted={(rect) => { if (settings.completedTab) flyToCompleted(rect); }}
                          onComplete={(from) => {
                            if (!t.completed) completeTask(t.id);
                            else if (t.bounty && t.bounty.state === 'locked') revealBounty(t.id);
                            else if (t.bounty && t.bounty.state === 'unlocked' && t.bounty.token) claimBounty(t.id, from);
                            else restoreTask(t.id);
                          }}
                          onEdit={() => setEditing(t)}
                          onDropBefore={(dragId) => moveTask(dragId, { type: "day", day }, t.id)}
                          showStreaks={settings.streaksEnabled}
                          onToggleSubtask={(subId) => toggleSubtask(t.id, subId)}
                          onDragStart={(id) => setDraggingTaskId(id)}
                          onDragEnd={handleDragEnd}
                        />
                      ))}
                    </DroppableColumn>
                  ))}

                  {/* Bounties */}
                  <DroppableColumn
                    title="Bounties"
                    onTitleClick={() => { setDayChoice("bounties"); setScheduleDate(""); }}
                    onDropCard={(payload) => moveTask(payload.id, { type: "bounties" })}
                    onDropEnd={handleDragEnd}
                    scrollable={settings.inlineAdd}
                    footer={settings.inlineAdd ? (
                      <form
                        className="mt-2 flex gap-1"
                        onSubmit={(e) => { e.preventDefault(); addInlineTask("bounties"); }}
                      >
                        <input
                          value={inlineTitles["bounties"] || ""}
                          onChange={(e) => setInlineTitles(prev => ({ ...prev, bounties: e.target.value }))}
                          className="flex-1 min-w-0 px-2 py-1 rounded-xl bg-neutral-900 border border-neutral-800 text-sm"
                          placeholder="Add task"
                        />
                        <button type="submit" className="rounded-xl bg-emerald-600 hover:bg-emerald-500">+</button>
                      </form>
                    ) : undefined}
                  >
                      {bounties.map((t) => (
                        <Card
                          key={t.id}
                          task={t}
                          onFlyToCompleted={(rect) => { if (settings.completedTab) flyToCompleted(rect); }}
                          onComplete={(from) => {
                            if (!t.completed) completeTask(t.id);
                            else if (t.bounty && t.bounty.state === 'locked') revealBounty(t.id);
                            else if (t.bounty && t.bounty.state === 'unlocked' && t.bounty.token) claimBounty(t.id, from);
                            else restoreTask(t.id);
                          }}
                          onEdit={() => setEditing(t)}
                          onDropBefore={(dragId) => moveTask(dragId, { type: "bounties" }, t.id)}
                          showStreaks={settings.streaksEnabled}
                          onToggleSubtask={(subId) => toggleSubtask(t.id, subId)}
                          onDragStart={(id) => setDraggingTaskId(id)}
                          onDragEnd={handleDragEnd}
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
              className="overflow-x-auto pb-4 w-full"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className="flex gap-4 min-w-max">
                {listColumns.map(col => (
                  <DroppableColumn
                    key={col.id}
                    title={col.name}
                    onTitleClick={() => setDayChoice(col.id)}
                    onDropCard={(payload) => moveTask(payload.id, { type: "list", columnId: col.id })}
                    onDropEnd={handleDragEnd}
                    scrollable={settings.inlineAdd}
                    footer={settings.inlineAdd ? (
                      <form
                        className="mt-2 flex gap-1"
                        onSubmit={(e) => { e.preventDefault(); addInlineTask(col.id); }}
                      >
                        <input
                          value={inlineTitles[col.id] || ""}
                          onChange={(e) => setInlineTitles(prev => ({ ...prev, [col.id]: e.target.value }))}
                          className="flex-1 min-w-0 px-2 py-1 rounded-xl bg-neutral-900 border border-neutral-800 text-sm"
                          placeholder="Add task"
                        />
                        <button type="submit" className="rounded-xl bg-emerald-600 hover:bg-emerald-500">+</button>
                      </form>
                    ) : undefined}
                  >
                      {(itemsByColumn.get(col.id) || []).map((t) => (
                        <Card
                          key={t.id}
                          task={t}
                          onFlyToCompleted={(rect) => { if (settings.completedTab) flyToCompleted(rect); }}
                          onComplete={(from) => {
                            if (!t.completed) completeTask(t.id);
                            else if (t.bounty && t.bounty.state === 'locked') revealBounty(t.id);
                            else if (t.bounty && t.bounty.state === 'unlocked' && t.bounty.token) claimBounty(t.id, from);
                            else restoreTask(t.id);
                          }}
                          onEdit={() => setEditing(t)}
                          onDropBefore={(dragId) => moveTask(dragId, { type: "list", columnId: col.id }, t.id)}
                          showStreaks={settings.streaksEnabled}
                          onToggleSubtask={(subId) => toggleSubtask(t.id, subId)}
                          onDragStart={(id) => setDraggingTaskId(id)}
                          onDragEnd={handleDragEnd}
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
                  <li key={t.id} className="task px-3 rounded-xl bg-neutral-800 border border-neutral-700">
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                      <div className="text-sm font-medium leading-[1.15]">
                          {renderTitleWithLink(t.title, t.note)}
                        </div>
                        <div className="text-xs text-neutral-400">
                          {currentBoard?.kind === "week"
                            ? `Scheduled ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}`
                            : "Completed item"}
                          {t.completedAt ? ` • Completed ${new Date(t.completedAt).toLocaleString()}` : ""}
                          {settings.streaksEnabled &&
                            t.recurrence &&
                            (t.recurrence.type === "daily" || t.recurrence.type === "weekly") &&
                            typeof t.streak === "number" && t.streak > 0
                              ? ` • 🔥 ${t.streak}`
                              : ""}
                        </div>
                        <TaskMedia task={t} />
                        {t.subtasks?.length ? (
                          <ul className="mt-1 space-y-1">
                            {t.subtasks.map(st => (
                              <li key={st.id} className="flex items-center gap-2 text-xs">
                                <input type="checkbox" checked={!!st.completed} disabled className="accent-emerald-600"/>
                                <span className={st.completed ? 'line-through text-neutral-400' : ''}>{st.title}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {t.bounty && (
                          <div className="mt-1">
                            <span className={`text-[0.6875rem] px-2 py-0.5 rounded-full border ${t.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : t.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : t.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-neutral-700/30 border-neutral-600'}`}>
                              Bounty {typeof t.bounty.amount==='number' ? `• ${t.bounty.amount} sats` : ''} • {t.bounty.state}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <IconButton label="Restore" onClick={() => restoreTask(t.id)} intent="success">↩︎</IconButton>
                        <IconButton label="Delete" onClick={() => deleteTask(t.id)} intent="danger">✕</IconButton>
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
        className={`fixed ${settings.inlineAdd ? 'top-36' : 'bottom-4'} right-4 px-3 py-2 rounded-full bg-neutral-800 border border-neutral-700 shadow-lg text-sm transition-transform ${upcomingHover ? 'scale-110' : ''}`}
        onClick={() => setShowUpcoming(true)}
        title="Upcoming (hidden) tasks"
        onDragOver={(e) => { e.preventDefault(); setUpcomingHover(true); }}
        onDragLeave={() => setUpcomingHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData("text/task-id");
          if (id) postponeTaskOneWeek(id);
          handleDragEnd();
        }}
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
                <li key={t.id} className="task px-3 rounded-xl bg-neutral-900 border border-neutral-800">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <div className="text-sm font-medium leading-[1.15]">{renderTitleWithLink(t.title, t.note)}</div>
                      <div className="text-xs text-neutral-400">
                        {currentBoard?.kind === "week"
                          ? `Scheduled ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}`
                          : "Hidden item"}
                        {t.hiddenUntilISO ? ` • Reveals ${new Date(t.hiddenUntilISO).toLocaleDateString()}` : ""}
                      </div>
                      <TaskMedia task={t} />
                      {t.subtasks?.length ? (
                        <ul className="mt-1 space-y-1">
                          {t.subtasks.map(st => (
                            <li key={st.id} className="flex items-center gap-2 text-xs">
                              <input type="checkbox" checked={!!st.completed} disabled className="accent-emerald-600"/>
                              <span className={st.completed ? 'line-through text-neutral-400' : ''}>{st.title}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
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

      {/* Drag trash can */}
      {draggingTaskId && (
        <div
          className="fixed bottom-4 left-4 z-50"
          onDragOver={(e) => {
            e.preventDefault();
            setTrashHover(true);
          }}
          onDragLeave={() => setTrashHover(false)}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData("text/task-id");
            if (id) deleteTask(id);
            handleDragEnd();
          }}
        >
          <div
            className={`w-14 h-14 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-neutral-400 transition-transform ${trashHover ? 'scale-110' : ''}`}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="pointer-events-none"
            >
              <path d="M9 3h6l1 1h5v2H3V4h5l1-1z" />
              <path d="M5 7h14l-1.5 13h-11L5 7z" />
            </svg>
          </div>
        </div>
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
          weekStart={settings.weekStart}
          onRedeemCoins={(rect)=>flyCoinsToWallet(rect)}
        />
      )}

      {/* Add bar Advanced recurrence modal */}
      {showAddAdvanced && (
        <RecurrenceModal
          initial={addCustomRule}
          initialSchedule={scheduleDate}
          onClose={() => setShowAddAdvanced(false)}
          onApply={(r, sched) => {
            setAddCustomRule(r);
            setScheduleDate(sched || "");
            if (sched && currentBoard?.kind === "week" && dayChoice !== "bounties") {
              setDayChoice(new Date(sched).getDay() as Weekday);
            }
            setShowAddAdvanced(false);
          }}
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
              const nostrId = b.nostr?.boardId || (/^[0-9a-f-]{8}-[0-9a-f-]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.id) ? b.id : crypto.randomUUID());
              const nb: Board = b.kind === "week" ? { ...b, nostr: { boardId: nostrId, relays } } : { ...b, nostr: { boardId: nostrId, relays } };
              setTimeout(() => {
                publishBoardMetadata(nb).catch(() => {});
                tasks.filter(t => t.boardId === nb.id).forEach(t => {
                  maybePublishTask(t, nb).catch(() => {});
                });
              }, 0);
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
          onRegenerateBoardId={regenerateBoardId}
          onBoardChanged={(boardId) => {
            const b = boards.find(x => x.id === boardId);
            if (b) publishBoardMetadata(b).catch(() => {});
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Cashu Wallet */}
      {showWallet && (
        <CashuWalletModal open={showWallet} onClose={() => setShowWallet(false)} />
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
        let image =
          doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
          doc.querySelector('meta[property="og:image:url"]')?.getAttribute("content") ||
          undefined;
        if (image) {
          try { image = new URL(image, url).href; } catch {}
        } else {
          const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
          if (yt) image = `https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg`;
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
      className="block w-full border border-neutral-700 rounded-lg overflow-hidden mt-1"
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
  const noteText = task.note?.replace(/https?:\/\/[^\s)]+/gi, "").trim();
  return (
    <>
      {noteText && (
        <div
          className="text-xs text-neutral-400 mt-0.5 break-words"
          style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {autolink(noteText)}
        </div>
      )}
      {task.images?.length ? (
        <div className="mt-1.5 space-y-2">
          {task.images.map((img, i) => (
            <img key={i} src={img} className="max-h-40 w-full object-contain rounded-lg" />
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
  onDropEnd,
  onTitleClick,
  children,
  footer,
  scrollable,
  ...props
}: {
  title: string;
  onDropCard: (payload: { id: string }) => void;
  onDropEnd?: () => void;
  onTitleClick?: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  scrollable?: boolean;
} & React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current!;
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer?.getData("text/task-id");
      if (id) onDropCard({ id });
      if (onDropEnd) onDropEnd();
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
    };
  }, [onDropCard, onDropEnd]);

  return (
    <div
      ref={ref}
      className={`rounded-2xl bg-neutral-900/60 border border-neutral-800 p-3 w-[288px] shrink-0 ${scrollable ? 'h-[calc(100vh-12rem)] flex flex-col' : 'min-h-[288px]'}`}
      // No touchAction lock so horizontal scrolling stays fluid
      {...props}
    >
      <div
        className={`font-semibold mb-2 ${onTitleClick ? 'cursor-pointer hover:underline' : ''}`}
        onClick={onTitleClick}
        role={onTitleClick ? 'button' : undefined}
        tabIndex={onTitleClick ? 0 : undefined}
        onKeyDown={(e) => {
          if (!onTitleClick) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onTitleClick();
          }
        }}
        title={onTitleClick ? 'Set as add target' : undefined}
      >
        {title}
      </div>
      <div className={`space-y-2 ${scrollable ? 'flex-1 overflow-y-auto pr-1' : ''}`}>{children}</div>
      {footer}
    </div>
  );
}

function Card({
  task,
  onComplete,
  onEdit,
  onDropBefore,
  showStreaks,
  onToggleSubtask,
  onFlyToCompleted,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  onComplete: (from?: DOMRect) => void;
  onEdit: () => void;
  onDropBefore: (dragId: string) => void;
  showStreaks: boolean;
  onToggleSubtask: (subId: string) => void;
  onFlyToCompleted: (rect: DOMRect) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [overBefore, setOverBefore] = useState(false);

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setDragImage(e.currentTarget as HTMLElement, 0, 0);
    onDragStart(task.id);
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
    onDragEnd();
  }
  function handleDragLeave() { setOverBefore(false); }
  function handleDragEnd() { onDragEnd(); }

  return (
    <div
      ref={cardRef}
      className="task group relative px-2 rounded-xl bg-neutral-800 border border-neutral-700 select-none"
      // Allow horizontal swiping across columns on mobile
      style={{ touchAction: "auto" }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {/* insert-before indicator */}
      {overBefore && (
        <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] bg-emerald-500 rounded-full" />
      )}

      <div className="flex items-center gap-2">
        {task.completed ? (
          <button
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
              onComplete(rect);
            }}
            aria-label="Mark incomplete"
            title="Mark incomplete"
            className="flex items-center justify-center w-8 h-8 rounded-full text-emerald-500"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" className="pointer-events-none">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M8 12l2.5 2.5L16 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <button
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
              try { onFlyToCompleted(rect); } catch {}
              onComplete(rect);
            }}
            aria-label="Complete task"
            title="Mark complete"
            className="flex items-center justify-center w-8 h-8 rounded-full text-neutral-300 hover:text-emerald-500 transition"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" className="pointer-events-none">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        )}

        {/* Title (hyperlinked if note contains a URL) */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onEdit}>
          <div className={`text-sm font-medium leading-[1.15] break-words ${task.completed ? 'line-through text-neutral-400' : ''}`}>
            {renderTitleWithLink(task.title, task.note)}
          </div>
          {showStreaks &&
            task.recurrence &&
            (task.recurrence.type === "daily" || task.recurrence.type === "weekly") &&
            typeof task.streak === "number" && task.streak > 0 && (
              <div className="text-xs text-amber-400 mt-0.5 flex items-center gap-1">
                <span>🔥</span>
                <span>{task.streak}</span>
              </div>
            )}
        </div>

      </div>

      <TaskMedia task={task} />
      {task.subtasks?.length ? (
        <ul className="mt-1 space-y-1">
          {task.subtasks.map((st) => (
            <li key={st.id} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={!!st.completed}
                onChange={() => onToggleSubtask(st.id)}
                className="accent-emerald-600"
              />
              <span className={st.completed ? "line-through text-neutral-400" : ""}>{st.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {task.completed && task.bounty && task.bounty.state !== 'claimed' && (
        <div className="mt-1 text-xs text-emerald-400">
          {task.bounty.state === 'unlocked' ? 'Bounty unlocked!' : 'Complete! - Unlock bounty'}
        </div>
      )}
      {/* Bounty badge */}
      {task.bounty && (
        <div className="mt-1">
          <span className={`text-[0.6875rem] px-2 py-0.5 rounded-full border ${task.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : task.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : task.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-neutral-700/30 border-neutral-600'}`}>
            Bounty {typeof task.bounty.amount==='number' ? `• ${task.bounty.amount} sats` : ''} • {task.bounty.state}
          </span>
        </div>
      )}
    </div>
  );
}

/* Small circular icon button */
function IconButton({
  children, onClick, label, intent, buttonRef
}: React.PropsWithChildren<{ onClick: ()=>void; label: string; intent?: "danger"|"success"; buttonRef?: React.Ref<HTMLButtonElement> }>) {
  const base = "w-9 h-9 rounded-full inline-flex items-center justify-center text-sm border border-transparent bg-neutral-700/40 hover:bg-neutral-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500";
  const danger = " border-rose-700";
  const success = " bg-emerald-700/30 hover:bg-emerald-700/50";
  const cls = base + (intent==="danger" ? danger : intent==="success" ? success : "");
  return <button ref={buttonRef} aria-label={label} title={label} className={cls} onClick={onClick}>{children}</button>;
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
function EditModal({ task, onCancel, onDelete, onSave, weekStart, onRedeemCoins }: { 
  task: Task; onCancel: ()=>void; onDelete: ()=>void; onSave: (t: Task)=>void; weekStart: Weekday; onRedeemCoins?: (from: DOMRect)=>void;
}) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note || "");
  const [images, setImages] = useState<string[]>(task.images || []);
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks || []);
  const [newSubtask, setNewSubtask] = useState("");
  const newSubtaskRef = useRef<HTMLInputElement>(null);
  const [rule, setRule] = useState<Recurrence>(task.recurrence ?? R_NONE);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(task.dueISO.slice(0,10));
  const [bountyAmount, setBountyAmount] = useState<number | "">(task.bounty?.amount ?? "");
  const [, setBountyState] = useState<Task["bounty"]["state"]>(task.bounty?.state || "locked");
  const [encryptWhenAttach, setEncryptWhenAttach] = useState(true);
  const { createSendToken, receiveToken, mintUrl } = useCashu();
  const [lockToRecipient, setLockToRecipient] = useState(false);
  const [recipientInput, setRecipientInput] = useState("");

  function normalizePubkey(input: string): string | null {
    const s = (input || "").trim();
    if (!s) return null;
    if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
    try {
      const dec = nip19.decode(s);
      if (dec.type === 'npub') {
        if (typeof dec.data === 'string') return dec.data;
        // Fallback if data is bytes-like
        if (dec.data && (dec.data as any).length) {
          const arr = dec.data as unknown as ArrayLike<number>;
          return Array.from(arr).map((x)=>x.toString(16).padStart(2,'0')).join('');
        }
      }
    } catch {}
    return null;
  }

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

  function addSubtask(keepKeyboard = false) {
    const title = newSubtask.trim();
    if (!title) return;
    setSubtasks(prev => [...prev, { id: crypto.randomUUID(), title, completed: false }]);
    setNewSubtask("");
    if (keepKeyboard) newSubtaskRef.current?.focus();
    else newSubtaskRef.current?.blur();
  }

  function buildTask(overrides: Partial<Task> = {}): Task {
    const dueISO = new Date(scheduledDate + "T00:00").toISOString();
    const due = startOfDay(new Date(dueISO));
    const nowSow = startOfWeek(new Date(), weekStart);
    const dueSow = startOfWeek(due, weekStart);
    const hiddenUntilISO = dueSow.getTime() > nowSow.getTime() ? dueSow.toISOString() : undefined;
    return {
      ...task,
      title,
      note: note || undefined,
      images: images.length ? images : undefined,
      subtasks: subtasks.length ? subtasks : undefined,
      recurrence: rule.type === "none" ? undefined : rule,
      dueISO,
      hiddenUntilISO,
      ...overrides,
    };
  }

  function save(overrides: Partial<Task> = {}) {
    onSave(buildTask(overrides));
  }

  async function copyCurrent() {
    const base = buildTask();
    try { await navigator.clipboard?.writeText(JSON.stringify(base)); } catch {}
  }

  return (
    <Modal
      onClose={onCancel}
      title="Edit task"
      actions={
        <button
          className="pressable px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500"
          onClick={() => save()}
        >
          Save
        </button>
      }
    >
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

        <div>
          <div className="flex items-center mb-2">
            <label className="text-sm font-medium">Subtasks</label>
          </div>
          {subtasks.map((st) => (
            <div key={st.id} className="flex items-center gap-2 mb-1">
              <input
                type="checkbox"
                checked={!!st.completed}
                onChange={() => setSubtasks(prev => prev.map(s => s.id === st.id ? { ...s, completed: !s.completed } : s))}
                className="accent-emerald-600"
              />
              <input
                className="flex-1 px-2 py-1 rounded-xl bg-neutral-900 border border-neutral-800 text-sm"
                value={st.title}
                onChange={(e) => setSubtasks(prev => prev.map(s => s.id === st.id ? { ...s, title: e.target.value } : s))}
                placeholder="Subtask"
              />
              <button
                type="button"
                className="text-sm text-rose-500"
                onClick={() => setSubtasks(prev => prev.filter(s => s.id !== st.id))}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2 mt-2">
            <input
              ref={newSubtaskRef}
              value={newSubtask}
              onChange={e=>setNewSubtask(e.target.value)}
              onKeyDown={e=>{ if (e.key === "Enter") { e.preventDefault(); addSubtask(true); } }}
              placeholder="New subtask…"
              className="flex-1 px-2 py-1 rounded-xl bg-neutral-900 border border-neutral-800 text-sm"
            />
            <button
              type="button"
              className="text-sm px-2 py-1 rounded bg-neutral-800"
              onClick={() => addSubtask()}
            >
              Add
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="edit-schedule" className="block mb-1 text-sm font-medium">Scheduled for</label>
          <input
            id="edit-schedule"
            type="date"
            value={scheduledDate}
            onChange={e=>setScheduledDate(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
            title="Scheduled date"
          />
        </div>

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
              <div className="ml-auto flex items-center gap-2 text-[0.6875rem]">
                <span className={`px-2 py-0.5 rounded-full border ${task.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : task.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : task.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-neutral-700/30 border-neutral-600'}`}>{task.bounty.state}</span>
                {task.createdBy && (window as any).nostrPK === task.createdBy && <span className="px-2 py-0.5 rounded-full bg-neutral-800 border border-neutral-700" title="You created the task">owner: you</span>}
                {task.bounty.sender && (window as any).nostrPK === task.bounty.sender && <span className="px-2 py-0.5 rounded-full bg-neutral-800 border border-neutral-700" title="You funded the bounty">funder: you</span>}
                {task.bounty.receiver && (window as any).nostrPK === task.bounty.receiver && <span className="px-2 py-0.5 rounded-full bg-neutral-800 border border-neutral-700" title="You are the recipient">recipient: you</span>}
              </div>
            )}
          </div>
          {!task.bounty ? (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-2">
                <input type="number" min={1} value={bountyAmount as number || ""}
                       onChange={(e)=>setBountyAmount(e.target.value ? parseInt(e.target.value,10) : "")}
                       placeholder="Amount (sats)"
                       className="w-40 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"/>
                <button className="pressable px-3 py-2 rounded-xl bg-neutral-800"
                        onClick={async () => {
                          if (typeof bountyAmount !== 'number' || bountyAmount <= 0) return;
                          try {
                            const { token: tok } = await createSendToken(bountyAmount);
                            const b: Task["bounty"] = {
                              id: crypto.randomUUID(),
                              token: tok,
                              amount: bountyAmount,
                              mint: mintUrl,
                              state: "locked",
                              owner: task.createdBy || (window as any).nostrPK || "",
                              sender: (window as any).nostrPK || "",
                              updatedAt: new Date().toISOString(),
                              lock: tok.includes("pubkey") ? "p2pk" : tok.includes("hash") ? "htlc" : "unknown",
                            };
                            if (lockToRecipient) {
                              // Lock to recipient's nostr pubkey via NIP-04
                              const rxHex = normalizePubkey(recipientInput) || task.createdBy || "";
                              if (!rxHex || !/^[0-9a-fA-F]{64}$/.test(rxHex)) {
                                alert("Enter a valid recipient npub/hex or ensure the task has an owner.");
                                return;
                              }
                              try {
                                const enc = await encryptEcashTokenForRecipient(rxHex, tok);
                                b.enc = enc;
                                b.receiver = rxHex;
                                b.token = "";
                              } catch (e) {
                                alert("Recipient encryption failed: " + (e as Error).message);
                                return;
                              }
                            } else if (encryptWhenAttach) {
                              try {
                                const enc = await encryptEcashTokenForFunder(tok);
                                b.enc = enc;
                                b.token = "";
                              } catch (e) {
                                alert("Encryption failed: "+ (e as Error).message);
                                return;
                              }
                            }
                            try {
                              const raw = localStorage.getItem("cashuHistory");
                              const existing = raw ? JSON.parse(raw) : [];
                              const historyItem = {
                                id: `bounty-${Date.now()}`,
                                summary: `Attached bounty • ${bountyAmount} sats`,
                                detail: tok,
                              };
                              localStorage.setItem("cashuHistory", JSON.stringify([historyItem, ...existing]));
                            } catch {}
                            save({ bounty: b });
                          } catch (e) {
                            alert("Failed to create token: "+ (e as Error).message);
                          }
                        }}
                >Attach</button>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-xs text-neutral-300">
                  <input
                    type="checkbox"
                    checked={encryptWhenAttach && !lockToRecipient}
                    onChange={(e)=> setEncryptWhenAttach(e.target.checked)}
                    disabled={lockToRecipient}
                  />
                  Hide/encrypt token until I reveal (uses your local key)
                </label>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-neutral-300">
                    <input
                      type="checkbox"
                      checked={lockToRecipient}
                      onChange={(e)=>{ setLockToRecipient(e.target.checked); if (e.target.checked) setEncryptWhenAttach(false); }}
                    />
                    Lock to recipient (Nostr npub/hex)
                  </label>
                  {task.createdBy && (
                    <button
                      className="px-2 py-1 rounded-lg bg-neutral-800 text-xs"
                      onClick={()=>{ setRecipientInput(task.createdBy!); setLockToRecipient(true); setEncryptWhenAttach(false);} }
                      title="Use task owner"
                    >Use owner</button>
                  )}
                </div>
                <input
                  type="text"
                  placeholder="npub1... or 64-hex pubkey"
                  value={recipientInput}
                  onChange={(e)=> setRecipientInput(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 text-xs"
                  disabled={!lockToRecipient}
                />
              </div>
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
                  {((task.bounty.enc as any).alg === 'aes-gcm-256')
                    ? 'Hidden (encrypted by funder). Only the funder can reveal.'
                    : 'Locked to recipient\'s Nostr key (nip04). Only the recipient can decrypt.'}
                </div>
              ) : (
                <textarea readOnly value={task.bounty.token || ""}
                          className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800" rows={3}/>
              )}
              <div className="flex gap-2 flex-wrap">
                {task.bounty.token && (
                  task.bounty.state === 'unlocked' ? (
                    <button
                      className="pressable px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
                      onClick={async (e) => {
                        const fromRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        try {
                          const res = await receiveToken(task.bounty!.token!);
                          if (res.crossMint) {
                            alert(`Redeemed to a different mint: ${res.usedMintUrl}. Switch to that mint to view the balance.`);
                          }
                          try {
                            const amt = res.proofs.reduce((a, p) => a + (p?.amount || 0), 0);
                            const raw = localStorage.getItem("cashuHistory");
                            const existing = raw ? JSON.parse(raw) : [];
                            const historyItem = {
                              id: `redeem-bounty-${Date.now()}`,
                              summary: `Redeemed bounty • ${amt} sats${res.crossMint ? ` at ${res.usedMintUrl}` : ''}`,
                            };
                            localStorage.setItem("cashuHistory", JSON.stringify([historyItem, ...existing]));
                          } catch {}
                          // Coins fly from the button to the selector target
                          try { onRedeemCoins?.(fromRect); } catch {}
                          setBountyState('claimed');
                          save({ bounty: { ...task.bounty!, token: '', state: 'claimed', updatedAt: new Date().toISOString() } });
                        } catch (e) {
                          alert('Redeem failed: ' + (e as Error).message);
                        }
                      }}
                    >
                      Redeem
                    </button>
                  ) : (
                    <button
                      className="pressable px-3 py-2 rounded-xl bg-neutral-800"
                      onClick={async () => { try { await navigator.clipboard?.writeText(task.bounty!.token!); } catch {} }}
                    >
                      Copy token
                    </button>
                  )
                )}
                {task.bounty.enc && !task.bounty.token && (window as any).nostrPK && (
                  ((task.bounty.enc as any).alg === 'aes-gcm-256' && task.bounty.sender === (window as any).nostrPK) ||
                  ((task.bounty.enc as any).alg === 'nip04' && task.bounty.receiver === (window as any).nostrPK)
                ) && (
                  <button className="pressable px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
                          onClick={async () => {
                            try {
                              await revealBounty(task.id);
                            } catch {}
                          }}>Reveal (decrypt)</button>
                )}
                <button
                  className={`px-3 py-2 rounded-xl ${task.bounty.token ? 'bg-neutral-800' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'}`}
                  disabled={!task.bounty.token}
                  onClick={() => {
                    if (!task.bounty.token) return;
                    setBountyState('claimed');
                    save({ bounty: { ...task.bounty!, state: 'claimed', updatedAt: new Date().toISOString() } });
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
                              save({ bounty: { ...task.bounty!, token: newTok, state: 'unlocked', updatedAt: new Date().toISOString() } });
                            }}>Unlock…</button>
                    <button
                      className={`px-3 py-2 rounded-xl ${((window as any).nostrPK && (task.bounty!.sender === (window as any).nostrPK || task.createdBy === (window as any).nostrPK)) ? 'bg-rose-600/80 hover:bg-rose-600' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'}`}
                      disabled={!((window as any).nostrPK && (task.bounty!.sender === (window as any).nostrPK || task.createdBy === (window as any).nostrPK))}
                      onClick={() => {
                        if (!((window as any).nostrPK && (task.bounty!.sender === (window as any).nostrPK || task.createdBy === (window as any).nostrPK))) return;
                        save({ bounty: { ...task.bounty!, state: 'revoked', updatedAt: new Date().toISOString() } });
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
                    save({ bounty: undefined });
                  }}
                >
                  Remove bounty
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Creator info */}
        <div className="pt-2">
          {(() => {
            const raw = task.createdBy || "";
            let display = raw;
            try {
              if (raw.startsWith("npub")) {
                const dec = nip19.decode(raw);
                if (typeof dec.data === 'string') display = dec.data;
                else if (dec.data && (dec.data as any).length) {
                  const arr = dec.data as unknown as ArrayLike<number>;
                  display = Array.from(arr).map((x)=>x.toString(16).padStart(2,'0')).join('');
                }
              }
            } catch {}
            const short = display
              ? display.length > 16
                ? display.slice(0, 10) + "…" + display.slice(-6)
                : display
              : "(not set)";
            const canCopy = !!display;
            return (
              <div className="flex items-center justify-between text-[0.6875rem] text-neutral-400">
                <div>
                  Created by: <span className="font-mono text-neutral-300">{short}</span>
                </div>
                <button
                  className={`px-2 py-1 rounded-lg bg-neutral-800 ${canCopy ? '' : 'opacity-50 cursor-not-allowed'} text-xs`}
                  title={canCopy ? 'Copy creator key (hex)' : 'No key to copy'}
                  onClick={async () => { if (canCopy) { try { await navigator.clipboard?.writeText(display); } catch {} } }}
                  disabled={!canCopy}
                >
                  Copy
                </button>
              </div>
            );
          })()}
        </div>

        {/* Completed by info (only when completed) */}
        {task.completed && (
          <div className="pt-1">
            {(() => {
              const raw = task.completedBy || "";
              let display = raw;
              try {
                if (raw.startsWith("npub")) {
                  const dec = nip19.decode(raw);
                  if (typeof dec.data === 'string') display = dec.data;
                  else if (dec.data && (dec.data as any).length) {
                    const arr = dec.data as unknown as ArrayLike<number>;
                    display = Array.from(arr).map((x)=>x.toString(16).padStart(2,'0')).join('');
                  }
                }
              } catch {}
              const short = display
                ? display.length > 16
                  ? display.slice(0, 10) + "…" + display.slice(-6)
                  : display
                : "(not set)";
              const canCopy = !!display;
              return (
                <div className="flex items-center justify-between text-[0.6875rem] text-neutral-400">
                  <div>
                    Completed by: <span className="font-mono text-neutral-300">{short}</span>
                  </div>
                  <button
                    className={`px-2 py-1 rounded-lg bg-neutral-800 ${canCopy ? '' : 'opacity-50 cursor-not-allowed'} text-xs`}
                    title={canCopy ? 'Copy completer key (hex)' : 'No key to copy'}
                    onClick={async () => { if (canCopy) { try { await navigator.clipboard?.writeText(display); } catch {} } }}
                    disabled={!canCopy}
                  >
                    Copy
                  </button>
                </div>
              );
            })()}
          </div>
        )}

        <div className="pt-2 flex justify-between">
          <button className="pressable px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600" onClick={onDelete}>Delete</button>
          <div className="flex gap-2">
            <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={copyCurrent}>Copy</button>
            <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={onCancel}>Cancel</button>
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
  initial,
  onClose,
  onApply,
  initialSchedule,
}: {
  initial: Recurrence;
  onClose: () => void;
  onApply: (r: Recurrence, scheduleISO?: string) => void;
  initialSchedule?: string;
}) {
  const [value, setValue] = useState<Recurrence>(initial);
  const [schedule, setSchedule] = useState(initialSchedule ?? "");

  return (
    <Modal
      onClose={onClose}
      title="Advanced recurrence"
      showClose={false}
      actions={
        <>
          <button
            className="pressable px-3 py-1 rounded bg-neutral-800"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="pressable px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500"
            onClick={() =>
              onApply(
                value,
                initialSchedule !== undefined ? schedule : undefined
              )
            }
          >
            Apply
          </button>
        </>
      }
    >
      {initialSchedule !== undefined && (
        <div className="mb-4">
          <label htmlFor="advanced-schedule" className="block mb-1 text-sm font-medium">Scheduled for</label>
          <input
            id="advanced-schedule"
            type="date"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
            title="Scheduled date"
          />
        </div>
      )}
      <RecurrencePicker value={value} onChange={setValue} />
    </Modal>
  );
}

function RecurrencePicker({ value, onChange }: { value: Recurrence; onChange: (r: Recurrence)=>void }) {
  const [weekly, setWeekly] = useState<Set<Weekday>>(new Set());
  const [everyN, setEveryN] = useState(2);
  const [unit, setUnit] = useState<"day"|"week">("day");
  const [monthDay, setMonthDay] = useState(15);
  const [end, setEnd] = useState(value.untilISO ? value.untilISO.slice(0,10) : "");

  useEffect(()=>{
    switch (value.type) {
      case "weekly": setWeekly(new Set(value.days)); break;
      case "every": setEveryN(value.n); setUnit(value.unit); break;
      case "monthlyDay": setMonthDay(value.day); break;
      default: setWeekly(new Set());
    }
    setEnd(value.untilISO ? value.untilISO.slice(0,10) : "");
  }, [value]);

  const withEnd = (r: Recurrence): Recurrence => ({ ...r, untilISO: end ? new Date(end).toISOString() : undefined });
  function setNone() { onChange(withEnd({ type: "none" })); }
  function setDaily() { onChange(withEnd({ type: "daily" })); }
    function toggleDay(d: Weekday) {
      const next = new Set(weekly);
      if (next.has(d)) {
        next.delete(d);
      } else {
        next.add(d);
      }
      setWeekly(next);
      const sorted = Array.from(next).sort((a,b)=>a-b);
      onChange(withEnd(sorted.length ? { type: "weekly", days: sorted } : { type: "none" }));
    }
  function applyEvery() { onChange(withEnd({ type:"every", n: Math.max(1, everyN || 1), unit })); }
  function applyMonthly() { onChange(withEnd({ type:"monthlyDay", day: Math.min(28, Math.max(1, monthDay)) })); }

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

      <section>
        <div className="text-sm font-medium mb-2">End date</div>
        <input
          type="date"
          value={end}
          onChange={e=>{ const v = e.target.value; setEnd(v); onChange({ ...value, untilISO: v ? new Date(v).toISOString() : undefined }); }}
          className="px-2 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
        />
      </section>
    </div>
  );
}

/* Generic modal */
function Modal({ children, onClose, title, actions, showClose = true }: React.PropsWithChildren<{ onClose: ()=>void; title?: React.ReactNode; actions?: React.ReactNode; showClose?: boolean }>) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[min(45rem,92vw)] max-h-[80vh] overflow-y-auto overflow-x-hidden bg-neutral-900 border border-neutral-700 rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-lg font-semibold">{title}</div>
          <div className="ml-auto flex items-center gap-2">
            {actions}
            {showClose && (
              <button className="pressable px-3 py-1 rounded bg-neutral-800" onClick={onClose}>
                Close
              </button>
            )}
          </div>
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
      <div className="absolute right-0 top-0 bottom-0 w-[min(23.75rem,92vw)] bg-neutral-900 border-l border-neutral-800 p-4 shadow-2xl">
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
  onRegenerateBoardId,
  onBoardChanged,
  onClose,
}: {
  settings: Settings;
  boards: Board[];
  currentBoardId: string;
  setSettings: (s: Partial<Settings>) => void;
  setBoards: React.Dispatch<React.SetStateAction<Board[]>>;
  setCurrentBoardId: (id: string) => void;
  defaultRelays: string[];
  setDefaultRelays: (rls: string[]) => void;
  pubkeyHex: string;
  onGenerateKey: () => void;
  onSetKey: (hex: string) => void;
  onShareBoard: (boardId: string, relaysCsv?: string) => void;
  onJoinBoard: (nostrId: string, name?: string, relaysCsv?: string) => void;
  onRegenerateBoardId: (boardId: string) => void;
  onBoardChanged: (boardId: string) => void;
  onClose: () => void;
}) {
  const [newBoardName, setNewBoardName] = useState("");
  const [manageBoardId, setManageBoardId] = useState<string | null>(null);
  const manageBoard = boards.find(b => b.id === manageBoardId);
  const [relaysCsv, setRelaysCsv] = useState("");
  const [customSk, setCustomSk] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [newDefaultRelay, setNewDefaultRelay] = useState("");
  const [newBoardRelay, setNewBoardRelay] = useState("");
  const [newOverrideRelay, setNewOverrideRelay] = useState("");
  // Mint selector moved to Wallet modal; no need to read here.
  const { show: showToast } = useToast();
  const { mintUrl, payInvoice } = useCashu();
  const [donateAmt, setDonateAmt] = useState("");
  const [donateComment, setDonateComment] = useState("");
  const [donateState, setDonateState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [donateMsg, setDonateMsg] = useState("");

  function parseCsv(csv: string): string[] {
    return csv.split(",").map(s => s.trim()).filter(Boolean);
  }

  function addRelayToCsv(csv: string, relay: string): string {
    const list = parseCsv(csv);
    const val = relay.trim();
    if (!val) return csv;
    if (list.includes(val)) return csv;
    return [...list, val].join(",");
  }

  function removeRelayFromCsv(csv: string, relay: string): string {
    const list = parseCsv(csv);
    return list.filter(r => r !== relay).join(",");
  }

  function backupData() {
    const data = {
      tasks: JSON.parse(localStorage.getItem(LS_TASKS) || "[]"),
      boards: JSON.parse(localStorage.getItem(LS_BOARDS) || "[]"),
      settings: JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}"),
      defaultRelays: JSON.parse(localStorage.getItem(LS_NOSTR_RELAYS) || "[]"),
      nostrSk: localStorage.getItem(LS_NOSTR_SK) || "",
      cashu: {
        proofs: loadProofStore(),
        activeMint: getActiveMint(),
      },
    };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "taskify-backup.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function restoreFromBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const data = JSON.parse(txt);
        if (data.tasks) localStorage.setItem(LS_TASKS, JSON.stringify(data.tasks));
        if (data.boards) localStorage.setItem(LS_BOARDS, JSON.stringify(data.boards));
        if (data.settings) localStorage.setItem(LS_SETTINGS, JSON.stringify(data.settings));
        if (data.defaultRelays) localStorage.setItem(LS_NOSTR_RELAYS, JSON.stringify(data.defaultRelays));
        if (data.nostrSk) localStorage.setItem(LS_NOSTR_SK, data.nostrSk);
        if (data.cashu?.proofs) saveProofStore(data.cashu.proofs);
        if (data.cashu) setActiveMint(data.cashu.activeMint || null);
        alert("Backup restored. Press close to reload.");
        setReloadNeeded(true);
      } catch {
        alert("Invalid backup file");
      }
    });
    e.target.value = "";
  }

  async function handleDonate() {
    setDonateState("sending");
    setDonateMsg("");
    try {
      const amtSat = Math.max(0, Math.floor(Number(donateAmt) || 0));
      if (!amtSat) throw new Error("Enter amount in sats");
      if (!mintUrl) throw new Error("Set a Cashu mint in Wallet first");

      const lnAddress = "dev@solife.me";
      const [name, domain] = lnAddress.split("@");
      const infoRes = await fetch(`https://${domain}/.well-known/lnurlp/${name}`);
      if (!infoRes.ok) throw new Error("Unable to fetch LNURL pay info");
      const info = await infoRes.json();

      const minSat = Math.ceil((info?.minSendable || 0) / 1000);
      const maxSat = Math.floor((info?.maxSendable || Infinity) / 1000);
      if (amtSat < minSat) throw new Error(`Minimum is ${minSat} sats`);
      if (amtSat > maxSat) throw new Error(`Maximum is ${maxSat} sats`);

      const commentAllowed: number = Number(info?.commentAllowed || 0) || 0;
      const comment = (donateComment || "").trim();
      if (comment && commentAllowed > 0 && comment.length > commentAllowed) {
        throw new Error(`Comment too long (max ${commentAllowed} chars)`);
      }

      const params = new URLSearchParams({ amount: String(amtSat * 1000) });
      if (comment) params.set("comment", comment);
      const invRes = await fetch(`${info.callback}?${params.toString()}`);
      if (!invRes.ok) throw new Error("Failed to get invoice");
      const inv = await invRes.json();
      if (inv?.status === "ERROR") throw new Error(inv?.reason || "Invoice error");

      await payInvoice(inv.pr);

      try {
        const saved = localStorage.getItem("cashuHistory");
        const list = saved ? JSON.parse(saved) : [];
        const entry = {
          id: `donate-${Date.now()}`,
          summary: `Donated ${amtSat} sats to ${lnAddress}`,
          detail: comment ? `comment: ${comment}` : undefined,
        };
        localStorage.setItem("cashuHistory", JSON.stringify([entry, ...list]));
      } catch {}

      setDonateState("done");
      setDonateMsg("Thank you for your support! - The Solife team");
      setDonateAmt("");
      setDonateComment("");
    } catch (e: any) {
      setDonateState("error");
      setDonateMsg(e?.message || String(e));
    }
  }

  function addBoard() {
    const name = newBoardName.trim();
    if (!name) return;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(name)) {
      onJoinBoard(name);
      setNewBoardName("");
      return;
    }
    const id = crypto.randomUUID();
    const board: Board = { id, name, kind: "lists", columns: [{ id: crypto.randomUUID(), name: "List 1" }] };
    setBoards(prev => [...prev, board]);
    setNewBoardName("");
    setCurrentBoardId(id);
  }

  function renameBoard(id: string, name: string) {
    setBoards(prev => prev.map(x => x.id === id ? { ...x, name } : x));
    const sb = boards.find(x => x.id === id);
    if (sb?.nostr) setTimeout(() => onBoardChanged(id), 0);
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
      }
      return next;
    });
    setTasks(prev => prev.filter(t => t.boardId !== id));
    if (manageBoardId === id) setManageBoardId(null);
  }

  function reorderBoards(dragId: string, targetId: string, before: boolean) {
    setBoards(prev => {
      const list = [...prev];
      const fromIndex = list.findIndex(b => b.id === dragId);
      if (fromIndex === -1) return prev;
      const [item] = list.splice(fromIndex, 1);
      let targetIndex = list.findIndex(b => b.id === targetId);
      if (targetIndex === -1) return prev;
      if (!before) targetIndex++;
      list.splice(targetIndex, 0, item);
      return list;
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

  function reorderColumn(boardId: string, dragId: string, targetId: string, before: boolean) {
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const cols = [...b.columns];
      const fromIndex = cols.findIndex(c => c.id === dragId);
      if (fromIndex === -1) return b;
      const [col] = cols.splice(fromIndex, 1);
      let targetIndex = cols.findIndex(c => c.id === targetId);
      if (targetIndex === -1) return b;
      if (!before) targetIndex++;
      cols.splice(targetIndex, 0, col);
      const nb = { ...b, columns: cols } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId); }, 0);
      return nb;
    }));
  }

  function BoardListItem({ board, onOpen, onDrop }: { board: Board; onOpen: ()=>void; onDrop: (dragId: string, before: boolean)=>void }) {
    const [overBefore, setOverBefore] = useState(false);
    function handleDragStart(e: React.DragEvent) {
      e.dataTransfer.setData("text/board-id", board.id);
      e.dataTransfer.effectAllowed = "move";
    }
    function handleDragOver(e: React.DragEvent) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLLIElement).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      setOverBefore(e.clientY < midpoint);
    }
    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      const dragId = e.dataTransfer.getData("text/board-id");
      if (dragId) onDrop(dragId, overBefore);
      setOverBefore(false);
    }
    function handleDragLeave() { setOverBefore(false); }
    return (
      <li
        className="relative p-2 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center"
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
      >
        {overBefore && (
          <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] bg-emerald-500 rounded-full" />
        )}
        <button className="flex-1 text-left" onClick={onOpen}>{board.name}</button>
      </li>
    );
  }

  function ColumnItem({ boardId, column }: { boardId: string; column: ListColumn }) {
    const [overBefore, setOverBefore] = useState(false);
    function handleDragStart(e: React.DragEvent) {
      e.dataTransfer.setData("text/column-id", column.id);
      e.dataTransfer.effectAllowed = "move";
    }
    function handleDragOver(e: React.DragEvent) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLLIElement).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      setOverBefore(e.clientY < midpoint);
    }
    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      const dragId = e.dataTransfer.getData("text/column-id");
      if (dragId) reorderColumn(boardId, dragId, column.id, overBefore);
      setOverBefore(false);
    }
    function handleDragLeave() { setOverBefore(false); }
    return (
      <li
        className="relative p-2 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center gap-2"
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
      >
        {overBefore && (
          <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] bg-emerald-500 rounded-full" />
        )}
        <div className="flex-1">{column.name}</div>
        <div className="flex gap-1">
          <button className="px-3 py-1 rounded-full bg-neutral-700 hover:bg-neutral-600" onClick={()=>renameColumn(boardId, column.id)}>Rename</button>
          <button className="pressable px-3 py-1 rounded-full bg-rose-600/80 hover:bg-rose-600" onClick={()=>deleteColumn(boardId, column.id)}>Delete</button>
        </div>
      </li>
    );
  }

  const handleClose = () => {
    onClose();
    if (reloadNeeded) window.location.reload();
  };

  return (
    <>
    <Modal onClose={handleClose} title="Settings">
      <div className="space-y-6">

        {/* Boards & Columns */}
        <section className="rounded-xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Boards & Lists</div>
          </div>
          <ul className="space-y-2 mb-3">
            {boards.map((b) => (
              <BoardListItem
                key={b.id}
                board={b}
                onOpen={() => setManageBoardId(b.id)}
                onDrop={(dragId, before) => reorderBoards(dragId, b.id, before)}
              />
            ))}
          </ul>
          <div className="flex gap-2">
            <input
              value={newBoardName}
              onChange={e=>setNewBoardName(e.target.value)}
              placeholder="Board name or ID"
              className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
            />
            <button
              className="pressable px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 shrink-0"
              onClick={addBoard}
            >
              Create/Join
            </button>
          </div>
        </section>

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

        {/* New task position */}
        <section>
          <div className="text-sm font-medium mb-2">Add new tasks to</div>
          <div className="flex gap-2">
            <button className={`px-3 py-2 rounded-xl ${settings.newTaskPosition === 'top' ? "bg-emerald-600" : "bg-neutral-800"}`} onClick={() => setSettings({ newTaskPosition: 'top' })}>Top</button>
            <button className={`px-3 py-2 rounded-xl ${settings.newTaskPosition === 'bottom' ? "bg-emerald-600" : "bg-neutral-800"}`} onClick={() => setSettings({ newTaskPosition: 'bottom' })}>Bottom</button>
          </div>
        </section>

        {/* Inline add boxes */}
        <section>
          <div className="text-sm font-medium mb-2">Add tasks within lists</div>
          <div className="flex gap-2">
            <button className={`px-3 py-2 rounded-xl ${settings.inlineAdd ? "bg-emerald-600" : "bg-neutral-800"}`} onClick={() => setSettings({ inlineAdd: true })}>Inline</button>
            <button className={`px-3 py-2 rounded-xl ${!settings.inlineAdd ? "bg-emerald-600" : "bg-neutral-800"}`} onClick={() => setSettings({ inlineAdd: false })}>Top bar</button>
          </div>
        </section>

        {/* Font size */}
        <section>
          <div className="text-sm font-medium mb-2">Font size</div>
          <div className="flex gap-2 flex-wrap">
            <button
              className={`px-3 py-2 rounded-xl ${settings.baseFontSize == null ? "bg-emerald-600" : "bg-neutral-800"}`}
              onClick={() => setSettings({ baseFontSize: null })}
            >System</button>
            <button
              className={`px-3 py-2 rounded-xl ${settings.baseFontSize === 14 ? "bg-emerald-600" : "bg-neutral-800"}`}
              onClick={() => setSettings({ baseFontSize: 14 })}
            >Small</button>
            <button
              className={`px-3 py-2 rounded-xl ${settings.baseFontSize === 16 ? "bg-emerald-600" : "bg-neutral-800"}`}
              onClick={() => setSettings({ baseFontSize: 16 })}
            >Default</button>
            <button
              className={`px-3 py-2 rounded-xl ${settings.baseFontSize === 18 ? "bg-emerald-600" : "bg-neutral-800"}`}
              onClick={() => setSettings({ baseFontSize: 18 })}
            >Large</button>
            <button
              className={`px-3 py-2 rounded-xl ${settings.baseFontSize === 20 ? "bg-emerald-600" : "bg-neutral-800"}`}
              onClick={() => setSettings({ baseFontSize: 20 })}
            >X-Large</button>
          </div>
          <div className="text-xs text-neutral-400 mt-2">Scales the entire UI. Defaults to the OS reading size.</div>
        </section>

        {/* Streaks */}
        <section>
          <div className="text-sm font-medium mb-2">Streaks</div>
          <div className="flex gap-2">
            <button
              className={`px-3 py-2 rounded-xl ${settings.streaksEnabled ? "bg-emerald-600" : "bg-neutral-800"}`}
              onClick={() => setSettings({ streaksEnabled: !settings.streaksEnabled })}
            >
              {settings.streaksEnabled ? "On" : "Off"}
            </button>
          </div>
          <div className="text-xs text-neutral-400 mt-2">Track consecutive completions on recurring tasks.</div>
        </section>

        {/* Full week recurring */}
        <section>
          <div className="text-sm font-medium mb-2">Show full week for recurring tasks</div>
          <div className="flex gap-2">
            <button
              className={`px-3 py-2 rounded-xl ${settings.showFullWeekRecurring ? "bg-emerald-600" : "bg-neutral-800"}`}
              onClick={() => setSettings({ showFullWeekRecurring: !settings.showFullWeekRecurring })}
            >
              {settings.showFullWeekRecurring ? "On" : "Off"}
            </button>
          </div>
          <div className="text-xs text-neutral-400 mt-2">Display all occurrences for the current week at once.</div>
        </section>

        {/* Completed tab */}
        <section>
          <div className="text-sm font-medium mb-2">Completed tab</div>
          <div className="flex gap-2">
            <button
              className={`px-3 py-2 rounded-xl ${settings.completedTab ? "bg-emerald-600" : "bg-neutral-800"}`}
              onClick={() => setSettings({ completedTab: !settings.completedTab })}
            >
              {settings.completedTab ? "On" : "Off"}
            </button>
          </div>
          <div className="text-xs text-neutral-400 mt-2">Hide the completed tab and show a Clear completed button instead.</div>
        </section>

        {/* Nostr */}
        <section className="rounded-xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Nostr</div>
            <div className="ml-auto" />
            <button
              className="px-3 py-1 rounded-lg bg-neutral-800 text-xs"
              onClick={()=>setShowAdvanced(a=>!a)}
            >{showAdvanced ? "Hide advanced" : "Advanced"}</button>
          </div>
          {/* Quick actions available outside Advanced */}
          <div className="mb-3 flex gap-2">
            <button
              className="px-3 py-2 rounded-xl bg-neutral-800"
              onClick={async ()=>{
                try {
                  const sk = localStorage.getItem(LS_NOSTR_SK) || "";
                  if (!sk) return;
                  let nsec = "";
                  try {
                    // Prefer nip19.nsecEncode when available
                    // @ts-expect-error - guard at runtime below
                    nsec = typeof (nip19 as any)?.nsecEncode === 'function' ? (nip19 as any).nsecEncode(sk) : sk;
                  } catch {
                    nsec = sk;
                  }
                  await navigator.clipboard?.writeText(nsec);
                } catch {}
              }}
            >Copy nsec</button>
            <button
              className="px-3 py-2 rounded-xl bg-neutral-800"
              onClick={()=>setDefaultRelays(DEFAULT_RELAYS.slice())}
            >Reload default relays</button>
          </div>
          {showAdvanced && (
            <>
              {/* Public key */}
              <div className="mb-3">
                <div className="text-xs text-neutral-400 mb-1">Your Nostr public key (hex)</div>
                <div className="flex gap-2 items-center">
                  <input readOnly value={pubkeyHex || "(generating…)"}
                         className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"/>
                  <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={async ()=>{ if(pubkeyHex) { try { await navigator.clipboard?.writeText(pubkeyHex); } catch {} } }}>Copy</button>
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
                <div className="flex gap-2">
                  <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={onGenerateKey}>Generate new key</button>
                  <button
                    className="px-3 py-2 rounded-xl bg-neutral-800"
                    onClick={async ()=>{
                      try {
                        const sk = localStorage.getItem(LS_NOSTR_SK) || "";
                        if (!sk) return;
                        let nsec = "";
                        try {
                          // Prefer nip19.nsecEncode when available
                          // @ts-expect-error - guard at runtime below
                          nsec = typeof (nip19 as any)?.nsecEncode === 'function' ? (nip19 as any).nsecEncode(sk) : sk;
                        } catch {
                          nsec = sk;
                        }
                        await navigator.clipboard?.writeText(nsec);
                      } catch {}
                    }}
                  >Copy private key (nsec)</button>
                </div>
              </div>

              {/* Default relays */}
              <div className="mb-3">
                <div className="text-xs text-neutral-400 mb-1">Default relays</div>
                <div className="flex gap-2 mb-2">
                  <input
                    value={newDefaultRelay}
                    onChange={(e)=>setNewDefaultRelay(e.target.value)}
                    onKeyDown={(e)=>{ if (e.key === 'Enter') { const v = newDefaultRelay.trim(); if (v && !defaultRelays.includes(v)) { setDefaultRelays([...defaultRelays, v]); setNewDefaultRelay(""); } } }}
                    className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
                    placeholder="wss://relay.example"
                  />
                  <button
                    className="px-3 py-2 rounded-xl bg-neutral-800"
                    onClick={()=>{ const v = newDefaultRelay.trim(); if (v && !defaultRelays.includes(v)) { setDefaultRelays([...defaultRelays, v]); setNewDefaultRelay(""); } }}
                  >Add</button>
                </div>
                <ul className="space-y-2">
                  {defaultRelays.map((r) => (
                    <li key={r} className="p-2 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center gap-2">
                      <div className="flex-1 truncate">{r}</div>
                      <button className="pressable px-3 py-1 rounded-full bg-rose-600/80 hover:bg-rose-600" onClick={()=>setDefaultRelays(defaultRelays.filter(x => x !== r))}>Delete</button>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex gap-2">
                  <button
                    className="px-3 py-2 rounded-xl bg-neutral-800"
                    onClick={()=>setDefaultRelays(DEFAULT_RELAYS.slice())}
                  >Reload defaults</button>
                </div>
              </div>
            </>
          )}
        </section>

        {/* Cashu mint: moved into Wallet → Mint balances */}

        {/* Backup & Restore */}
        <section className="rounded-xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="text-sm font-medium mb-3">Backup</div>
          <div className="flex gap-2">
            <button className="flex-1 px-3 py-2 rounded-xl bg-neutral-800" onClick={backupData}>Download backup</button>
            <label className="flex-1 px-3 py-2 rounded-xl bg-neutral-800 text-center cursor-pointer">
              Restore from backup
              <input type="file" accept="application/json" className="hidden" onChange={restoreFromBackup} />
            </label>
          </div>
        </section>

        {/* Development donation */}
        <section className="rounded-xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="text-sm font-medium mb-2">Support development</div>
          <div className="text-xs text-neutral-400 mb-3">Donate from your internal wallet to dev@solife.me</div>
          <div className="flex gap-2 mb-2">
            <input
              className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
              placeholder="Amount (sats)"
              value={donateAmt}
              onChange={(e)=>setDonateAmt(e.target.value)}
              inputMode="numeric"
            />
            <button
              className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500"
              onClick={handleDonate}
              disabled={!mintUrl || donateState === 'sending'}
            >Donate Now</button>
          </div>
          <input
            className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
            placeholder="Comment (optional)"
            value={donateComment}
            onChange={(e)=>setDonateComment(e.target.value)}
          />
          <div className="mt-2 text-xs">
            {donateState === 'sending' && <span>Sending…</span>}
            {donateState === 'done' && <span className="text-emerald-400">{donateMsg}</span>}
            {donateState === 'error' && <span className="text-rose-400">{donateMsg}</span>}
          </div>
        </section>

        {/* Feedback / Feature requests */}
        <section>
          <div className="text-xs text-neutral-400">
            Please submit any feedback or feature requests to{' '}
            <button
              className="underline text-emerald-400"
              onClick={async ()=>{ try { await navigator.clipboard?.writeText('dev@solife.me'); showToast('Copied dev@solife.me'); } catch {} }}
            >dev@solife.me</button>{' '}or Board ID{' '}
            <button
              className="underline text-emerald-400"
              onClick={async ()=>{ try { await navigator.clipboard?.writeText('c3db0d84-ee89-43df-a31e-edb4c75be32b'); showToast('Copied Board ID'); } catch {} }}
            >c3db0d84-ee89-43df-a31e-edb4c75be32b</button>
          </div>
        </section>

        <div className="flex justify-end">
          <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={handleClose}>Close</button>
        </div>
      </div>
    </Modal>
    {manageBoard && (
      <Modal onClose={() => setManageBoardId(null)} title="Manage board">
        <input
          value={manageBoard.name}
          onChange={e => renameBoard(manageBoard.id, e.target.value)}
          className="w-full mb-4 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
        />
        {manageBoard.kind === "lists" ? (
          <>
            <ul className="space-y-2">
              {manageBoard.columns.map(col => (
                <ColumnItem key={col.id} boardId={manageBoard.id} column={col} />
              ))}
            </ul>
            <div className="mt-2">
              <button className="pressable px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>addColumn(manageBoard.id)}>Add list</button>
            </div>
            <div className="text-xs text-neutral-400 mt-2">Tasks can be dragged between lists directly on the board.</div>
          </>
        ) : (
          <div className="text-xs text-neutral-400">The Week board has fixed columns (Sun–Sat, Bounties).</div>
        )}

        <div className="mt-6">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-sm font-medium">Sharing</div>
            <div className="ml-auto" />
            <button
              className="px-3 py-1 rounded-lg bg-neutral-800 text-xs"
              onClick={()=>setShowAdvanced(a=>!a)}
            >{showAdvanced ? "Hide advanced" : "Advanced"}</button>
          </div>
          <div className="space-y-2">
            {manageBoard.nostr ? (
              <>
                <div className="text-xs text-neutral-400">Board ID</div>
                <div className="flex gap-2 items-center">
                  <input readOnly value={manageBoard.nostr.boardId}
                         className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"/>
                  <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={async ()=>{ try { await navigator.clipboard?.writeText(manageBoard.nostr!.boardId); } catch {} }}>Copy</button>
                </div>
                  {showAdvanced && (
                    <>
                      <div className="text-xs text-neutral-400">Relays</div>
                      <div className="flex gap-2 mb-2">
                        <input
                          value={newBoardRelay}
                          onChange={(e)=>setNewBoardRelay(e.target.value)}
                          onKeyDown={(e)=>{ if (e.key === 'Enter' && manageBoard?.nostr) { const v = newBoardRelay.trim(); if (v && !(manageBoard.nostr.relays || []).includes(v)) { setBoards(prev => prev.map(b => b.id === manageBoard.id ? ({...b, nostr: { boardId: manageBoard.nostr!.boardId, relays: [...(manageBoard.nostr!.relays || []), v] } }) : b)); setNewBoardRelay(""); } } }}
                          className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
                          placeholder="wss://relay.example"
                        />
                        <button
                          className="px-3 py-2 rounded-xl bg-neutral-800"
                          onClick={()=>{ if (!manageBoard?.nostr) return; const v = newBoardRelay.trim(); if (v && !(manageBoard.nostr.relays || []).includes(v)) { setBoards(prev => prev.map(b => b.id === manageBoard.id ? ({...b, nostr: { boardId: manageBoard.nostr!.boardId, relays: [...(manageBoard.nostr!.relays || []), v] } }) : b)); setNewBoardRelay(""); } }}
                        >Add</button>
                      </div>
                      <ul className="space-y-2 mb-2">
                        {(manageBoard.nostr.relays || []).map((r) => (
                          <li key={r} className="p-2 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center gap-2">
                            <div className="flex-1 truncate">{r}</div>
                            <button
                              className="pressable px-3 py-1 rounded-full bg-rose-600/80 hover:bg-rose-600"
                              onClick={()=>{
                                if (!manageBoard?.nostr) return;
                                const relays = (manageBoard.nostr.relays || []).filter(x => x !== r);
                                setBoards(prev => prev.map(b => b.id === manageBoard.id ? ({...b, nostr: { boardId: manageBoard.nostr!.boardId, relays } }) : b));
                              }}
                            >Delete</button>
                          </li>
                        ))}
                      </ul>
                      <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>onRegenerateBoardId(manageBoard.id)}>Generate new board ID</button>
                    </>
                  )}
                  <div className="flex gap-2">
                    <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>onBoardChanged(manageBoard.id)}>Republish metadata</button>
                  <button className="px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600" onClick={()=>{
                    setBoards(prev => prev.map(b => b.id === manageBoard.id ? (b.kind === 'week' ? { id: b.id, name: b.name, kind: 'week' } as Board : { id: b.id, name: b.name, kind: 'lists', columns: b.columns } as Board) : b));
                  }}>Stop sharing</button>
                </div>
              </>
            ) : (
              <>
                {showAdvanced && (
                  <>
                    <div className="text-xs text-neutral-400">Relays override (optional)</div>
                    <div className="flex gap-2 mb-2">
                      <input
                        value={newOverrideRelay}
                        onChange={(e)=>setNewOverrideRelay(e.target.value)}
                        onKeyDown={(e)=>{ if (e.key === 'Enter') { const v = newOverrideRelay.trim(); if (v) { setRelaysCsv(addRelayToCsv(relaysCsv, v)); setNewOverrideRelay(""); } } }}
                        className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
                        placeholder="wss://relay.example"
                      />
                      <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={()=>{ const v = newOverrideRelay.trim(); if (v) { setRelaysCsv(addRelayToCsv(relaysCsv, v)); setNewOverrideRelay(""); } }}>Add</button>
                    </div>
                    <ul className="space-y-2 mb-2">
                      {parseCsv(relaysCsv).map((r) => (
                        <li key={r} className="p-2 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center gap-2">
                          <div className="flex-1 truncate">{r}</div>
                          <button className="pressable px-3 py-1 rounded-full bg-rose-600/80 hover:bg-rose-600" onClick={()=>setRelaysCsv(removeRelayFromCsv(relaysCsv, r))}>Delete</button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <button className="block w-full px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500" onClick={()=>{onShareBoard(manageBoard.id, showAdvanced ? relaysCsv : ""); setRelaysCsv('');}}>Share this board</button>
              </>
            )}
            <button className="pressable block w-full px-3 py-2 rounded-xl bg-rose-600/80 hover:bg-rose-600" onClick={()=>deleteBoard(manageBoard.id)}>Delete board</button>
          </div>
        </div>
      </Modal>
    )}
    </>
  );
}
