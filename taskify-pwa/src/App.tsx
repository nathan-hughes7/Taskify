import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { finalizeEvent, getPublicKey, generateSecretKey, type EventTemplate, nip19, nip04 } from "nostr-tools";
import { CashuWalletModal } from "./components/CashuWalletModal";
import { useCashu } from "./context/CashuContext";
import { LS_LIGHTNING_CONTACTS } from "./localStorageKeys";
import { LS_NOSTR_RELAYS, LS_NOSTR_SK } from "./nostrKeys";
import { loadStore as loadProofStore, saveStore as saveProofStore, getActiveMint, setActiveMint } from "./wallet/storage";
import { encryptToBoard, decryptFromBoard, boardTag } from "./boardCrypto";
import { useToast } from "./context/ToastContext";
import { AccentPalette, BackgroundImageError, normalizeAccentPalette, normalizeAccentPaletteList, prepareBackgroundImage } from "./theme/palette";

/* ================= Types ================= */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun
type DayChoice = Weekday | "bounties" | string; // string = custom list columnId
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WD_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

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
  dueTimeEnabled?: boolean;       // whether a specific due time is set
  reminders?: ReminderPreset[];   // preset reminder offsets before due time
};

type ReminderPreset = "5m" | "15m" | "1h" | "1d";

type PushPlatform = "ios" | "android";

type PushPreferences = {
  enabled: boolean;
  platform: PushPlatform;
  deviceId?: string;
  subscriptionId?: string;
  permission?: NotificationPermission;
};

const REMINDER_PRESETS: ReadonlyArray<{ id: ReminderPreset; label: string; badge: string; minutes: number }> = [
  { id: "5m", label: "5 minutes before", badge: "5m", minutes: 5 },
  { id: "15m", label: "15 minutes before", badge: "15m", minutes: 15 },
  { id: "1h", label: "1 hour before", badge: "1h", minutes: 60 },
  { id: "1d", label: "1 day before", badge: "1d", minutes: 1440 },
];

const REMINDER_IDS = new Set<ReminderPreset>(REMINDER_PRESETS.map((opt) => opt.id as ReminderPreset));
const REMINDER_MINUTES = new Map<ReminderPreset, number>(REMINDER_PRESETS.map((opt) => [opt.id, opt.minutes] as const));

const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  enabled: false,
  platform: "ios",
  permission: (typeof Notification !== 'undefined' ? Notification.permission : 'default') as NotificationPermission,
};

const RAW_WORKER_BASE = (import.meta as any)?.env?.VITE_WORKER_BASE_URL || "";
const WORKER_BASE_URL = RAW_WORKER_BASE ? String(RAW_WORKER_BASE).replace(/\/$/, "") : "";
const VAPID_PUBLIC_KEY = (import.meta as any)?.env?.VITE_VAPID_PUBLIC_KEY || "";

function sanitizeReminderList(value: unknown): ReminderPreset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dedup = new Set<ReminderPreset>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (REMINDER_IDS.has(item as ReminderPreset)) dedup.add(item as ReminderPreset);
  }
  return [...dedup];
}

function reminderPresetToMinutes(id: ReminderPreset): number {
  return REMINDER_MINUTES.get(id) ?? 0;
}

function taskHasReminders(task: Task): boolean {
  return !!task.dueTimeEnabled && Array.isArray(task.reminders) && task.reminders.length > 0;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const decode = typeof atob === 'function'
    ? atob
    : (() => { throw new Error('No base64 decoder available in this environment'); });
  const rawData = decode(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

type ListColumn = { id: string; name: string };

type BoardBase = {
  id: string;
  name: string;
  // Optional Nostr sharing metadata
  nostr?: { boardId: string; relays: string[] };
  archived?: boolean;
  hidden?: boolean;
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
  startBoardByDay: Partial<Record<Weekday, string>>;
  accent: "green" | "blue" | "background";
  backgroundImage?: string | null;
  backgroundAccent?: AccentPalette | null;
  backgroundAccents?: AccentPalette[] | null;
  backgroundAccentIndex?: number | null;
  backgroundBlur: "blurred" | "sharp";
  hideCompletedSubtasks: boolean;
  startupView: "main" | "wallet";
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  npubCashLightningAddressEnabled: boolean;
  npubCashAutoClaim: boolean;
  pushNotifications: PushPreferences;
};

type AccentChoice = {
  id: "blue" | "green";
  label: string;
  fill: string;
  ring: string;
  border: string;
  borderActive: string;
  shadow: string;
  shadowActive: string;
};

const ACCENT_CHOICES: AccentChoice[] = [
  {
    id: "blue",
    label: "iMessage blue",
    fill: "#0a84ff",
    ring: "rgba(64, 156, 255, 0.32)",
    border: "rgba(64, 156, 255, 0.38)",
    borderActive: "rgba(64, 156, 255, 0.88)",
    shadow: "0 12px 26px rgba(10, 132, 255, 0.32)",
    shadowActive: "0 18px 34px rgba(10, 132, 255, 0.42)",
  },
  {
    id: "green",
    label: "Mint green",
    fill: "#34c759",
    ring: "rgba(52, 199, 89, 0.28)",
    border: "rgba(52, 199, 89, 0.36)",
    borderActive: "rgba(52, 199, 89, 0.86)",
    shadow: "0 12px 24px rgba(52, 199, 89, 0.28)",
    shadowActive: "0 18px 32px rgba(52, 199, 89, 0.38)",
  },
];

const CUSTOM_ACCENT_VARIABLES: ReadonlyArray<[string, keyof AccentPalette]> = [
  ["--accent", "fill"],
  ["--accent-hover", "hover"],
  ["--accent-active", "active"],
  ["--accent-soft", "soft"],
  ["--accent-border", "border"],
  ["--accent-on", "on"],
  ["--accent-glow", "glow"],
];

function gradientFromPalette(palette: AccentPalette, hasImage: boolean): string {
  const primary = hexToRgba(palette.fill, 0.24);
  const secondary = hexToRgba(palette.fill, 0.14);
  const baseAlpha = hasImage ? 0.65 : 0.95;
  return `radial-gradient(circle at 18% -10%, ${primary}, transparent 60%),` +
    `radial-gradient(circle at 82% -12%, ${secondary}, transparent 65%),` +
    `rgba(6, 9, 18, ${baseAlpha})`;
}

function hexToRgba(hex: string, alpha: number): string {
  let value = hex.replace(/^#/, "");
  if (value.length === 3) {
    value = value.split("").map(ch => ch + ch).join("");
  }
  const int = parseInt(value.slice(0, 6), 16);
  if (Number.isNaN(int)) {
    return `rgba(52, 199, 89, ${Math.min(1, Math.max(0, alpha))})`;
  }
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const clampedAlpha = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
}

const R_NONE: Recurrence = { type: "none" };
const LS_TASKS = "taskify_tasks_v5";
const LS_TASKS_LEGACY = ["taskify_tasks_v4"] as const;
const LS_SETTINGS = "taskify_settings_v2";
const LS_BOARDS = "taskify_boards_v2";
const LS_TUTORIAL_DONE = "taskify_tutorial_done_v1";

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

const NOSTR_MIN_EVENT_INTERVAL_MS = 200;

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

function isoDatePart(iso: string): string {
  if (typeof iso === 'string' && iso.length >= 10) return iso.slice(0, 10);
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return new Date().toISOString().slice(0, 10); }
}

function isoTimePart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function isoFromDateTime(dateStr: string, timeStr?: string): string {
  if (dateStr) {
    if (timeStr) {
      const withTime = new Date(`${dateStr}T${timeStr}`);
      if (!Number.isNaN(withTime.getTime())) return withTime.toISOString();
    }
    const midnight = new Date(`${dateStr}T00:00`);
    if (!Number.isNaN(midnight.getTime())) return midnight.toISOString();
  }
  const parsed = new Date(dateStr);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

function formatTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function isoForWeekday(target: Weekday, base = new Date()): string {
  const today = startOfDay(base);
  const diff = target - (today.getDay() as Weekday);
  return new Date(today.getTime() + diff * 86400000).toISOString();
}
function nextOccurrence(currentISO: string, rule: Recurrence): string | null {
  const currentDate = new Date(currentISO);
  const curDay = startOfDay(currentDate);
  const timeOffset = currentDate.getTime() - curDay.getTime();
  const addDays = (d: number) => {
    const nextDay = startOfDay(new Date(curDay.getTime() + d * 86400000));
    return new Date(nextDay.getTime() + timeOffset).toISOString();
  };
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
      const y = curDay.getFullYear(), m = curDay.getMonth();
      const n = startOfDay(new Date(y, m + 1, Math.min(rule.day, 28)));
      next = new Date(n.getTime() + timeOffset).toISOString();
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
      const baseFontSize =
        typeof parsed.baseFontSize === "number" ? parsed.baseFontSize : null;
      const startBoardByDay: Partial<Record<Weekday, string>> = {};
      if (parsed && typeof parsed.startBoardByDay === "object" && parsed.startBoardByDay) {
        for (const [key, value] of Object.entries(parsed.startBoardByDay as Record<string, unknown>)) {
          const day = Number(key);
          if (!Number.isInteger(day) || day < 0 || day > 6) continue;
          if (typeof value !== "string" || !value) continue;
          startBoardByDay[day as Weekday] = value;
        }
      }
      const backgroundImage = typeof parsed?.backgroundImage === "string" ? parsed.backgroundImage : null;
      let backgroundAccents = normalizeAccentPaletteList(parsed?.backgroundAccents) ?? null;
      let backgroundAccentIndex = typeof parsed?.backgroundAccentIndex === "number" ? parsed.backgroundAccentIndex : null;
      let backgroundAccent = normalizeAccentPalette(parsed?.backgroundAccent) ?? null;
      if (!backgroundAccents || backgroundAccents.length === 0) {
        backgroundAccents = null;
        backgroundAccentIndex = null;
      } else {
        if (backgroundAccentIndex == null || backgroundAccentIndex < 0 || backgroundAccentIndex >= backgroundAccents.length) {
          backgroundAccentIndex = 0;
        }
        if (!backgroundAccent) backgroundAccent = backgroundAccents[backgroundAccentIndex];
      }
      if (!backgroundImage) {
        backgroundAccents = null;
        backgroundAccentIndex = null;
        backgroundAccent = null;
      }
      const backgroundBlur = parsed?.backgroundBlur === "blurred" ? "blurred" : "sharp";
      let accent: Settings["accent"] = "blue";
      if (parsed?.accent === "green") accent = "green";
      else if (parsed?.accent === "background" && backgroundImage && backgroundAccent) accent = "background";
      const hideCompletedSubtasks = parsed?.hideCompletedSubtasks === true;
      const startupView = parsed?.startupView === "wallet" ? "wallet" : "main";
      const walletConversionEnabled = parsed?.walletConversionEnabled === true;
      const walletPrimaryCurrency = parsed?.walletPrimaryCurrency === "usd" ? "usd" : "sat";
      const npubCashLightningAddressEnabled = parsed?.npubCashLightningAddressEnabled === true;
      const npubCashAutoClaim = npubCashLightningAddressEnabled && parsed?.npubCashAutoClaim === true;
      const pushRaw = parsed?.pushNotifications;
      const pushPreferences: PushPreferences = {
        enabled: pushRaw?.enabled === true,
        platform: pushRaw?.platform === "android" ? "android" : "ios",
        deviceId: typeof pushRaw?.deviceId === 'string' ? pushRaw.deviceId : undefined,
        subscriptionId: typeof pushRaw?.subscriptionId === 'string' ? pushRaw.subscriptionId : undefined,
        permission:
          pushRaw?.permission === 'granted' || pushRaw?.permission === 'denied'
            ? pushRaw.permission
            : DEFAULT_PUSH_PREFERENCES.permission,
      };
      if (parsed && typeof parsed === "object") {
        delete (parsed as Record<string, unknown>).theme;
        delete (parsed as Record<string, unknown>).backgroundAccents;
        delete (parsed as Record<string, unknown>).backgroundAccentIndex;
      }
      return {
        weekStart: 0,
        newTaskPosition: "top",
        streaksEnabled: true,
        completedTab: true,
        showFullWeekRecurring: false,
        inlineAdd: true,
        ...parsed,
        hideCompletedSubtasks,
        baseFontSize,
        startBoardByDay,
        accent,
        backgroundImage,
        backgroundAccent,
        backgroundAccents,
        backgroundAccentIndex,
        backgroundBlur,
        startupView,
        walletConversionEnabled,
        walletPrimaryCurrency: walletConversionEnabled ? walletPrimaryCurrency : "sat",
        npubCashLightningAddressEnabled,
        npubCashAutoClaim: npubCashLightningAddressEnabled ? npubCashAutoClaim : false,
        pushNotifications: { ...DEFAULT_PUSH_PREFERENCES, ...pushPreferences },
      };
    } catch {
      return {
        weekStart: 0,
        newTaskPosition: "top",
        streaksEnabled: true,
        completedTab: true,
        showFullWeekRecurring: false,
        inlineAdd: true,
        baseFontSize: null,
        startBoardByDay: {},
        accent: "blue",
        backgroundImage: null,
        backgroundAccent: null,
        backgroundAccents: null,
        backgroundAccentIndex: null,
        backgroundBlur: "sharp",
        hideCompletedSubtasks: false,
        startupView: "main",
        walletConversionEnabled: false,
        walletPrimaryCurrency: "sat",
        npubCashLightningAddressEnabled: false,
        npubCashAutoClaim: false,
        pushNotifications: { ...DEFAULT_PUSH_PREFERENCES },
      };
    }
  });
  const setSettings = useCallback((s: Partial<Settings>) => {
    setSettingsRaw(prev => {
      const next = { ...prev, ...s };
      if (s.pushNotifications) {
        next.pushNotifications = { ...prev.pushNotifications, ...DEFAULT_PUSH_PREFERENCES, ...s.pushNotifications };
      }
      if (!next.backgroundImage) {
        next.backgroundImage = null;
        next.backgroundAccent = null;
        next.backgroundAccents = null;
        next.backgroundAccentIndex = null;
      } else {
        next.backgroundAccent = normalizeAccentPalette(next.backgroundAccent) ?? next.backgroundAccent ?? null;
        const normalizedList = normalizeAccentPaletteList(next.backgroundAccents);
        next.backgroundAccents = normalizedList && normalizedList.length ? normalizedList : null;
        if (next.backgroundAccents?.length) {
          if (typeof next.backgroundAccentIndex !== "number" || next.backgroundAccentIndex < 0 || next.backgroundAccentIndex >= next.backgroundAccents.length) {
            next.backgroundAccentIndex = 0;
          }
          next.backgroundAccent = next.backgroundAccents[next.backgroundAccentIndex];
        } else {
          next.backgroundAccents = null;
          next.backgroundAccentIndex = null;
          if (next.backgroundAccent) {
            next.backgroundAccents = [next.backgroundAccent];
            next.backgroundAccentIndex = 0;
          }
        }
      }
      if (next.backgroundBlur !== "sharp" && next.backgroundBlur !== "blurred") {
        next.backgroundBlur = "sharp";
      }
      if (next.accent === "background" && (!next.backgroundImage || !next.backgroundAccent)) {
        next.accent = "blue";
      }
      if (!next.walletConversionEnabled) {
        next.walletPrimaryCurrency = "sat";
      } else if (next.walletPrimaryCurrency !== "usd") {
        next.walletPrimaryCurrency = "sat";
      }
      if (!next.npubCashLightningAddressEnabled) {
        next.npubCashLightningAddressEnabled = false;
        next.npubCashAutoClaim = false;
      } else if (next.npubCashAutoClaim !== true && next.npubCashAutoClaim !== false) {
        next.npubCashAutoClaim = false;
      }
      return next;
    });
  }, []);
  useEffect(() => {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  }, [settings]);
  return [settings, setSettings] as const;
}

function pickStartupBoard(boards: Board[], overrides?: Partial<Record<Weekday, string>>): string {
  const visible = boards.filter(b => !b.archived && !b.hidden);
  const today = (new Date().getDay() as Weekday);
  const overrideId = overrides?.[today];
  if (overrideId) {
    const match = visible.find(b => b.id === overrideId) || boards.find(b => !b.archived && b.id === overrideId);
    if (match) return match.id;
  }
  if (visible.length) return visible[0].id;
  const firstUnarchived = boards.find(b => !b.archived);
  if (firstUnarchived) return firstUnarchived.id;
  return boards[0]?.id || "";
}

function migrateBoards(stored: any): Board[] | null {
  try {
    const arr = stored as any[];
    if (!Array.isArray(arr)) return null;
    return arr.map((b) => {
      const archived =
        typeof b?.archived === "boolean"
          ? b.archived
          : typeof b?.hidden === "boolean"
            ? b.hidden
            : false;
      const hidden =
        typeof b?.hidden === "boolean" && typeof b?.archived === "boolean"
          ? b.hidden
          : false;
      if (b?.kind === "week") {
        return {
          id: b.id,
          name: b.name,
          kind: "week",
          nostr: b.nostr,
          archived,
          hidden,
        } as Board;
      }
      if (b?.kind === "lists" && Array.isArray(b.columns)) {
        return {
          id: b.id,
          name: b.name,
          kind: "lists",
          columns: b.columns,
          nostr: b.nostr,
          archived,
          hidden,
        } as Board;
      }
      if (b?.kind === "list") {
        // old single-column boards -> migrate to lists with one column
        const colId = crypto.randomUUID();
        return {
          id: b.id,
          name: b.name,
          kind: "lists",
          columns: [{ id: colId, name: "Items" }],
          nostr: b?.nostr,
          archived,
          hidden,
        } as Board;
      }
      // unknown -> keep as lists with one column
      const colId = crypto.randomUUID();
      return {
        id: b?.id || crypto.randomUUID(),
        name: b?.name || "Board",
        kind: "lists",
        columns: [{ id: colId, name: "Items" }],
        nostr: b?.nostr,
        archived,
        hidden,
      } as Board;
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
    return [{ id: "week-default", name: "Week", kind: "week", archived: false, hidden: false }];
  });
  useEffect(() => {
    localStorage.setItem(LS_BOARDS, JSON.stringify(boards));
  }, [boards]);
  return [boards, setBoards] as const;
}

function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    const loadStored = (): any[] => {
      try {
        const current = localStorage.getItem(LS_TASKS);
        if (current) {
          const parsed = JSON.parse(current);
          if (Array.isArray(parsed)) return parsed;
        }
      } catch {}
      for (const legacy of LS_TASKS_LEGACY) {
        try {
          const raw = localStorage.getItem(legacy);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      return [];
    };

    const rawTasks = loadStored();
    const orderMap = new Map<string, number>();
    return rawTasks
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const fallbackBoard = typeof (entry as any).boardId === 'string' ? (entry as any).boardId : 'week-default';
        const boardId = fallbackBoard;
        const next = orderMap.get(boardId) ?? 0;
        const explicitOrder = typeof (entry as any).order === 'number' ? (entry as any).order : next;
        orderMap.set(boardId, explicitOrder + 1);
        const dueISO = typeof (entry as any).dueISO === 'string' ? (entry as any).dueISO : new Date().toISOString();
        const dueTimeEnabled = typeof (entry as any).dueTimeEnabled === 'boolean' ? (entry as any).dueTimeEnabled : undefined;
        const reminders = sanitizeReminderList((entry as any).reminders);
        const id = typeof (entry as any).id === 'string' ? (entry as any).id : crypto.randomUUID();
        return {
          ...(entry as Task),
          id,
          boardId,
          order: explicitOrder,
          dueISO,
          ...(typeof dueTimeEnabled === 'boolean' ? { dueTimeEnabled } : {}),
          ...(reminders !== undefined ? { reminders } : {}),
        } as Task;
      })
      .filter((t): t is Task => !!t);
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_TASKS, JSON.stringify(tasks));
      for (const legacy of LS_TASKS_LEGACY) {
        try { localStorage.removeItem(legacy); } catch {}
      }
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
  const [settings, setSettings] = useSettings();
  const [currentBoardId, setCurrentBoardId] = useState(() => pickStartupBoard(boards, settings.startBoardByDay));
  const currentBoard = boards.find(b => b.id === currentBoardId);
  const visibleBoards = useMemo(() => boards.filter(b => !b.archived && !b.hidden), [boards]);


  useEffect(() => {
    const current = boards.find(b => b.id === currentBoardId);
    if (current && !current.archived && !current.hidden) return;
    const next = pickStartupBoard(boards, settings.startBoardByDay);
    if (next !== currentBoardId) setCurrentBoardId(next);
  }, [boards, currentBoardId, settings.startBoardByDay]);

  const [tasks, setTasks] = useTasks();
  const [defaultRelays, setDefaultRelays] = useState<string[]>(() => loadDefaultRelays());
  useEffect(() => { saveDefaultRelays(defaultRelays); }, [defaultRelays]);

  useEffect(() => {
    if (!settings.showFullWeekRecurring) return;
    setTasks(prev => ensureWeekRecurrences(prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.showFullWeekRecurring, settings.weekStart]);

  useEffect(() => {
    const overrides = settings.startBoardByDay;
    if (!overrides || Object.keys(overrides).length === 0) return;
    const visibleIds = new Set(boards.filter(b => !b.archived && !b.hidden).map(b => b.id));
    let changed = false;
    const next: Partial<Record<Weekday, string>> = {};
    for (const key of Object.keys(overrides)) {
      const dayNum = Number(key);
      const boardId = overrides[key as keyof typeof overrides];
      if (!Number.isInteger(dayNum) || dayNum < 0 || dayNum > 6) {
        changed = true;
        continue;
      }
      if (typeof boardId !== "string" || !boardId || !visibleIds.has(boardId)) {
        changed = true;
        continue;
      }
      next[dayNum as Weekday] = boardId;
    }
    if (changed) setSettings({ startBoardByDay: next });
  }, [boards, settings.startBoardByDay, setSettings]);

  // Apply font size setting to root; fall back to default size
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

  // Ensure the app always renders with the dark theme
  useEffect(() => {
    try {
      const root = document.documentElement;
      root.classList.remove("light");
      if (!root.classList.contains("dark")) root.classList.add("dark");
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", "#0a0a0a");
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const root = document.documentElement;
      const style = root.style;
      if (settings.accent === "green") root.setAttribute("data-accent", "green");
      else root.removeAttribute("data-accent");

      const palette = settings.accent === "background" ? settings.backgroundAccent ?? null : null;
      const hasBackgroundImage = Boolean(settings.backgroundImage);
      for (const [cssVar, key] of CUSTOM_ACCENT_VARIABLES) {
        if (palette) style.setProperty(cssVar, palette[key]);
        else style.removeProperty(cssVar);
      }
      if (palette) {
        style.setProperty("--background-gradient", gradientFromPalette(palette, hasBackgroundImage));
      } else {
        style.removeProperty("--background-gradient");
      }
    } catch (err) {
      console.error('Failed to apply accent palette', err);
    }
  }, [settings.accent, settings.backgroundAccent, settings.backgroundImage]);

  useEffect(() => {
    try {
      const root = document.documentElement;
      const style = root.style;
      if (settings.backgroundImage) {
        style.setProperty("--background-image", `url("${settings.backgroundImage}")`);
        style.setProperty("--background-image-opacity", "1");
        const blurMode = settings.backgroundBlur;
        const overlay = blurMode === "sharp" ? "0.1" : "0.18";
        style.setProperty("--background-overlay-opacity", overlay);
        style.setProperty("--background-image-filter", blurMode === "sharp" ? "none" : "blur(36px)");
        style.setProperty("--background-image-scale", blurMode === "sharp" ? "1.02" : "1.08");
      } else {
        style.removeProperty("--background-image");
        style.removeProperty("--background-image-opacity");
        style.removeProperty("--background-overlay-opacity");
        style.removeProperty("--background-image-filter");
        style.removeProperty("--background-image-scale");
      }
    } catch (err) {
      console.error('Failed to apply background image', err);
    }
  }, [settings.backgroundImage, settings.backgroundBlur]);

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
  const nostrPublishQueue = useRef<Promise<void>>(Promise.resolve());
  const lastNostrSentMs = useRef(0);
  async function nostrPublish(relays: string[], template: EventTemplate) {
    const run = async () => {
      const nowMs = Date.now();
      const elapsed = nowMs - lastNostrSentMs.current;
      if (elapsed < NOSTR_MIN_EVENT_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, NOSTR_MIN_EVENT_INTERVAL_MS - elapsed));
      }
      const now = Math.floor(Date.now() / 1000);
      let createdAt = typeof template.created_at === "number" ? template.created_at : now;
      if (createdAt <= lastNostrCreated.current) {
        createdAt = lastNostrCreated.current + 1;
      }
      lastNostrCreated.current = createdAt;
      const ev = finalizeEvent({ ...template, created_at: createdAt }, nostrSK);
      pool.publishEvent(relays, ev as unknown as NostrEvent);
      lastNostrSentMs.current = Date.now();
      return createdAt;
    };
    const next = nostrPublishQueue.current.catch(() => {}).then(run);
    nostrPublishQueue.current = next.then(() => {}, () => {});
    return next;
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
  const startupViewHandledRef = useRef(false);
  useEffect(() => {
    if (startupViewHandledRef.current) return;
    startupViewHandledRef.current = true;
    if (settings.startupView === "wallet") {
      setShowWallet(true);
    }
  }, [settings.startupView]);
  const { receiveToken } = useCashu();

  const [tutorialComplete, setTutorialComplete] = useState(() => {
    try {
      return localStorage.getItem(LS_TUTORIAL_DONE) === "done";
    } catch {
      return false;
    }
  });
  const [tutorialStep, setTutorialStep] = useState<number | null>(null);

  const markTutorialDone = useCallback(() => {
    setTutorialStep(null);
    setTutorialComplete(true);
    try {
      localStorage.setItem(LS_TUTORIAL_DONE, "done");
    } catch {}
  }, []);

  const handleCopyNsec = useCallback(async () => {
    try {
      const sk = localStorage.getItem(LS_NOSTR_SK) || "";
      if (!sk) {
        alert("No private key found yet. You can generate one from Settings → Nostr.");
        return;
      }
      let nsec = "";
      try {
        nsec = typeof (nip19 as any)?.nsecEncode === "function" ? (nip19 as any).nsecEncode(sk) : sk;
      } catch {
        nsec = sk;
      }
      await navigator.clipboard?.writeText(nsec);
      showToast("nsec copied");
    } catch {
      alert("Unable to copy your key. You can copy it later from Settings → Nostr.");
    }
  }, [showToast]);

  const tutorialSteps = useMemo(
    () => [
      {
        title: "Welcome to the new Taskify",
        body: (
          <div className="space-y-3 text-sm text-secondary">
            <p className="text-primary">
              Taskify now opens on a glassy Week board with a command center that keeps your essential controls close.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Pick any board from the pill switcher, or drag a task onto it to move work between boards.</li>
              <li>Use the control matrix to refresh shared boards, pop open Settings, jump into your wallet, or flip to the Completed view.</li>
              <li>The accent-aware surfaces keep lists legible while matching the color palette you choose.</li>
            </ul>
            <p className="text-tertiary">You can skip this tutorial at any time.</p>
          </div>
        ),
      },
      {
        title: "Capture and organize tasks",
        body: (
          <div className="space-y-3 text-sm text-secondary">
            <p className="text-primary">
              Capture ideas instantly and arrange them across days or custom lists.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Use the New Task bar or enable inline add boxes in Settings → View to create cards exactly where you need them.</li>
              <li>Drag tasks to reorder, drop them between boards, or toss them onto the floating Upcoming button to hide them until you&apos;re ready.</li>
              <li>Open a task to reorder subtasks, paste images, set advanced recurrence, track streaks, and attach optional bounties.</li>
            </ul>
          </div>
        ),
      },
      {
        title: "Shape your workspace",
        body: (
          <div className="space-y-3 text-sm text-secondary">
            <p className="text-primary">Settings are grouped so you can personalize the layout without hunting around.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Adjust font size, accent color, start-of-week, and Completed tab behavior from Settings → View.</li>
              <li>Pick inline add boxes, default task position, and per-day start boards to match how you plan.</li>
              <li>Manage boards from Settings → Boards &amp; Lists: reorder, archive via drag, or join shared boards with an ID.</li>
            </ul>
          </div>
        ),
      },
      {
        title: "Lightning ecash tools",
        body: (
          <div className="space-y-3 text-sm text-secondary">
            <p className="text-primary">The 💰 button opens your upgraded Cashu wallet with Lightning superpowers.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Track balances in sats or USD (toggle conversions in Settings → Wallet) and switch units from the wallet header.</li>
              <li>Scan QR codes to receive eCash, LNURL withdraws, Lightning invoices, or addresses without leaving the app.</li>
              <li>Save Lightning contacts, reuse them when paying, and fund task bounties or NWC withdrawals in a couple taps.</li>
              <li>Receive, Send, and Scan flows let you create shareable tokens, pay invoices, or move sats with Nostr Wallet Connect without leaving the app.</li>
            </ul>
            <p className="text-tertiary">Bounties on tasks reflect any ecash rewards you attach.</p>
          </div>
        ),
      },
      {
        title: "Back up your nsec",
        body: (
          <div className="space-y-3 text-sm text-secondary">
            <p className="text-primary">
              Your Nostr private key (nsec) lives only on this device. It unlocks shared boards, wallet connections, and future recoveries.
            </p>
            <p>Copy it now or later from Settings → Nostr and store it in a secure password manager.</p>
            <div>
              <button
                className="accent-button button-sm pressable"
                onClick={handleCopyNsec}
              >
                Copy my nsec
              </button>
            </div>
            <p className="text-tertiary">Skipping is okay—you can always copy it from Settings when you&apos;re ready.</p>
          </div>
        ),
      },
    ],
    [handleCopyNsec]
  );

  useEffect(() => {
    if (tutorialComplete || tutorialStep !== null) return;
    const hasTasks = tasks.length > 0;
    const hasCustomBoards = boards.some((b) => b.id !== "week-default" || b.kind !== "week");
    let hasHistory = false;
    try {
      const raw = localStorage.getItem("cashuHistory");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) hasHistory = true;
      }
    } catch {}
    if (!hasTasks && !hasCustomBoards && !hasHistory) {
      setTutorialStep(0);
    }
  }, [boards, tasks, tutorialComplete, tutorialStep]);

  const handleSkipTutorial = useCallback(() => {
    markTutorialDone();
  }, [markTutorialDone]);

  const handleNextTutorial = useCallback(() => {
    if (tutorialStep === null) return;
    if (tutorialStep >= tutorialSteps.length - 1) {
      markTutorialDone();
    } else {
      setTutorialStep(tutorialStep + 1);
    }
  }, [markTutorialDone, tutorialStep, tutorialSteps.length]);

  const handlePrevTutorial = useCallback(() => {
    setTutorialStep((prev) => {
      if (prev === null || prev <= 0) return prev;
      return prev - 1;
    });
  }, []);

  const handleRestartTutorial = useCallback(() => {
    try {
      localStorage.removeItem(LS_TUTORIAL_DONE);
    } catch {}
    setTutorialComplete(false);
    setTutorialStep(0);
    setShowSettings(false);
  }, []);

  useEffect(() => {
    if (!settings.completedTab) setView("board");
  }, [settings.completedTab]);

  // add bar
  const newTitleRef = useRef<HTMLInputElement>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newImages, setNewImages] = useState<string[]>([]);
  const [dayChoice, setDayChoice] = useState<DayChoice>(() => {
    const firstBoard = boards.find(b => !b.archived) ?? boards[0];
    if (firstBoard?.kind === "lists") {
      return (firstBoard as Extract<Board, {kind:"lists"}>).columns[0]?.id || "items";
    }
    return new Date().getDay() as Weekday;
  });
  const [scheduleDate, setScheduleDate] = useState<string>("");
  const [scheduleTime, setScheduleTime] = useState<string>("");
  const [pushWorkState, setPushWorkState] = useState<"idle" | "enabling" | "disabling">("idle");
  const [pushError, setPushError] = useState<string | null>(null);
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

  // fly-to-completed overlay + target
  const flyLayerRef = useRef<HTMLDivElement>(null);
  const completedTabRef = useRef<HTMLButtonElement>(null);
  // wallet button target for coin animation
  const boardSelectorRef = useRef<HTMLSelectElement>(null);
  const walletButtonRef = useRef<HTMLButtonElement>(null);
  const boardDropContainerRef = useRef<HTMLDivElement>(null);
  const boardDropListRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const upcomingButtonRef = useRef<HTMLButtonElement>(null);
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  const inlineInputRefs = useRef(new Map<string, HTMLInputElement>());

  const setColumnRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) columnRefs.current.set(key, el);
    else columnRefs.current.delete(key);
  }, []);

  const setInlineInputRef = useCallback((key: string, el: HTMLInputElement | null) => {
    if (el) inlineInputRefs.current.set(key, el);
    else inlineInputRefs.current.delete(key);
  }, []);
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

    const rootStyles = getComputedStyle(document.documentElement);
    const accent = rootStyles.getPropertyValue("--accent").trim() || "#34c759";
    const accentSoft = rootStyles.getPropertyValue("--accent-soft").trim() || "rgba(52, 199, 89, 0.28)";
    const accentOn = rootStyles.getPropertyValue("--accent-on").trim() || "#0a1f12";

    const dot = document.createElement('div');
    dot.style.position = 'fixed';
    dot.style.left = `${startX - dotSize / 2}px`;
    dot.style.top = `${startY - dotSize / 2}px`;
    dot.style.width = `${dotSize}px`;
    dot.style.height = `${dotSize}px`;
    dot.style.borderRadius = '9999px';
    dot.style.background = accent;
    dot.style.color = accentOn || '#ffffff';
    dot.style.display = 'grid';
    dot.style.placeItems = 'center';
    dot.style.fontSize = `${dotFont}px`;
    dot.style.lineHeight = `${dotSize}px`;
    dot.style.boxShadow = `0 0 0 2px ${accentSoft || 'rgba(16,185,129,0.3)'}, 0 6px 16px rgba(0,0,0,0.35)`;
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

  function flyNewTask(
    from: DOMRect | null,
    dest:
      | { type: "column"; key: string; label: string }
      | { type: "upcoming"; label: string }
  ) {
    const layer = flyLayerRef.current;
    if (!layer) return;
    if (typeof window === "undefined") return;
    try {
      if (
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        return;
      }
    } catch {}

    requestAnimationFrame(() => {
      const targetEl =
        dest.type === "column"
          ? columnRefs.current.get(dest.key) || null
          : upcomingButtonRef.current;
      if (!targetEl) return;

      const targetRect = targetEl.getBoundingClientRect();
      const startRect = from ?? targetRect;
      const startX = startRect.left + startRect.width / 2;
      const startY = startRect.top + startRect.height / 2;
      const endX = targetRect.left + targetRect.width / 2;
      const endY =
        dest.type === "column"
          ? targetRect.top + Math.min(targetRect.height / 2, 56)
          : targetRect.top + targetRect.height / 2;

      const card = document.createElement("div");
      const text = (dest.label || "Task").trim();
      const truncated = text.length > 60 ? `${text.slice(0, 57)}…` : text || "Task";
      const widthSource = from ? from.width : startRect.width;
      const cardWidth = Math.max(Math.min(widthSource * 0.55, 280), 150);
      card.className = `fly-task-card ${
        dest.type === "column" ? "fly-task-card--board" : "fly-task-card--upcoming"
      }`;
      card.style.position = "fixed";
      card.style.left = `${startX}px`;
      card.style.top = `${startY}px`;
      card.style.width = `${cardWidth}px`;
      card.style.transform = "translate(-50%, -50%) scale(0.92)";
      card.style.opacity = "0.98";
      card.style.pointerEvents = "none";
      card.style.zIndex = "1000";
      card.style.boxShadow =
        dest.type === "column"
          ? "0 18px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(63,63,70,0.45), 0 12px 26px rgba(16,185,129,0.2)"
          : "0 18px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(63,63,70,0.45), 0 12px 26px rgba(59,130,246,0.2)";
      card.style.willChange = "transform, left, top, opacity";

      const body = document.createElement("div");
      body.className = "fly-task-card__body";

      const titleEl = document.createElement("div");
      titleEl.className = "fly-task-card__title";
      titleEl.textContent = truncated;
      body.appendChild(titleEl);

      card.appendChild(body);
      layer.appendChild(card);

      const pulseClass =
        dest.type === "column" ? "fly-target-pulse-board" : "fly-target-pulse-upcoming";
      targetEl.classList.add(pulseClass);
      window.setTimeout(() => {
        try {
          targetEl.classList.remove(pulseClass);
        } catch {}
      }, 650);

      requestAnimationFrame(() => {
        card.style.left = `${endX}px`;
        card.style.top = `${endY}px`;
        card.style.transform = "translate(-50%, -50%) scale(0.75)";
        card.style.opacity = "0";
        window.setTimeout(() => {
          try {
            layer.removeChild(card);
          } catch {}
        }, 700);
      });
    });
  }

  function animateTaskArrival(from: DOMRect | null, task: Task, board: Board) {
    if (!board || task.completed) return;
    const labelSource = task.title || (task.images?.length ? "Image" : "");
    const label = labelSource.trim() || "Task";
    if (!isVisibleNow(task)) {
      flyNewTask(from, { type: "upcoming", label });
      return;
    }

    if (board.kind === "week") {
      const due = new Date(task.dueISO);
      if (Number.isNaN(due.getTime())) return;
      const key = task.column === "bounties"
        ? "week-bounties"
        : `week-day-${due.getDay()}`;
      flyNewTask(from, { type: "column", key, label });
    } else if (board.kind === "lists" && task.columnId) {
      flyNewTask(from, { type: "column", key: `list-${task.columnId}`, label });
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
    [tasksForBoard, currentBoard?.kind, settings.completedTab]
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

  const reminderTasks = useMemo(() => tasks.filter(taskHasReminders), [tasks]);
  const reminderPayloadRef = useRef<string | null>(null);

  useEffect(() => {
    const pushPrefs = settings.pushNotifications;
    if (!pushPrefs?.enabled || !pushPrefs.deviceId || !pushPrefs.subscriptionId) {
      reminderPayloadRef.current = null;
      return;
    }
    if (!WORKER_BASE_URL) {
      return;
    }

    const remindersPayload = reminderTasks
      .map((task) => ({
        taskId: task.id,
        boardId: task.boardId,
        dueISO: task.dueISO,
        title: task.title,
        minutesBefore: (task.reminders ?? []).map(reminderPresetToMinutes).sort((a, b) => a - b),
      }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId));
    const payloadString = JSON.stringify(remindersPayload);
    if (reminderPayloadRef.current === payloadString) return;
    reminderPayloadRef.current = payloadString;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      syncRemindersToWorker(pushPrefs, reminderTasks, { signal: controller.signal }).catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('Reminder sync failed', err);
        setPushError(err instanceof Error ? err.message : 'Failed to sync reminders');
      });
    }, 400);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [reminderTasks, settings.pushNotifications]);

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
  async function maybePublishTask(
    t: Task,
    boardOverride?: Board,
    options?: { skipBoardMetadata?: boolean }
  ) {
    const b = boardOverride || boards.find((x) => x.id === t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    if (!options?.skipBoardMetadata) {
      await publishBoardMetadata(b);
    }
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const bTag = boardTag(boardId);
    const status = t.completed ? "done" : "open";
    const colTag = (b.kind === "week") ? (t.column === "bounties" ? "bounties" : "day") : (t.columnId || "");
    const tags: string[][] = [["d", t.id],["b", bTag],["col", String(colTag)],["status", status]];
    const body: any = { title: t.title, note: t.note || "", dueISO: t.dueISO, completedAt: t.completedAt, completedBy: t.completedBy, recurrence: t.recurrence, hiddenUntilISO: t.hiddenUntilISO, createdBy: t.createdBy, order: t.order, streak: t.streak, seriesId: t.seriesId };
    body.dueTimeEnabled = typeof t.dueTimeEnabled === 'boolean' ? t.dueTimeEnabled : null;
    body.reminders = Array.isArray(t.reminders) ? t.reminders : null;
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
          .forEach(t => { maybePublishTask(t, updated!, { skipBoardMetadata: true }).catch(() => {}); });
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
      if (kindTag === "week")
        return {
          id: b.id,
          name: nm,
          nostr: b.nostr,
          kind: "week",
          archived: b.archived,
          hidden: b.hidden,
        } as Board;
      if (kindTag === "lists") {
        const cols: ListColumn[] = Array.isArray(payload.columns) ? payload.columns : (b.kind === "lists" ? b.columns : [{ id: crypto.randomUUID(), name: "Items" }]);
        return {
          id: b.id,
          name: nm,
          nostr: b.nostr,
          kind: "lists",
          columns: cols,
          archived: b.archived,
          hidden: b.hidden,
        } as Board;
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
    const hasDueTimeField = Object.prototype.hasOwnProperty.call(payload, 'dueTimeEnabled');
    const incomingDueTime = hasDueTimeField
      ? (payload.dueTimeEnabled === null ? undefined : typeof payload.dueTimeEnabled === 'boolean' ? payload.dueTimeEnabled : undefined)
      : undefined;
    const hasRemindersField = Object.prototype.hasOwnProperty.call(payload, 'reminders');
    let incomingReminders: ReminderPreset[] | undefined;
    if (hasRemindersField) {
      if (payload.reminders === null) incomingReminders = [];
      else if (Array.isArray(payload.reminders)) incomingReminders = sanitizeReminderList(payload.reminders) ?? [];
      else incomingReminders = [];
    }
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
    if (hasDueTimeField) base.dueTimeEnabled = incomingDueTime;
    if (hasRemindersField) base.reminders = incomingReminders;
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

  async function syncRemindersToWorker(push: PushPreferences, reminderTasks: Task[], options?: { signal?: AbortSignal }) {
    if (!WORKER_BASE_URL) throw new Error('Set VITE_WORKER_BASE_URL to enable push notifications');
    if (!push.deviceId || !push.subscriptionId) return;
    const remindersPayload = reminderTasks
      .map((task) => ({
        taskId: task.id,
        boardId: task.boardId,
        dueISO: task.dueISO,
        title: task.title,
        minutesBefore: (task.reminders ?? []).map(reminderPresetToMinutes).sort((a, b) => a - b),
      }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId));
    const res = await fetch(`${WORKER_BASE_URL}/api/reminders`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: push.deviceId,
        subscriptionId: push.subscriptionId,
        reminders: remindersPayload,
      }),
      signal: options?.signal,
    });
    if (!res.ok) {
      throw new Error(`Failed to sync reminders (${res.status})`);
    }
  }

  async function enablePushNotifications(platform: PushPlatform): Promise<void> {
    if (pushWorkState === 'enabling') return;
    setPushWorkState('enabling');
    setPushError(null);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('Push notifications are not supported on this device.');
      }
      if (!VAPID_PUBLIC_KEY) {
        throw new Error('Missing VAPID public key (VITE_VAPID_PUBLIC_KEY).');
      }
      if (!WORKER_BASE_URL) {
        throw new Error('Missing worker base URL (VITE_WORKER_BASE_URL).');
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Notifications permission was not granted.');
      }

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }

      const deviceId = settings.pushNotifications.deviceId || crypto.randomUUID();
      const subscriptionJson = subscription.toJSON();

      const res = await fetch(`${WORKER_BASE_URL}/api/devices`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          platform,
          subscription: subscriptionJson,
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to register device (${res.status})`);
      }
      let subscriptionId: string | undefined;
      try {
        const data = await res.json();
        if (data && typeof data.subscriptionId === 'string') subscriptionId = data.subscriptionId;
      } catch {}

      const updated: PushPreferences = {
        ...settings.pushNotifications,
        enabled: true,
        platform,
        deviceId,
        subscriptionId,
        permission,
      };

      const reminderTasks = tasks.filter(taskHasReminders);
      const remindersPayloadString = JSON.stringify(
        reminderTasks
          .map((task) => ({
            taskId: task.id,
            boardId: task.boardId,
            dueISO: task.dueISO,
            title: task.title,
            minutesBefore: (task.reminders ?? []).map(reminderPresetToMinutes).sort((a, b) => a - b),
          }))
          .sort((a, b) => a.taskId.localeCompare(b.taskId)),
      );
      reminderPayloadRef.current = remindersPayloadString;
      await syncRemindersToWorker(updated, reminderTasks);

      setSettings({ pushNotifications: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to enable push notifications';
      setPushError(message);
      if (typeof Notification !== 'undefined') {
        setSettings({ pushNotifications: { ...settings.pushNotifications, permission: Notification.permission } });
      }
      throw err;
    } finally {
      setPushWorkState('idle');
    }
  }

  async function disablePushNotifications(): Promise<void> {
    if (pushWorkState === 'disabling') return;
    setPushWorkState('disabling');
    setPushError(null);
    try {
      if ('serviceWorker' in navigator) {
        try {
          const registration = await navigator.serviceWorker.ready;
          const subscription = await registration.pushManager.getSubscription();
          if (subscription) await subscription.unsubscribe();
        } catch {}
      }

      if (WORKER_BASE_URL && settings.pushNotifications.deviceId) {
        try {
          await fetch(`${WORKER_BASE_URL}/api/devices/${settings.pushNotifications.deviceId}`, {
            method: 'DELETE',
          });
        } catch {}
      }

      setSettings({
        pushNotifications: {
          ...settings.pushNotifications,
          enabled: false,
          subscriptionId: undefined,
          permission: (typeof Notification !== 'undefined' ? Notification.permission : settings.pushNotifications.permission),
        },
      });
      reminderPayloadRef.current = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to disable push notifications';
      setPushError(message);
      if (typeof Notification !== 'undefined') {
        setSettings({ pushNotifications: { ...settings.pushNotifications, permission: Notification.permission } });
      }
      throw err;
    } finally {
      setPushWorkState('idle');
    }
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

<<<<<<< Updated upstream
=======
  function buildImportedTask(raw: string, overrides: Partial<Task> = {}): Task | null {
    if (!currentBoard) return null;
    try {
      const parsed: any = JSON.parse(raw);
      if (!(parsed && typeof parsed === "object" && parsed.title && parsed.dueISO)) return null;
      const nextOrder = nextOrderForBoard(currentBoard.id, tasks);
      const id = crypto.randomUUID();
      const dueISO = typeof parsed.dueISO === 'string' ? parsed.dueISO : new Date().toISOString();
      const dueTimeEnabled = typeof parsed.dueTimeEnabled === 'boolean' ? parsed.dueTimeEnabled : undefined;
      const reminders = sanitizeReminderList(parsed.reminders);
      const imported: Task = {
        ...parsed,
        id,
        boardId: currentBoard.id,
        order: typeof parsed.order === "number" ? parsed.order : nextOrder,
        dueISO,
        ...(typeof dueTimeEnabled === 'boolean' ? { dueTimeEnabled } : {}),
        ...(reminders !== undefined ? { reminders } : {}),
        ...overrides,
      };
      if (imported.recurrence) imported.seriesId = imported.seriesId || id;
      else imported.seriesId = undefined;
      return imported;
    } catch {
      return null;
    }
  }

>>>>>>> Stashed changes
  function addTask(keepKeyboard = false) {
    if (!currentBoard) return;

    const originRect = newTitleRef.current?.getBoundingClientRect() || null;

    const raw = newTitle.trim();
    if (raw) {
<<<<<<< Updated upstream
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
          animateTaskArrival(originRect, imported, currentBoard);
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
=======
      const imported = buildImportedTask(raw);
      if (imported) {
        applyHiddenForFuture(imported);
        animateTaskArrival(originRect, imported, currentBoard);
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
        setScheduleTime("");
        if (keepKeyboard) newTitleRef.current?.focus();
        else newTitleRef.current?.blur();
        return;
      }
>>>>>>> Stashed changes
    }

    const title = raw || (newImages.length ? "Image" : "");
    if ((!title && !newImages.length)) return;

    const candidate = resolveQuickRule();
    const recurrence = candidate.type === "none" ? undefined : candidate;
    let dueISO = isoForWeekday(0);
    let dueTimeFlag = false;
    if (scheduleDate) {
      const hasTime = !!scheduleTime;
      dueTimeFlag = hasTime;
      dueISO = isoFromDateTime(scheduleDate, hasTime ? scheduleTime : undefined);
    } else if (currentBoard?.kind === "week" && dayChoice !== "bounties") {
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
    if (dueTimeFlag) t.dueTimeEnabled = true;
    if (newImages.length) t.images = newImages;
    if (currentBoard?.kind === "week") {
      t.column = dayChoice === "bounties" ? "bounties" : "day";
    } else {
      // lists board
      const firstCol = currentBoard.columns[0];
      const selectedColId = typeof dayChoice === "string" ? dayChoice : firstCol?.id;
      t.columnId = selectedColId || firstCol?.id;
    }
    applyHiddenForFuture(t);
    animateTaskArrival(originRect, t, currentBoard);
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
    setScheduleTime("");
    if (keepKeyboard) newTitleRef.current?.focus();
    else newTitleRef.current?.blur();
  }

  function addInlineTask(key: string) {
    if (!currentBoard) return;
    const raw = (inlineTitles[key] || "").trim();
    if (!raw) return;

    const originRect = inlineInputRefs.current.get(key)?.getBoundingClientRect() || null;
    const inlineOverrides: Partial<Task> = { createdBy: nostrPK || undefined };

    if (currentBoard?.kind === "week") {
      if (key === "bounties") {
        inlineOverrides.column = "bounties";
        inlineOverrides.columnId = undefined;
      } else {
        inlineOverrides.column = "day";
        inlineOverrides.columnId = undefined;
        inlineOverrides.dueISO = isoForWeekday(Number(key) as Weekday);
      }
    } else {
      inlineOverrides.columnId = key;
      inlineOverrides.column = undefined;
    }

    const imported = buildImportedTask(raw, inlineOverrides);
    if (imported) {
      applyHiddenForFuture(imported);
      animateTaskArrival(originRect, imported, currentBoard);
      setTasks(prev => {
        const out = [...prev, imported];
        return settings.showFullWeekRecurring && imported.recurrence ? ensureWeekRecurrences(out, [imported]) : out;
      });
      maybePublishTask(imported).catch(() => {});
      setInlineTitles(prev => ({ ...prev, [key]: "" }));
      return;
    }

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
    if (currentBoard?.kind === "week") {
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
    animateTaskArrival(originRect, t, currentBoard);
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
      if (beforeId && beforeId === task.id) return prev;

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
    if (currentBoard?.kind === "lists") {
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

  const currentTutorial = tutorialStep != null ? tutorialSteps[tutorialStep] : null;
  const totalTutorialSteps = tutorialSteps.length;

  return (
    <div className="min-h-screen px-4 py-4 sm:px-6 lg:px-8 text-primary">
      <div className="mx-auto max-w-7xl space-y-5">
        {/* Header */}
        <header className="relative space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1 justify-end -translate-y-[2px]">
              <h1 className="text-3xl font-semibold tracking-tight">
                Taskify
              </h1>
              <div
                ref={boardDropContainerRef}
                className="relative min-w-0 sm:min-w-[12rem]"
                style={{ maxWidth: 'min(28rem, calc(100vw - 7.5rem))' }}
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
                  className="pill-select w-full min-w-0 truncate sm:w-auto sm:min-w-[12rem]"
                  style={{ textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title="Boards"
                >
                  {visibleBoards.length === 0 ? (
                    <option value="">No boards</option>
                  ) : (
                    visibleBoards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)
                  )}
                </select>
                {boardDropOpen && boardDropPos &&
                  createPortal(
                    <div
                      ref={boardDropListRef}
                      className="glass-panel fixed z-50 w-56 p-2"
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
                      {visibleBoards.length === 0 ? (
                        <div className="rounded-xl px-3 py-2 text-sm text-secondary">
                          No boards
                        </div>
                      ) : (
                        visibleBoards.map(b => (
                          <div
                            key={b.id}
                            className="rounded-xl px-3 py-2 text-primary hover:bg-surface-muted"
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
                        ))
                      )}
                    </div>,
                    document.body
                  )}
              </div>
            </div>
            <div className="ml-auto">
              <div className="control-matrix glass-panel">
                <button
                  className="control-matrix__btn pressable"
                  onClick={() => setNostrRefresh(n => n + 1)}
                  title="Refresh shared board"
                  aria-label="Refresh shared board"
                  disabled={!currentBoard?.nostr?.boardId}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-[18px] w-[18px]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0114.13-3.36L23 10" />
                    <path d="M20.49 15a9 9 0 01-14.13 3.36L1 14" />
                  </svg>
                </button>
                <button
                  className="control-matrix__btn pressable"
                  onClick={() => setShowSettings(true)}
                  title="Settings"
                  aria-label="Open settings"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-[18px] w-[18px]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="#fff"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2h-.34a2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2h.34a2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
                <button
                  ref={walletButtonRef}
                  className="control-matrix__btn pressable"
                  onClick={() => setShowWallet(true)}
                  title="Wallet"
                  aria-label="Open Cashu wallet"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-[18px] w-[18px]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="#fff"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="4" x2="12" y2="20" />
                    <line x1="8" y1="8" x2="16" y2="8" />
                    <line x1="7" y1="12" x2="17" y2="12" />
                    <line x1="8" y1="16" x2="16" y2="16" />
                    <line x1="12" y1="2.75" x2="12" y2="5.25" />
                    <line x1="12" y1="18.75" x2="12" y2="21.25" />
                  </svg>
                </button>
                {settings.completedTab ? (
                  <button
                    ref={completedTabRef}
                    className="control-matrix__btn pressable"
                    data-active={view === "completed"}
                    onClick={() => setView((prev) => (prev === "completed" ? "board" : "completed"))}
                    aria-pressed={view === "completed"}
                    aria-label={view === "completed" ? "Show board" : "Show completed tasks"}
                    title={view === "completed" ? "Show board" : "Show completed tasks"}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-[18px] w-[18px]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="#fff"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M6 12.5l3.75 3.75L18 8.5" />
                    </svg>
                  </button>
                ) : (
                  <button
                    ref={completedTabRef}
                    className="control-matrix__btn pressable"
                    onClick={clearCompleted}
                    disabled={completed.length === 0}
                    aria-label="Clear completed tasks"
                    title="Clear completed tasks"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-[18px] w-[18px]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 6h16" />
                      <path d="M6 6v12a1 1 0 001 1h10a1 1 0 001-1V6" />
                      <path d="M9 6V4h6v2" />
                      <path d="M10 11l4 4" />
                      <path d="M14 11l-4 4" />
                    </svg>
                  </button>
                )}
              </div>
              {!settings.completedTab && (
                <button
                  className="ghost-button button-sm pressable mt-2 w-full disabled:opacity-50"
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
          <div className="glass-panel flex flex-wrap gap-2 items-center w-full p-3 mb-4">
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
              className="pill-input pill-input--compact flex-1 min-w-0"
            />
            <button
              ref={addButtonRef}
              onClick={() => addTask()}
              className="accent-button accent-button--circle pressable shrink-0"
              type="button"
              aria-label="Add task"
            >
              <span aria-hidden="true">+</span>
              <span className="sr-only">Add task</span>
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
              {currentBoard?.kind === "week" ? (
                <select
                  value={dayChoice === "bounties" ? "bounties" : String(dayChoice)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDayChoice(v === "bounties" ? "bounties" : (Number(v) as Weekday));
                    setScheduleDate("");
                    setScheduleTime("");
                  }}
                  className="pill-select flex-1 min-w-0 truncate"
                >
                  {WD_SHORT.map((d,i)=>(<option key={i} value={i}>{d}</option>))}
                  <option value="bounties">Bounties</option>
                </select>
              ) : (
                <select
                  value={String(dayChoice)}
                  onChange={(e)=>setDayChoice(e.target.value)}
                  className="pill-select flex-1 min-w-0 truncate"
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
                className="pill-select shrink-0 w-fit"
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
                <span className="flex-shrink-0 text-xs text-secondary">({labelOf(addCustomRule)})</span>
              )}
            </div>
          </div>
        )}

        {/* Board/Completed */}
        <div className="relative">
          {view === "board" || !settings.completedTab ? (
            !currentBoard ? (
              <div className="surface-panel p-6 text-center text-sm text-secondary">No boards. Open Settings to create one.</div>
            ) : currentBoard?.kind === "week" ? (
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
                      ref={el => setColumnRef(`week-day-${day}`, el)}
                      key={day}
                      title={WD_SHORT[day]}
                      onTitleClick={() => { setDayChoice(day); setScheduleDate(""); setScheduleTime(""); }}
                      onDropCard={(payload) => moveTask(payload.id, { type: "day", day }, payload.beforeId)}
                      onDropEnd={handleDragEnd}
                      data-day={day}
                      scrollable={settings.inlineAdd}
                      footer={settings.inlineAdd ? (
                        <form
                          className="mt-2 flex gap-1"
                          onSubmit={(e) => { e.preventDefault(); addInlineTask(String(day)); }}
                        >
                          <input
                            ref={el => setInlineInputRef(String(day), el)}
                            value={inlineTitles[String(day)] || ""}
                            onChange={(e) => setInlineTitles(prev => ({ ...prev, [String(day)]: e.target.value }))}
                            className="pill-input pill-input--compact flex-1 min-w-0"
                            placeholder="Add task"
                          />
                          <button
                            type="submit"
                            className="accent-button accent-button--circle pressable shrink-0"
                            aria-label="Add task"
                          >
                            <span aria-hidden="true">+</span>
                            <span className="sr-only">Add task</span>
                          </button>
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
                          hideCompletedSubtasks={settings.hideCompletedSubtasks}
                        />
                      ))}
                    </DroppableColumn>
                  ))}

                  {/* Bounties */}
                  <DroppableColumn
                    ref={el => setColumnRef("week-bounties", el)}
                    title="Bounties"
                    onTitleClick={() => { setDayChoice("bounties"); setScheduleDate(""); setScheduleTime(""); }}
                    onDropCard={(payload) => moveTask(payload.id, { type: "bounties" }, payload.beforeId)}
                    onDropEnd={handleDragEnd}
                    scrollable={settings.inlineAdd}
                    footer={settings.inlineAdd ? (
                      <form
                        className="mt-2 flex gap-1"
                        onSubmit={(e) => { e.preventDefault(); addInlineTask("bounties"); }}
                      >
                          <input
                            ref={el => setInlineInputRef("bounties", el)}
                            value={inlineTitles["bounties"] || ""}
                            onChange={(e) => setInlineTitles(prev => ({ ...prev, bounties: e.target.value }))}
                            className="pill-input pill-input--compact flex-1 min-w-0"
                            placeholder="Add task"
                          />
                          <button
                            type="submit"
                            className="accent-button accent-button--circle pressable shrink-0"
                            aria-label="Add task"
                          >
                            <span aria-hidden="true">+</span>
                            <span className="sr-only">Add task</span>
                          </button>
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
                          hideCompletedSubtasks={settings.hideCompletedSubtasks}
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
                    ref={el => setColumnRef(`list-${col.id}`, el)}
                    key={col.id}
                    title={col.name}
                    onTitleClick={() => setDayChoice(col.id)}
                    onDropCard={(payload) => moveTask(payload.id, { type: "list", columnId: col.id }, payload.beforeId)}
                    onDropEnd={handleDragEnd}
                    scrollable={settings.inlineAdd}
                    footer={settings.inlineAdd ? (
                      <form
                        className="mt-2 flex gap-1"
                        onSubmit={(e) => { e.preventDefault(); addInlineTask(col.id); }}
                      >
                          <input
                            ref={el => setInlineInputRef(col.id, el)}
                            value={inlineTitles[col.id] || ""}
                            onChange={(e) => setInlineTitles(prev => ({ ...prev, [col.id]: e.target.value }))}
                            className="pill-input pill-input--compact flex-1 min-w-0"
                            placeholder="Add task"
                          />
                          <button
                            type="submit"
                            className="accent-button accent-button--circle pressable shrink-0"
                            aria-label="Add task"
                          >
                            <span aria-hidden="true">+</span>
                            <span className="sr-only">Add task</span>
                          </button>
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
                          hideCompletedSubtasks={settings.hideCompletedSubtasks}
                        />
                    ))}
                  </DroppableColumn>
                ))}
              </div>
            </div>
          )
        ) : (
          // Completed view
          <div className="surface-panel board-column p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="text-lg font-semibold">Completed</div>
              <div className="ml-auto">
                <button
                  className="ghost-button button-sm pressable text-rose-400"
                  onClick={clearCompleted}
                >
                  Clear completed
                </button>
              </div>
            </div>
            {completed.length === 0 ? (
              <div className="text-secondary text-sm">No completed tasks yet.</div>
            ) : (
              <ul className="space-y-1.5">
                {completed.map((t) => {
                  const hasDetail = !!t.note?.trim() || (t.images && t.images.length > 0) || (t.subtasks && t.subtasks.length > 0) || !!t.bounty;
                  return (
                    <li key={t.id} className="task-card space-y-2" data-state="completed" data-form={hasDetail ? 'stacked' : 'pill'}>
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          <div className="text-sm font-medium leading-[1.15]">
                            {renderTitleWithLink(t.title, t.note)}
                          </div>
                          <div className="text-xs text-secondary">
                            {currentBoard?.kind === "week"
                              ? `Scheduled ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}${t.dueTimeEnabled ? ` at ${formatTimeLabel(t.dueISO)}` : ""}`
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
                            <ul className="mt-1 space-y-1 text-xs">
                              {t.subtasks.map(st => (
                                <li key={st.id} className="subtask-row">
                                  <input type="checkbox" checked={!!st.completed} disabled className="subtask-row__checkbox" />
                                  <span className={`subtask-row__text ${st.completed ? 'line-through text-secondary' : ''}`}>{st.title}</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {t.bounty && (
                            <div className="mt-1">
                              <span className={`text-[0.6875rem] px-2 py-0.5 rounded-full border ${t.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : t.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : t.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-surface-muted border-surface'}`}>
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
                  );
                })}
              </ul>
            )}
          </div>
        )}
        </div>
      </div>

      {/* Floating Upcoming Drawer Button */}
      <button
        ref={upcomingButtonRef}
        className={`fixed bottom-20 right-4 px-3 py-2 rounded-full bg-surface-muted border border-surface shadow-lg text-sm transition-transform ${upcomingHover ? 'scale-110' : ''}`}
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
            <div className="text-sm text-secondary">No upcoming tasks.</div>
          ) : (
            <ul className="space-y-1.5">
              {upcoming.map((t) => {
                const visibleSubtasks = settings.hideCompletedSubtasks
                  ? (t.subtasks?.filter((st) => !st.completed) ?? [])
                  : (t.subtasks ?? []);
                return (
                  <li key={t.id} className="task-card space-y-2" data-form="stacked">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <div className="text-sm font-medium leading-[1.15]">{renderTitleWithLink(t.title, t.note)}</div>
                      <div className="text-xs text-secondary">
                        {currentBoard?.kind === "week"
                          ? `Scheduled ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}${t.dueTimeEnabled ? ` at ${formatTimeLabel(t.dueISO)}` : ""}`
                          : "Hidden item"}
                        {t.hiddenUntilISO ? ` • Reveals ${new Date(t.hiddenUntilISO).toLocaleDateString()}` : ""}
                      </div>
                      <TaskMedia task={t} />
                      {visibleSubtasks.length ? (
                        <ul className="mt-1 space-y-1 text-xs">
                          {visibleSubtasks.map(st => (
                            <li key={st.id} className="subtask-row">
                              <input type="checkbox" checked={!!st.completed} disabled className="subtask-row__checkbox" />
                              <span className={`subtask-row__text ${st.completed ? 'line-through text-secondary' : ''}`}>{st.title}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="accent-button button-sm pressable"
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
                      className="ghost-button button-sm pressable"
                      onClick={() => { setEditing(t); setShowUpcoming(false); }}
                    >
                      Edit
                    </button>
                    <button
                      className="ghost-button button-sm pressable text-rose-400"
                      onClick={() => deleteTask(t.id)}
                    >
                      Delete
                    </button>
                  </div>
                  </li>
                );
              })}
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
            className={`w-14 h-14 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-secondary transition-transform ${trashHover ? 'scale-110' : ''}`}
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
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-surface-muted border border-surface text-sm px-4 py-2 rounded-xl shadow-lg flex items-center gap-3">
          Task deleted
          <button onClick={undoDelete} className="accent-button button-sm pressable">Undo</button>
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

      {tutorialStep !== null && currentTutorial && (
        <Modal
          onClose={handleSkipTutorial}
          title={currentTutorial.title}
          showClose={false}
        >
          <div className="space-y-4">
            <div className="text-xs uppercase tracking-wide text-secondary">
              Step {tutorialStep + 1} of {totalTutorialSteps}
            </div>
            {currentTutorial.body}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <button
                className="ghost-button button-sm pressable"
                onClick={handleSkipTutorial}
              >
                Skip tutorial
              </button>
              <div className="flex gap-2">
                {tutorialStep > 0 && (
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={handlePrevTutorial}
                  >
                    Back
                  </button>
                )}
                <button
                  className="accent-button button-sm pressable"
                  onClick={handleNextTutorial}
                >
                  {tutorialStep === totalTutorialSteps - 1 ? "Finish" : "Next"}
                </button>
              </div>
            </div>
          </div>
        </Modal>
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
          onRestartTutorial={handleRestartTutorial}
          pushWorkState={pushWorkState}
          pushError={pushError}
          onEnablePush={enablePushNotifications}
          onDisablePush={disablePushNotifications}
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
                  maybePublishTask(t, nb, { skipBoardMetadata: true }).catch(() => {});
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
            const newBoard: Board = {
              id,
              name: name || "Shared Board",
              kind: "lists",
              columns: defaultCols,
              nostr: { boardId: id, relays: relays.length ? relays : defaultRelays },
              archived: false,
              hidden: false,
            };
            setBoards(prev => [...prev, newBoard]);
            setCurrentBoardId(id);
          }}
          onRegenerateBoardId={regenerateBoardId}
          onBoardChanged={(boardId, options) => {
            const board = boards.find(x => x.id === boardId);
            if (!board) return;
            publishBoardMetadata(board).catch(() => {});
            if (options?.republishTasks) {
              tasks
                .filter(t => t.boardId === boardId)
                .forEach(t => {
                  maybePublishTask(t, board, { skipBoardMetadata: true }).catch(() => {});
                });
            }
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Cashu Wallet */}
      {showWallet && (
        <CashuWalletModal
          open={showWallet}
          onClose={() => setShowWallet(false)}
          walletConversionEnabled={settings.walletConversionEnabled}
          walletPrimaryCurrency={settings.walletPrimaryCurrency}
          setWalletPrimaryCurrency={(currency) => setSettings({ walletPrimaryCurrency: currency })}
          npubCashLightningAddressEnabled={settings.npubCashLightningAddressEnabled}
          npubCashAutoClaim={settings.npubCashLightningAddressEnabled && settings.npubCashAutoClaim}
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
    <a href={url} target="_blank" rel="noopener noreferrer" className="link-accent">
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
          <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="link-accent break-words">
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
      className="mt-2 block w-full overflow-hidden rounded-2xl border border-surface bg-surface-muted"
    >
      {data.image && <img src={data.image} className="w-full h-40 object-cover" />}
      <div className="space-y-1 p-3 text-xs text-secondary">
        <div className="truncate font-medium text-primary">{data.title}</div>
        {data.description && (
          <div
            className="text-tertiary overflow-hidden text-ellipsis"
            style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
          >
            {data.description}
          </div>
        )}
      </div>
    </a>
  );
}

function TaskMedia({ task, indent = false }: { task: Task; indent?: boolean }) {
  const noteText = task.note?.replace(/https?:\/\/[^\s)]+/gi, "").trim();
  const hasImages = !!(task.images && task.images.length);
  const previewSource = `${task.title} ${task.note || ""}`;
  const hasUrl = /https?:\/\//i.test(previewSource);
  if (!noteText && !hasImages && !hasUrl) return null;
  const wrapperClasses = `${indent ? "task-card__details " : ""}space-y-1.5 mt-2`;
  return (
    <div className={wrapperClasses}>
      {noteText && (
        <div
          className="text-xs text-secondary break-words"
          style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {autolink(noteText)}
        </div>
      )}
      {hasImages ? (
        <div className="space-y-2">
          {task.images!.map((img, i) => (
            <img key={i} src={img} className="max-h-40 w-full rounded-2xl object-contain" />
          ))}
        </div>
      ) : null}
      {hasUrl && <UrlPreview text={previewSource} />}
    </div>
  );
}

// Column container (fixed width for consistent horizontal scroll)
const DroppableColumn = React.forwardRef<HTMLDivElement, {
  title: string;
  onDropCard: (payload: { id: string; beforeId?: string }) => void;
  onDropEnd?: () => void;
  onTitleClick?: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  scrollable?: boolean;
} & React.HTMLAttributes<HTMLDivElement>>((
  {
    title,
    onDropCard,
    onDropEnd,
    onTitleClick,
    children,
    footer,
    scrollable,
    className,
    ...props
  },
  forwardedRef
) => {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const setRef = useCallback((el: HTMLDivElement | null) => {
    innerRef.current = el;
    if (!forwardedRef) return;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  }, [forwardedRef]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const isTaskDrag = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      return Array.from(types).includes("text/task-id");
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer?.getData("text/task-id");
      if (id) {
        let beforeId: string | undefined;
        const columnEl = innerRef.current;
        if (columnEl) {
          const cards = Array.from(
            columnEl.querySelectorAll<HTMLElement>("[data-task-id]")
          );
          const pointerY = e.clientY;
          for (const card of cards) {
            const rect = card.getBoundingClientRect();
            if (pointerY < rect.top + rect.height / 2) {
              beforeId = card.dataset.taskId || undefined;
              break;
            }
          }
        }
        onDropCard({ id, beforeId });
      }
      if (onDropEnd) onDropEnd();
      dragDepthRef.current = 0;
      setIsDragOver(false);
    };
    const onDragEnter = (e: DragEvent) => {
      if (!isTaskDrag(e)) return;
      dragDepthRef.current += 1;
      setIsDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isTaskDrag(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDragOver(false);
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragleave", onDragLeave);
    const resetDragState = () => {
      dragDepthRef.current = 0;
      setIsDragOver(false);
    };
    document.addEventListener("dragend", resetDragState);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragenter", onDragEnter);
      el.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragend", resetDragState);
    };
  }, [onDropCard, onDropEnd]);

  return (
    <div
      ref={setRef}
      data-column-title={title}
      data-drop-over={isDragOver || undefined}
      className={`board-column surface-panel w-[325px] shrink-0 p-2 ${scrollable ? 'flex h-[calc(100vh-15rem)] flex-col overflow-hidden' : 'min-h-[320px]'} ${isDragOver ? 'board-column--active' : ''} ${className ?? ''}`}
      // No touchAction lock so horizontal scrolling stays fluid
      {...props}
    >
      <div
        className={`mb-3 text-sm font-semibold tracking-wide text-secondary ${onTitleClick ? 'cursor-pointer hover:text-primary transition-colors' : ''}`}
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
      <div className={scrollable ? 'flex-1 min-h-0 overflow-y-auto pr-1' : ''}>
        <div className="space-y-.25">{children}</div>
      </div>
      {scrollable && footer ? <div className="mt-auto flex-shrink-0 pt-2">{footer}</div> : null}
      {!scrollable && footer}
    </div>
  );
});

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
  hideCompletedSubtasks,
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
  hideCompletedSubtasks: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const [overBefore, setOverBefore] = useState(false);
  const [isStacked, setIsStacked] = useState(false);
  const iconSizeStyle = useMemo(() => ({ '--icon-size': '1.85rem' } as React.CSSProperties), []);
  const visibleSubtasks = useMemo(() => (
    hideCompletedSubtasks
      ? (task.subtasks?.filter((st) => !st.completed) ?? [])
      : (task.subtasks ?? [])
  ), [hideCompletedSubtasks, task.subtasks]);
  const hasDetail = !!task.note?.trim() || (task.images && task.images.length > 0) || (visibleSubtasks.length > 0) || !!task.bounty;

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;

    let raf = 0;
    const compute = () => {
      const styles = window.getComputedStyle(el);
      const lineHeight = parseFloat(styles.lineHeight || '0');
      if (!lineHeight) {
        setIsStacked(false);
        return;
      }
      const lines = Math.round(el.scrollHeight / lineHeight);
      setIsStacked(lines > 1);
    };

    compute();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(compute);
      });
      observer.observe(el);
    }

    window.addEventListener('resize', compute);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', compute);
      cancelAnimationFrame(raf);
    };
  }, [task.title, task.note, task.images?.length, visibleSubtasks.length]);

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData('text/task-id', task.id);
    e.dataTransfer.effectAllowed = 'move';
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
    e.stopPropagation();
    const dragId = e.dataTransfer.getData('text/task-id');
    if (dragId && dragId !== task.id) onDropBefore(dragId);
    setOverBefore(false);
    onDragEnd();
  }
  function handleDragLeave() {
    setOverBefore(false);
  }
  function handleDragEnd() {
    onDragEnd();
  }

  function handleCompleteClick(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    if (!task.completed) {
      try { onFlyToCompleted(rect); } catch {}
    }
    onComplete(rect);
  }

  const bountyClass = task.bounty
    ? task.bounty.state === 'unlocked'
      ? 'chip chip-accent'
      : task.bounty.state === 'revoked'
        ? 'chip chip-danger'
        : task.bounty.state === 'claimed'
          ? 'chip chip-warn'
          : 'chip'
    : '';

  const stackedForm = isStacked || hasDetail;

  return (
    <div
      ref={cardRef}
      className="task-card group relative select-none"
      data-task-id={task.id}
      data-state={task.completed ? 'completed' : undefined}
      data-form={stackedForm ? 'stacked' : 'pill'}
      style={{ touchAction: 'auto' }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {overBefore && (
        <div
          className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full"
          style={{ background: 'var(--accent)' }}
        />
      )}

      <div className="flex items-start gap-3">
        <button
          onClick={handleCompleteClick}
          aria-label={task.completed ? 'Mark incomplete' : 'Complete task'}
          title={task.completed ? 'Mark incomplete' : 'Mark complete'}
          className="icon-button pressable flex-shrink-0"
          style={iconSizeStyle}
          data-active={task.completed}
        >
          {task.completed && (
            <svg width="18" height="18" viewBox="0 0 24 24" className="pointer-events-none">
              <path
                d="M20.285 6.707l-10.09 10.09-4.48-4.48"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>

        <div className="flex-1 min-w-0 cursor-pointer space-y-1" onClick={onEdit}>
          <div
            ref={titleRef}
            className={`task-card__title ${task.completed ? 'task-card__title--done' : ''}`}
          >
            {renderTitleWithLink(task.title, task.note)}
          </div>
          {showStreaks &&
            task.recurrence &&
            (task.recurrence.type === 'daily' || task.recurrence.type === 'weekly') &&
            typeof task.streak === 'number' && task.streak > 0 && (
              <div className="flex items-center gap-1 text-xs text-secondary">
                <span role="img" aria-hidden>
                  🔥
                </span>
                <span>{task.streak}</span>
              </div>
            )}
          {task.dueTimeEnabled && (
            <div className="text-xs text-secondary">
              Due at {formatTimeLabel(task.dueISO)}
            </div>
          )}
        </div>
      </div>

      <TaskMedia task={task} indent />

      {visibleSubtasks.length ? (
        <ul className="task-card__details mt-2 space-y-1.5 text-xs text-secondary">
          {visibleSubtasks.map((st) => (
            <li key={st.id} className="subtask-row">
              <input
                type="checkbox"
                checked={!!st.completed}
                onChange={() => onToggleSubtask(st.id)}
                className="subtask-row__checkbox"
              />
              <span className={`subtask-row__text ${st.completed ? 'line-through text-tertiary' : 'text-secondary'}`}>{st.title}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {task.completed && task.bounty && task.bounty.state !== 'claimed' && (
        <div className="task-card__details mt-2 text-xs text-secondary">
          {task.bounty.state === 'unlocked' ? 'Bounty unlocked!' : 'Complete! - Unlock bounty'}
        </div>
      )}

      {task.bounty && (
        <div className="task-card__details mt-2">
          <span className={bountyClass}>
            Bounty {typeof task.bounty.amount === 'number' ? `• ${task.bounty.amount} sats` : ''} • {task.bounty.state}
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
  const cls = `icon-button pressable ${intent === 'danger' ? 'icon-button--danger' : intent === 'success' ? 'icon-button--success' : ''}`;
  const style = { '--icon-size': '2.35rem' } as React.CSSProperties;
  return (
    <button
      ref={buttonRef}
      aria-label={label}
      title={label}
      className={cls}
      style={style}
      onClick={onClick}
    >
      {children}
    </button>
  );
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
  const dragSubtaskIdRef = useRef<string | null>(null);
  const [rule, setRule] = useState<Recurrence>(task.recurrence ?? R_NONE);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const initialDate = isoDatePart(task.dueISO);
  const initialTime = isoTimePart(task.dueISO);
  const defaultHasTime = task.dueTimeEnabled ?? false;
  const [hasDueTime, setHasDueTime] = useState<boolean>(defaultHasTime);
  const [scheduledDate, setScheduledDate] = useState(initialDate);
  const [scheduledTime, setScheduledTime] = useState<string>(initialTime);
  const [reminderSelection, setReminderSelection] = useState<ReminderPreset[]>(task.reminders ?? []);
  const [bountyAmount, setBountyAmount] = useState<number | "">(task.bounty?.amount ?? "");
  const [, setBountyState] = useState<Task["bounty"]["state"]>(task.bounty?.state || "locked");
  const [encryptWhenAttach, setEncryptWhenAttach] = useState(true);
  const { createSendToken, receiveToken, mintUrl } = useCashu();
  const [lockToRecipient, setLockToRecipient] = useState(false);
  const [recipientInput, setRecipientInput] = useState("");

  useEffect(() => {
    if (!hasDueTime && reminderSelection.length) {
      setReminderSelection([]);
    }
  }, [hasDueTime, reminderSelection]);

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

  const reorderSubtasks = useCallback((sourceId: string, targetId: string | null, position: 'before' | 'after' = 'before') => {
    if (!sourceId || sourceId === targetId) return;
    setSubtasks(prev => {
      const sourceIndex = prev.findIndex(s => s.id === sourceId);
      if (sourceIndex === -1) return prev;
      const sourceItem = prev[sourceIndex];
      const remaining = prev.filter(s => s.id !== sourceId);
      if (!targetId) {
        return [...remaining, sourceItem];
      }
      const rawTargetIndex = prev.findIndex(s => s.id === targetId);
      if (rawTargetIndex === -1) return prev;
      let insertIndex = rawTargetIndex;
      if (sourceIndex < rawTargetIndex) insertIndex -= 1;
      if (position === 'after') insertIndex += 1;
      if (insertIndex < 0) insertIndex = 0;
      if (insertIndex > remaining.length) insertIndex = remaining.length;
      const next = [...remaining];
      next.splice(insertIndex, 0, sourceItem);
      return next;
    });
  }, [setSubtasks]);

  const handleSubtaskDragStart = useCallback((id: string) => (e: React.DragEvent<HTMLElement>) => {
    dragSubtaskIdRef.current = id;
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/subtask-id', id);
    } catch {}
  }, []);

  const handleSubtaskDragEnd = useCallback(() => {
    dragSubtaskIdRef.current = null;
  }, []);

  const handleSubtaskDragOver = useCallback((id: string | null) => (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragSubtaskIdRef.current) return;
    void id;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleSubtaskDrop = useCallback((id: string | null) => (e: React.DragEvent<HTMLDivElement>) => {
    const sourceHint = dragSubtaskIdRef.current || e.dataTransfer.getData('text/subtask-id');
    if (!sourceHint) return;
    e.preventDefault();
    e.stopPropagation();
    dragSubtaskIdRef.current = null;
    let position: 'before' | 'after' = 'before';
    if (id) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) position = 'after';
    } else {
      position = 'after';
    }
    reorderSubtasks(sourceHint, id, position);
  }, [reorderSubtasks]);

  function handleDueTimeToggle(next: boolean) {
    setHasDueTime(next);
    if (next && !scheduledTime) {
      if (initialTime) {
        setScheduledTime(initialTime);
      } else {
        const now = new Date();
        const fallback = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        setScheduledTime(fallback);
      }
    }
  }

  function toggleReminder(id: ReminderPreset) {
    setReminderSelection((prev) => {
      const exists = prev.includes(id);
      const next = exists ? prev.filter((item) => item !== id) : [...prev, id];
      return [...next].sort((a, b) => (REMINDER_MINUTES.get(a) ?? 0) - (REMINDER_MINUTES.get(b) ?? 0));
    });
  }

  function buildTask(overrides: Partial<Task> = {}): Task {
    const baseDate = scheduledDate || isoDatePart(task.dueISO);
    const hasTime = hasDueTime && !!scheduledTime;
    const dueISO = isoFromDateTime(baseDate, hasTime ? scheduledTime : undefined);
    const due = startOfDay(new Date(`${baseDate}T00:00`));
    const nowSow = startOfWeek(new Date(), weekStart);
    const dueSow = startOfWeek(due, weekStart);
    const hiddenUntilISO = dueSow.getTime() > nowSow.getTime() ? dueSow.toISOString() : undefined;
    const reminderValues = hasTime ? [...reminderSelection] : [];
    return {
      ...task,
      title,
      note: note || undefined,
      images: images.length ? images : undefined,
      subtasks: subtasks.length ? subtasks : undefined,
      recurrence: rule.type === "none" ? undefined : rule,
      dueISO,
      hiddenUntilISO,
      dueTimeEnabled: hasTime ? true : undefined,
      reminders: reminderValues,
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
          className="accent-button button-sm pressable"
          onClick={() => save()}
        >
          Save
        </button>
      }
    >
      <div className="space-y-4">
        <input value={title} onChange={e=>setTitle(e.target.value)}
               className="pill-input w-full" placeholder="Title"/>
        <textarea value={note} onChange={e=>setNote(e.target.value)} onPaste={handlePaste}
                  className="pill-textarea w-full" rows={3}
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

        <div
          onDragOver={handleSubtaskDragOver(null)}
          onDrop={handleSubtaskDrop(null)}
        >
          <div className="flex items-center mb-2">
            <label className="text-sm font-medium">Subtasks</label>
          </div>
          {subtasks.map((st) => (
            <div
              key={st.id}
              className="flex items-center gap-2 mb-1 cursor-grab active:cursor-grabbing"
              style={{ touchAction: 'auto' }}
              draggable
              onDragStart={handleSubtaskDragStart(st.id)}
              onDragEnd={handleSubtaskDragEnd}
              onDragOver={handleSubtaskDragOver(st.id)}
              onDrop={handleSubtaskDrop(st.id)}
            >
              <input
                type="checkbox"
                checked={!!st.completed}
                onChange={() => setSubtasks(prev => prev.map(s => s.id === st.id ? { ...s, completed: !s.completed } : s))}
               
              />
              <input
                className="pill-input flex-1 text-sm"
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
              className="pill-input flex-1 text-sm"
            />
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => addSubtask()}
            >
              Add
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="edit-schedule" className="block mb-1 text-sm font-medium">Scheduled for</label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              id="edit-schedule"
              type="date"
              value={scheduledDate}
              onChange={e=>setScheduledDate(e.target.value)}
              className="pill-input w-full sm:max-w-[13rem]"
              title="Scheduled date"
            />
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <label className="flex items-center gap-2 text-xs sm:text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={hasDueTime}
                  onChange={(e) => handleDueTimeToggle(e.target.checked)}
                />
                Add due time
              </label>
              <input
                type="time"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="pill-input w-full sm:w-auto sm:min-w-[8.5rem]"
                title="Scheduled time"
                disabled={!hasDueTime}
              />
            </div>
          </div>
        </div>

        <div className="wallet-section space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">Notifications</div>
            {reminderSelection.length > 0 && (
              <div className="ml-auto text-xs text-secondary">
                {reminderSelection.map((id) => REMINDER_PRESETS.find((opt) => opt.id === id)?.badge || id).join(', ')}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {REMINDER_PRESETS.map((opt) => {
              const active = reminderSelection.includes(opt.id);
              const cls = active ? 'accent-button button-sm pressable' : 'ghost-button button-sm pressable';
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={cls}
                  onClick={() => toggleReminder(opt.id)}
                  disabled={!hasDueTime}
                  title={opt.label}
                >
                  {opt.badge}
                </button>
              );
            })}
          </div>
          {!hasDueTime && (
            <div className="text-xs text-secondary">Set a due time to enable reminders.</div>
          )}
        </div>

        {/* Recurrence section */}
        <div className="wallet-section space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">Recurrence</div>
            <div className="ml-auto text-xs text-secondary">{labelOf(rule)}</div>
          </div>
          <div className="mt-2 flex gap-2 flex-wrap">
            <button className="ghost-button button-sm pressable" onClick={() => setRule(R_NONE)}>None</button>
            <button className="ghost-button button-sm pressable" onClick={() => setRule({ type: "daily" })}>Daily</button>
            <button className="ghost-button button-sm pressable" onClick={() => setRule({ type: "weekly", days: [1,2,3,4,5] })}>Mon–Fri</button>
            <button className="ghost-button button-sm pressable" onClick={() => setRule({ type: "weekly", days: [0,6] })}>Weekends</button>
            <button className="ghost-button button-sm pressable ml-auto" onClick={() => setShowAdvanced(true)} title="Advanced recurrence…">Advanced…</button>
          </div>
        </div>

        {/* Bounty (ecash) */}
        <div className="wallet-section space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">Bounty (ecash)</div>
            {task.bounty && (
              <div className="ml-auto flex items-center gap-2 text-[0.6875rem]">
                <span className={`px-2 py-0.5 rounded-full border ${task.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : task.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : task.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-surface-muted border-surface'}`}>{task.bounty.state}</span>
                {task.createdBy && (window as any).nostrPK === task.createdBy && <span className="px-2 py-0.5 rounded-full bg-surface-muted border border-surface" title="You created the task">owner: you</span>}
                {task.bounty.sender && (window as any).nostrPK === task.bounty.sender && <span className="px-2 py-0.5 rounded-full bg-surface-muted border border-surface" title="You funded the bounty">funder: you</span>}
                {task.bounty.receiver && (window as any).nostrPK === task.bounty.receiver && <span className="px-2 py-0.5 rounded-full bg-surface-muted border border-surface" title="You are the recipient">recipient: you</span>}
              </div>
            )}
          </div>
          {!task.bounty ? (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-2">
                <input type="number" min={1} value={bountyAmount as number || ""}
                       onChange={(e)=>setBountyAmount(e.target.value ? parseInt(e.target.value,10) : "")}
                       placeholder="Amount (sats)"
                       className="pill-input w-40"/>
                <button className="accent-button button-sm pressable"
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
                <label className="flex items-center gap-2 text-xs text-secondary">
                  <input
                    type="checkbox"
                    checked={encryptWhenAttach && !lockToRecipient}
                    onChange={(e)=> setEncryptWhenAttach(e.target.checked)}
                    disabled={lockToRecipient}
                  />
                  Hide/encrypt token until I reveal (uses your local key)
                </label>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-secondary">
                    <input
                      type="checkbox"
                      checked={lockToRecipient}
                      onChange={(e)=>{ setLockToRecipient(e.target.checked); if (e.target.checked) setEncryptWhenAttach(false); }}
                    />
                    Lock to recipient (Nostr npub/hex)
                  </label>
                  {task.createdBy && (
                    <button
                      className="ghost-button button-sm pressable"
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
                  className="pill-input w-full text-xs"
                  disabled={!lockToRecipient}
                />
              </div>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <div className="text-xs text-secondary">Amount</div>
              <input type="number" min={1} value={(bountyAmount as number) || task.bounty?.amount || ""}
                     onChange={(e)=>setBountyAmount(e.target.value ? parseInt(e.target.value,10) : "")}
                     className="pill-input w-40"/>
              <div className="text-xs text-secondary">Token</div>
              {task.bounty.enc && !task.bounty.token ? (
                <div className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs text-secondary">
                  {((task.bounty.enc as any).alg === 'aes-gcm-256')
                    ? 'Hidden (encrypted by funder). Only the funder can reveal.'
                    : 'Locked to recipient\'s Nostr key (nip04). Only the recipient can decrypt.'}
                </div>
              ) : (
                <textarea readOnly value={task.bounty.token || ""}
                          className="pill-textarea w-full" rows={3}/>
              )}
              <div className="flex gap-2 flex-wrap">
                {task.bounty.token && (
                  task.bounty.state === 'unlocked' ? (
                    <button
                      className="accent-button button-sm pressable"
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
                      className="ghost-button button-sm pressable"
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
                  <button className="accent-button button-sm pressable"
                          onClick={async () => {
                            try {
                              await revealBounty(task.id);
                            } catch {}
                          }}>Reveal (decrypt)</button>
                )}
                <button
                  className={`ghost-button button-sm pressable ${task.bounty.token ? '' : 'opacity-50 cursor-not-allowed'}`}
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
                    <button className="accent-button button-sm pressable"
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
              <div className="flex items-center justify-between text-[0.6875rem] text-secondary">
                <div>
                  Created by: <span className="font-mono text-secondary">{short}</span>
                </div>
                <button
                  className={`ghost-button button-sm pressable ${canCopy ? '' : 'opacity-50 cursor-not-allowed'}`}
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
                <div className="flex items-center justify-between text-[0.6875rem] text-secondary">
                  <div>
                    Completed by: <span className="font-mono text-secondary">{short}</span>
                  </div>
                  <button
                    className={`ghost-button button-sm pressable ${canCopy ? '' : 'opacity-50 cursor-not-allowed'}`}
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
          <button className="pressable px-4 py-2 rounded-full bg-rose-600/80 hover:bg-rose-600" onClick={onDelete}>Delete</button>
          <div className="flex gap-2">
            <button className="ghost-button button-sm pressable" onClick={copyCurrent}>Copy</button>
            <button className="ghost-button button-sm pressable" onClick={onCancel}>Cancel</button>
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
            className="ghost-button button-sm pressable"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="accent-button button-sm pressable"
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
            className="pill-input w-full"
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
    <div className="space-y-4">
      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Preset</div>
        <div className="flex flex-wrap gap-2">
          <button className="ghost-button button-sm pressable" onClick={setNone}>None</button>
          <button className="ghost-button button-sm pressable" onClick={setDaily}>Daily</button>
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Weekly</div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
          {Array.from({length:7},(_,i)=>i as Weekday).map(d=>{
            const on = weekly.has(d);
            const cls = on ? 'accent-button button-sm pressable w-full justify-center' : 'ghost-button button-sm pressable w-full justify-center';
            return (
              <button key={d} onClick={()=>toggleDay(d)} className={cls}>
                {WD_SHORT[d]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Every N</div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            max={30}
            value={everyN}
            onChange={e=>setEveryN(parseInt(e.target.value || "1",10))}
            className="pill-input w-24 text-center"
          />
          <select value={unit} onChange={e=>setUnit(e.target.value as "day"|"week")}
                  className="pill-select w-28">
            <option value="day">Days</option>
            <option value="week">Weeks</option>
          </select>
          <button className="accent-button button-sm pressable" onClick={applyEvery}>Apply</button>
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Monthly</div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={28}
            value={monthDay}
            onChange={e=>setMonthDay(parseInt(e.target.value || '1',10))}
            className="pill-input w-24 text-center"
          />
          <button className="accent-button button-sm pressable" onClick={applyMonthly}>Apply</button>
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">End date</div>
        <input
          type="date"
          value={end}
          onChange={e=>{ const v = e.target.value; setEnd(v); onChange({ ...value, untilISO: v ? new Date(v).toISOString() : undefined }); }}
          className="pill-input w-full"
        />
      </div>
    </div>
  );
}

/* Generic modal */
function Modal({ children, onClose, title, actions, showClose = true }: React.PropsWithChildren<{ onClose: ()=>void; title?: React.ReactNode; actions?: React.ReactNode; showClose?: boolean }>) {
  return (
    <div className="modal-backdrop">
      <div className="modal-panel">
        {(title || actions || showClose) && (
          <div className="modal-panel__header">
            {title && <div className="text-lg font-semibold text-primary">{title}</div>}
            {(actions || showClose) && (
              <div className="ml-auto flex items-center gap-2">
                {actions}
                {showClose && (
                  <button className="ghost-button button-sm pressable" onClick={onClose}>
                    Close
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div className="modal-panel__body">{children}</div>
      </div>
    </div>
  );
}

/* Side drawer (right) */
function SideDrawer({ title, onClose, children }: React.PropsWithChildren<{ title?: string; onClose: ()=>void }>) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-panel__header">
          {title && <div className="text-lg font-semibold text-primary">{title}</div>}
          <button className="ghost-button button-sm pressable ml-auto" onClick={onClose}>Close</button>
        </div>
        {children}
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
  onRestartTutorial,
  onClose,
  pushWorkState,
  pushError,
  onEnablePush,
  onDisablePush,
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
  onBoardChanged: (boardId: string, options?: { republishTasks?: boolean }) => void;
  onRestartTutorial: () => void;
  onClose: () => void;
  pushWorkState: "idle" | "enabling" | "disabling";
  pushError: string | null;
  onEnablePush: (platform: PushPlatform) => Promise<void>;
  onDisablePush: () => Promise<void>;
}) {
  const [newBoardName, setNewBoardName] = useState("");
  const [manageBoardId, setManageBoardId] = useState<string | null>(null);
  const manageBoard = boards.find(b => b.id === manageBoardId);
  const [relaysCsv, setRelaysCsv] = useState("");
  const [customSk, setCustomSk] = useState("");
  const [showViewAdvanced, setShowViewAdvanced] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [newDefaultRelay, setNewDefaultRelay] = useState("");
  const [newBoardRelay, setNewBoardRelay] = useState("");
  const [newOverrideRelay, setNewOverrideRelay] = useState("");
  const [showArchivedBoards, setShowArchivedBoards] = useState(false);
  const [archiveDropActive, setArchiveDropActive] = useState(false);
  const boardListRef = useRef<HTMLUListElement>(null);
  const [boardListMaxHeight, setBoardListMaxHeight] = useState<number | null>(null);
  const visibleBoards = useMemo(() => boards.filter(b => !b.archived && !b.hidden), [boards]);
  const unarchivedBoards = useMemo(() => boards.filter(b => !b.archived), [boards]);
  const archivedBoards = useMemo(() => boards.filter(b => b.archived), [boards]);
  // Mint selector moved to Wallet modal; no need to read here.
  const { show: showToast } = useToast();
  const { mintUrl, payInvoice } = useCashu();
  const [donateAmt, setDonateAmt] = useState("");
  const [donateComment, setDonateComment] = useState("");
  const [donateState, setDonateState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [donateMsg, setDonateMsg] = useState("");
  const pillButtonClass = useCallback((active: boolean) => `${active ? "accent-button" : "ghost-button"} pressable`, []);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundAccentHex = settings.backgroundAccent ? settings.backgroundAccent.fill.toUpperCase() : null;
  const pushPrefs = settings.pushNotifications ?? DEFAULT_PUSH_PREFERENCES;
  const pushSupported = typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  const workerConfigured = !!WORKER_BASE_URL;
  const vapidConfigured = !!VAPID_PUBLIC_KEY;
  const pushBusy = pushWorkState !== 'idle';
  const permissionLabel = pushPrefs.permission ?? (typeof Notification !== 'undefined' ? Notification.permission : 'default');
  
  const handleBackgroundImageSelection = useCallback(async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Please choose an image file");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast("Image too large. Please pick something under 8 MB.");
      return;
    }
    try {
      const { dataUrl, palettes } = await prepareBackgroundImage(file);
      const primary = palettes[0] ?? null;
      setSettings({
        backgroundImage: dataUrl,
        backgroundAccents: palettes,
        backgroundAccentIndex: primary ? 0 : null,
        backgroundAccent: primary,
        accent: primary ? "background" : "blue",
      });
      showToast("Background updated");
    } catch (err) {
      if (err instanceof BackgroundImageError) {
        showToast(err.message);
      } else {
        console.error("Failed to process background image", err);
        showToast("Could not load that image");
      }
    }
  }, [setSettings, showToast]);

  const updatePush = useCallback((patch: Partial<PushPreferences>) => {
    setSettings({ pushNotifications: { ...pushPrefs, ...patch } });
  }, [pushPrefs, setSettings]);

  const handleEnablePush = useCallback(async () => {
    try {
      await onEnablePush(pushPrefs.platform);
    } catch {}
  }, [onEnablePush, pushPrefs.platform]);

  const handleDisablePush = useCallback(async () => {
    try {
      await onDisablePush();
    } catch {}
  }, [onDisablePush]);

  const clearBackgroundImage = useCallback(() => {
    setSettings({
      backgroundImage: null,
      backgroundAccent: null,
      backgroundAccents: null,
      backgroundAccentIndex: null,
      accent: "blue",
    });
    showToast("Background cleared");
  }, [setSettings, showToast]);
  const photoAccents = settings.backgroundAccents ?? [];
  const handleSelectPhotoAccent = useCallback((index: number) => {
    const palette = settings.backgroundAccents?.[index];
    if (!palette) return;
    setSettings({
      backgroundAccent: palette,
      backgroundAccentIndex: index,
      accent: "background",
    });
  }, [setSettings, settings.backgroundAccents]);

  useEffect(() => {
    const listEl = boardListRef.current;
    if (!listEl) return;

    function computeHeight() {
      const currentList = boardListRef.current;
      if (!currentList) return;
      const items = Array.from(currentList.children) as HTMLElement[];
      if (items.length === 0) {
        setBoardListMaxHeight(null);
        return;
      }
      const firstRect = items[0].getBoundingClientRect();
      if (firstRect.height === 0) {
        setBoardListMaxHeight(null);
        return;
      }
      let step = firstRect.height;
      if (items.length > 1) {
        const secondRect = items[1].getBoundingClientRect();
        const diff = secondRect.top - firstRect.top;
        if (diff > 0) step = diff;
      }
      const lastRect = items[items.length - 1].getBoundingClientRect();
      const totalHeight = lastRect.bottom - firstRect.top;
      const limit = step * 5.5;
      if (totalHeight <= limit) {
        setBoardListMaxHeight(null);
        return;
      }
      setBoardListMaxHeight(limit);
    }

    computeHeight();

    const handleResize = () => computeHeight();
    window.addEventListener("resize", handleResize);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => computeHeight());
      resizeObserver.observe(listEl);
      Array.from(listEl.children).forEach((child) => resizeObserver!.observe(child));
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
    };
  }, [unarchivedBoards]);

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

  function handleDailyStartBoardChange(day: Weekday, boardId: string) {
    const prev = settings.startBoardByDay;
    const next: Partial<Record<Weekday, string>> = { ...prev };
    if (!boardId) {
      if (prev[day] === undefined) return;
      delete next[day];
    } else {
      if (prev[day] === boardId) return;
      next[day] = boardId;
    }
    setSettings({ startBoardByDay: next });
  }

  function backupData() {
    const data = {
      tasks: JSON.parse(localStorage.getItem(LS_TASKS) || "[]"),
      boards: JSON.parse(localStorage.getItem(LS_BOARDS) || "[]"),
      settings: JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}"),
      defaultRelays: JSON.parse(localStorage.getItem(LS_NOSTR_RELAYS) || "[]"),
      contacts: JSON.parse(localStorage.getItem(LS_LIGHTNING_CONTACTS) || "[]"),
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
        if (data.contacts) localStorage.setItem(LS_LIGHTNING_CONTACTS, JSON.stringify(data.contacts));
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

  const handleClose = useCallback(() => {
    onClose();
    if (reloadNeeded) window.location.reload();
  }, [onClose, reloadNeeded]);

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
    const board: Board = {
      id,
      name,
      kind: "lists",
      columns: [{ id: crypto.randomUUID(), name: "List 1" }],
      archived: false,
      hidden: false,
    };
    setBoards(prev => [...prev, board]);
    setNewBoardName("");
    setCurrentBoardId(id);
  }

  function renameBoard(id: string, name: string) {
    setBoards(prev => prev.map(x => x.id === id ? { ...x, name } : x));
    const sb = boards.find(x => x.id === id);
    if (sb?.nostr) setTimeout(() => onBoardChanged(id), 0);
  }

  function archiveBoard(id: string) {
    const board = boards.find(x => x.id === id);
    if (!board || board.archived) return;
    const remainingUnarchived = boards.filter(b => b.id !== id && !b.archived);
    if (remainingUnarchived.length === 0) {
      alert("At least one board must remain unarchived.");
      return;
    }
    setBoards(prev => prev.map(b => b.id === id ? { ...b, archived: true } : b));
    if (currentBoardId === id) {
      const nextVisible = boards.find(b => b.id !== id && !b.archived && !b.hidden);
      const fallback = remainingUnarchived[0];
      setCurrentBoardId((nextVisible ?? fallback)?.id || "");
    }
    if (manageBoardId === id) setManageBoardId(null);
  }

  function setBoardHidden(id: string, hidden: boolean) {
    setBoards(prev => prev.map(b => (b.id === id ? { ...b, hidden } : b)));
  }

  function openHiddenBoard(id: string) {
    const board = boards.find(x => x.id === id && !x.archived && x.hidden);
    if (!board) return;
    setCurrentBoardId(id);
    setManageBoardId(null);
    handleClose();
  }

  function openArchivedBoard(id: string) {
    const board = boards.find(x => x.id === id && x.archived);
    if (!board) return;
    setCurrentBoardId(id);
    setShowArchivedBoards(false);
    handleClose();
  }

  function unarchiveBoard(id: string) {
    setBoards(prev => prev.map(b => b.id === id ? { ...b, archived: false } : b));
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

  function HiddenBoardIcon() {
    return (
      <svg
        className="w-4 h-4 text-secondary"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2 12s3-6 10-6 10 6 10 6-3 6-10 6S2 12 2 12Z" />
        <path d="M3 3l18 18" />
      </svg>
    );
  }

  function BoardListItem({
    board,
    hidden,
    onPrimaryAction,
    onDrop,
    onEdit,
  }: {
    board: Board;
    hidden: boolean;
    onPrimaryAction: () => void;
    onDrop: (dragId: string, before: boolean) => void;
    onEdit?: () => void;
  }) {
    const [overBefore, setOverBefore] = useState(false);
    const [dragging, setDragging] = useState(false);
    function handleDragStart(e: React.DragEvent) {
      e.dataTransfer.setData("text/board-id", board.id);
      e.dataTransfer.effectAllowed = "move";
      setDragging(true);
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
      setDragging(false);
    }
    function handleDragLeave() {
      setOverBefore(false);
    }
    function handleDragEnd() {
      setDragging(false);
      setOverBefore(false);
    }
    function handleClick() {
      if (dragging) return;
      onPrimaryAction();
    }
    const buttonClasses = hidden
      ? "flex-1 text-left min-w-0 text-secondary hover:text-primary transition-colors"
      : "flex-1 text-left min-w-0";
    return (
      <li
        className="board-list-item"
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
        onDragEnd={handleDragEnd}
      >
        {overBefore && (
          <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full" style={{ background: "var(--accent)" }} />
        )}
        <button type="button" className={buttonClasses} onClick={handleClick}>
          <span className="flex items-center gap-2">
            {hidden && (
              <span className="shrink-0" aria-hidden="true">
                <HiddenBoardIcon />
              </span>
            )}
            <span className="truncate">{board.name}</span>
            {hidden && <span className="sr-only">Hidden board</span>}
          </span>
        </button>
        {hidden && onEdit && (
          <button
            type="button"
            className="ghost-button button-sm pressable"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (dragging) return;
              onEdit();
            }}
          >
            Edit
          </button>
        )}
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
        className="relative p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2"
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
      >
        {overBefore && (
          <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full" style={{ background: "var(--accent)" }} />
        )}
        <div className="flex-1">{column.name}</div>
        <div className="flex gap-1">
          <button className="ghost-button button-sm pressable" onClick={()=>renameColumn(boardId, column.id)}>Rename</button>
          <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>deleteColumn(boardId, column.id)}>Delete</button>
        </div>
      </li>
    );
  }

  function isBoardDrag(event: React.DragEvent) {
    return Array.from(event.dataTransfer.types).includes("text/board-id");
  }

  function handleArchiveButtonDragEnter(e: React.DragEvent<HTMLButtonElement>) {
    if (!isBoardDrag(e)) return;
    e.preventDefault();
    setArchiveDropActive(true);
  }

  function handleArchiveButtonDragOver(e: React.DragEvent<HTMLButtonElement>) {
    if (!isBoardDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setArchiveDropActive(true);
  }

  function handleArchiveButtonDragLeave() {
    setArchiveDropActive(false);
  }

  function handleArchiveButtonDrop(e: React.DragEvent<HTMLButtonElement>) {
    if (!isBoardDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setArchiveDropActive(false);
    const id = e.dataTransfer.getData("text/board-id");
    if (id) archiveBoard(id);
  }

  return (
    <>
    <Modal onClose={handleClose} title="Settings">
      <div className="space-y-6">

        {/* Boards & Columns */}
        <section className="wallet-section space-y-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Boards & Lists</div>
          </div>
          <ul
            ref={boardListRef}
            className="space-y-2 mb-3 overflow-y-auto pr-1"
            style={boardListMaxHeight != null ? { maxHeight: `${boardListMaxHeight}px` } : undefined}
          >
            {unarchivedBoards.map((b) => (
              <BoardListItem
                key={b.id}
                board={b}
                hidden={!!b.hidden}
                onPrimaryAction={b.hidden ? () => openHiddenBoard(b.id) : () => setManageBoardId(b.id)}
                onEdit={b.hidden ? () => setManageBoardId(b.id) : undefined}
                onDrop={(dragId, before) => reorderBoards(dragId, b.id, before)}
              />
            ))}
          </ul>
          <div className="flex gap-2">
            <input
              value={newBoardName}
              onChange={e=>setNewBoardName(e.target.value)}
              placeholder="Board name or ID"
              className="pill-input flex-1 min-w-0"
            />
            <button
              className="accent-button pressable shrink-0"
              onClick={addBoard}
            >
              Create/Join
            </button>
          </div>
          <button
            className={`pressable mt-2 px-3 py-2 rounded-xl bg-surface-muted transition ${archiveDropActive ? "ring-2 ring-emerald-500" : ""}`}
            onClick={() => setShowArchivedBoards(true)}
            onDragEnter={handleArchiveButtonDragEnter}
            onDragOver={handleArchiveButtonDragOver}
            onDragLeave={handleArchiveButtonDragLeave}
            onDrop={handleArchiveButtonDrop}
          >
            Archived
          </button>
        </section>

        {/* View */}
        <section className="wallet-section space-y-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">View</div>
            <div className="ml-auto" />
            <button
              className="ghost-button button-sm pressable"
              onClick={() => setShowViewAdvanced((v) => !v)}
            >
              {showViewAdvanced ? "Hide advanced" : "Advanced"}
            </button>
          </div>
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Font size</div>
              <div className="flex flex-wrap gap-2">
                <button className={pillButtonClass(settings.baseFontSize == null)} onClick={() => setSettings({ baseFontSize: null })}>System</button>
                <button className={pillButtonClass(settings.baseFontSize === 14)} onClick={() => setSettings({ baseFontSize: 14 })}>Small</button>
                <button className={pillButtonClass(settings.baseFontSize === 16)} onClick={() => setSettings({ baseFontSize: 16 })}>Default</button>
                <button className={pillButtonClass(settings.baseFontSize === 18)} onClick={() => setSettings({ baseFontSize: 18 })}>Large</button>
                <button className={pillButtonClass(settings.baseFontSize === 20)} onClick={() => setSettings({ baseFontSize: 20 })}>X-Large</button>
                <button className={pillButtonClass(settings.baseFontSize === 22)} onClick={() => setSettings({ baseFontSize: 22 })}>XX-Large</button>
              </div>
              <div className="text-xs text-secondary mt-2">Scales the entire UI. Defaults to a compact size.</div>
            </div>
            <div>
              <div className="text-sm font-medium mb-2">Add new tasks to</div>
              <div className="flex gap-2">
                <button className={pillButtonClass(settings.newTaskPosition === 'top')} onClick={() => setSettings({ newTaskPosition: 'top' })}>Top</button>
                <button className={pillButtonClass(settings.newTaskPosition === 'bottom')} onClick={() => setSettings({ newTaskPosition: 'bottom' })}>Bottom</button>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-2">Add tasks within lists</div>
              <div className="flex gap-2">
                <button className={pillButtonClass(settings.inlineAdd)} onClick={() => setSettings({ inlineAdd: true })}>Inline</button>
                <button className={pillButtonClass(!settings.inlineAdd)} onClick={() => setSettings({ inlineAdd: false })}>Top bar</button>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-2">Hide completed subtasks</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(settings.hideCompletedSubtasks)}
                  onClick={() => setSettings({ hideCompletedSubtasks: !settings.hideCompletedSubtasks })}
                >
                  {settings.hideCompletedSubtasks ? "On" : "Off"}
                </button>
              </div>
              <div className="text-xs text-secondary mt-2">Keep finished subtasks out of cards. Open Edit to review them later.</div>
            </div>
            <div>
              <div className="text-sm font-medium mb-2">Open app to</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(settings.startupView === "main")}
                  onClick={() => setSettings({ startupView: "main" })}
                >
                  Main view
                </button>
                <button
                  className={pillButtonClass(settings.startupView === "wallet")}
                  onClick={() => setSettings({ startupView: "wallet" })}
                >
                  Wallet
                </button>
              </div>
              <div className="text-xs text-secondary mt-2">Choose whether Taskify launches to your boards or directly into the wallet.</div>
            </div>
          </div>
          {showViewAdvanced && (
            <div className="mt-4 border-t border-neutral-800 pt-4 space-y-4">
              <div>
                <div className="text-sm font-medium mb-2">Background</div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="accent-button button-sm pressable"
                    onClick={() => backgroundInputRef.current?.click()}
                  >
                    Upload image
                  </button>
                  {settings.backgroundImage && (
                    <button
                      className="ghost-button button-sm pressable"
                      onClick={clearBackgroundImage}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  ref={backgroundInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
                    handleBackgroundImageSelection(file);
                    event.currentTarget.value = "";
                  }}
                />
                <div className="text-xs text-secondary mt-2">Upload a photo to replace the gradient background. Taskify blurs it and matches the accent color automatically.</div>
                {settings.backgroundImage && (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="relative w-16 h-12 overflow-hidden rounded-xl border border-surface bg-surface-muted">
                        <div
                          className="absolute inset-0"
                          style={{
                            backgroundImage: `url(${settings.backgroundImage})`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                          }}
                        />
                      </div>
                      {settings.backgroundAccent && backgroundAccentHex && (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-secondary">
                          <span className="inline-flex items-center gap-1 rounded-full border border-surface bg-surface-muted px-2 py-1">
                            <span
                              className="w-3 h-3 rounded-full"
                              style={{
                                background: settings.backgroundAccent.fill,
                                border: '1px solid rgba(255, 255, 255, 0.35)',
                              }}
                            />
                            <span>{backgroundAccentHex}</span>
                          </span>
                          <span>{settings.accent === 'background' ? 'Accent follows the photo color you picked.' : 'Pick a photo accent below to sync buttons and badges.'}</span>
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-xs text-secondary mb-1">Background clarity</div>
                      <div className="flex gap-2">
                        <button
                          className={pillButtonClass(settings.backgroundBlur !== 'sharp')}
                          onClick={() => setSettings({ backgroundBlur: 'blurred' })}
                        >
                          Blurred
                        </button>
                        <button
                          className={pillButtonClass(settings.backgroundBlur === 'sharp')}
                          onClick={() => setSettings({ backgroundBlur: 'sharp' })}
                        >
                          Sharp
                        </button>
                      </div>
                      <div className="text-xs text-secondary mt-2">Blur softens distractions; Sharp keeps the photo crisp behind your boards.</div>
                    </div>
                  </div>
                )}
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Accent color</div>
                <div className="flex flex-wrap gap-3">
                  {ACCENT_CHOICES.map((choice) => {
                    const active = settings.accent === choice.id;
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        className={`accent-swatch pressable ${active ? 'accent-swatch--active' : ''}`}
                        style={{
                          "--swatch-color": choice.fill,
                          "--swatch-ring": choice.ring,
                          "--swatch-border": choice.border,
                          "--swatch-border-active": choice.borderActive,
                          "--swatch-shadow": choice.shadow,
                          "--swatch-active-shadow": choice.shadowActive,
                        } as React.CSSProperties}
                        aria-label={choice.label}
                        aria-pressed={active}
                        onClick={() => setSettings({ accent: choice.id })}
                      >
                        <span className="sr-only">{choice.label}</span>
                      </button>
                    );
                  })}
                </div>
                {photoAccents.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-secondary uppercase tracking-[0.12em]">Photo accents</div>
                    <div className="flex flex-wrap gap-3">
                      {photoAccents.map((palette, index) => {
                        const active = settings.accent === 'background' && settings.backgroundAccentIndex === index;
                        return (
                          <button
                            key={`photo-accent-${index}`}
                            type="button"
                            className={`accent-swatch pressable ${active ? 'accent-swatch--active' : ''}`}
                            style={{
                              "--swatch-color": palette.fill,
                              "--swatch-ring": palette.ring,
                              "--swatch-border": palette.border,
                              "--swatch-border-active": palette.borderActive,
                              "--swatch-shadow": palette.shadow,
                              "--swatch-active-shadow": palette.shadowActive,
                            } as React.CSSProperties}
                            aria-label={`Photo accent ${index + 1}`}
                            aria-pressed={active}
                            onClick={() => handleSelectPhotoAccent(index)}
                          >
                            <span className="sr-only">Photo accent {index + 1}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="text-xs text-secondary mt-2">
                  {photoAccents.length > 0
                    ? settings.accent === 'background'
                      ? 'Buttons, badges, and focus states now use the photo accent you chose.'
                      : 'Choose one of your photo accents above or stick with the presets.'
                    : 'Switch the highlight color used across buttons, badges, and focus states.'}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Week starts on</div>
                <div className="flex gap-2">
                  <button className={pillButtonClass(settings.weekStart === 6)} onClick={() => setSettings({ weekStart: 6 })}>Saturday</button>
                  <button className={pillButtonClass(settings.weekStart === 0)} onClick={() => setSettings({ weekStart: 0 })}>Sunday</button>
                  <button className={pillButtonClass(settings.weekStart === 1)} onClick={() => setSettings({ weekStart: 1 })}>Monday</button>
                </div>
                <div className="text-xs text-secondary mt-2">Affects when weekly recurring tasks re-appear.</div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Show full week for recurring tasks</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.showFullWeekRecurring)}
                    onClick={() => setSettings({ showFullWeekRecurring: !settings.showFullWeekRecurring })}
                  >
                    {settings.showFullWeekRecurring ? "On" : "Off"}
                  </button>
                </div>
                <div className="text-xs text-secondary mt-2">Display all occurrences for the current week at once.</div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Completed tab</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.completedTab)}
                    onClick={() => setSettings({ completedTab: !settings.completedTab })}
                  >
                    {settings.completedTab ? "On" : "Off"}
                  </button>
                </div>
                <div className="text-xs text-secondary mt-2">Hide the completed tab and show a Clear completed button instead.</div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Streaks</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.streaksEnabled)}
                    onClick={() => setSettings({ streaksEnabled: !settings.streaksEnabled })}
                  >
                    {settings.streaksEnabled ? "On" : "Off"}
                  </button>
                </div>
                <div className="text-xs text-secondary mt-2">Track consecutive completions on recurring tasks.</div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Board on app start</div>
                <div className="space-y-2">
                  {WD_FULL.map((label, idx) => (
                    <div key={label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                      <div className="text-xs uppercase tracking-wide text-secondary sm:w-28">{label}</div>
                      <select
                        className="pill-input flex-1"
                        value={settings.startBoardByDay[idx as Weekday] ?? ""}
                        onChange={(e) => handleDailyStartBoardChange(idx as Weekday, e.target.value)}
                      >
                        <option value="">Default (first visible)</option>
                        {visibleBoards.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-secondary mt-2">
                  Choose which board opens first for each day. Perfect for work boards on weekdays and personal lists on weekends.
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Push notifications */}
        <section className="wallet-section space-y-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Push notifications</div>
            <span className={`ml-auto text-xs ${pushPrefs.enabled ? 'text-emerald-400' : 'text-secondary'}`}>
              {pushPrefs.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Platform</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(pushPrefs.platform === 'ios')}
                  onClick={() => updatePush({ platform: 'ios' })}
                >iOS</button>
                <button
                  className={pillButtonClass(pushPrefs.platform === 'android')}
                  onClick={() => updatePush({ platform: 'android' })}
                >Android</button>
              </div>
              <div className="text-xs text-secondary mt-2">
                Pick the platform where you plan to install Taskify as a PWA.
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <button
                className={`${pushPrefs.enabled ? 'ghost-button' : 'accent-button'} button-sm pressable w-full sm:w-auto`}
                onClick={pushPrefs.enabled ? handleDisablePush : handleEnablePush}
                disabled={pushBusy || !pushSupported || !workerConfigured || !vapidConfigured}
              >
                {pushBusy ? 'Working…' : pushPrefs.enabled ? 'Disable push' : 'Enable push'}
              </button>
              <div className="text-xs text-secondary sm:ml-auto">
                Permission: {permissionLabel}
              </div>
            </div>
            {!pushSupported && (
              <div className="text-xs text-secondary">
                Push notifications require installing Taskify on iOS or Android and using a browser that supports the Push API.
              </div>
            )}
            {(!workerConfigured || !vapidConfigured) && (
              <div className="text-xs text-secondary">
                Configure VITE_WORKER_BASE_URL and VITE_VAPID_PUBLIC_KEY to enable push registration.
              </div>
            )}
            {pushError && (
              <div className="text-xs text-rose-400 break-words">{pushError}</div>
            )}
            {pushPrefs.enabled && pushPrefs.deviceId && (
              <div className="text-xs text-secondary break-words">
                Device ID: {pushPrefs.deviceId}
              </div>
            )}
          </div>
        </section>

        {/* Wallet */}
        <section className="wallet-section space-y-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Wallet</div>
          </div>
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Currency conversion</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(settings.walletConversionEnabled)}
                  onClick={() => setSettings({ walletConversionEnabled: true })}
                >On</button>
                <button
                  className={pillButtonClass(!settings.walletConversionEnabled)}
                  onClick={() => setSettings({ walletConversionEnabled: false, walletPrimaryCurrency: "sat" })}
                >Off</button>
              </div>
              <div className="text-xs text-secondary mt-2">Show USD equivalents by fetching spot BTC prices from Coinbase.</div>
            </div>
            {settings.walletConversionEnabled && (
              <div>
                <div className="text-sm font-medium mb-2">Primary display</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.walletPrimaryCurrency === "sat")}
                    onClick={() => setSettings({ walletPrimaryCurrency: "sat" })}
                  >Sats</button>
                  <button
                    className={pillButtonClass(settings.walletPrimaryCurrency === "usd")}
                    onClick={() => setSettings({ walletPrimaryCurrency: "usd" })}
                  >USD</button>
                </div>
                <div className="text-xs text-secondary mt-2">You can also tap the unit label in the wallet header to toggle.</div>
              </div>
            )}
            <div>
              <div className="text-sm font-medium mb-2">npub.cash lightning address</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(settings.npubCashLightningAddressEnabled)}
                  onClick={() => setSettings({ npubCashLightningAddressEnabled: true })}
                >On</button>
                <button
                  className={pillButtonClass(!settings.npubCashLightningAddressEnabled)}
                  onClick={() => setSettings({ npubCashLightningAddressEnabled: false, npubCashAutoClaim: false })}
                >Off</button>
              </div>
              <div className="text-xs text-secondary mt-2">
                Share a lightning address powered by npub.cash using your Taskify Nostr keys.
              </div>
            </div>
            {settings.npubCashLightningAddressEnabled && (
              <div>
                <div className="text-sm font-medium mb-2">Auto-claim npub.cash eCash</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.npubCashAutoClaim)}
                    onClick={() => setSettings({ npubCashAutoClaim: true })}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.npubCashAutoClaim)}
                    onClick={() => setSettings({ npubCashAutoClaim: false })}
                  >Off</button>
                </div>
                <div className="text-xs text-secondary mt-2">
                  Automatically claim pending npub.cash tokens each time the wallet opens.
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Nostr */}
        <section className="wallet-section space-y-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Nostr</div>
            <div className="ml-auto" />
            <button
              className="ghost-button button-sm pressable"
              onClick={()=>setShowAdvanced(a=>!a)}
            >{showAdvanced ? "Hide advanced" : "Advanced"}</button>
          </div>
          {/* Quick actions available outside Advanced */}
          <div className="mb-3 flex gap-2">
            <button
              className="ghost-button button-sm pressable"
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
              className="ghost-button button-sm pressable"
              onClick={()=>setDefaultRelays(DEFAULT_RELAYS.slice())}
            >Reload default relays</button>
          </div>
          {showAdvanced && (
            <>
              {/* Public key */}
              <div className="mb-3">
                <div className="text-xs text-secondary mb-1">Your Nostr public key (hex)</div>
                <div className="flex gap-2 items-center">
                  <input readOnly value={pubkeyHex || "(generating…)"}
                         className="pill-input flex-1"/>
                  <button className="ghost-button button-sm pressable" onClick={async ()=>{ if(pubkeyHex) { try { await navigator.clipboard?.writeText(pubkeyHex); } catch {} } }}>Copy</button>
                </div>
              </div>

              {/* Private key options */}
              <div className="mb-3 space-y-2">
                <div className="text-xs text-secondary mb-1">Custom Nostr private key (hex or nsec)</div>
                <div className="flex gap-2 items-center">
                  <input value={customSk} onChange={e=>setCustomSk(e.target.value)}
                         className="pill-input flex-1" placeholder="nsec or hex"/>
                  <button className="ghost-button button-sm pressable" onClick={()=>{onSetKey(customSk); setCustomSk('');}}>Use</button>
                </div>
                <div className="flex gap-2">
                  <button className="ghost-button button-sm pressable" onClick={onGenerateKey}>Generate new key</button>
                  <button
                    className="ghost-button button-sm pressable"
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
                <div className="text-xs text-secondary mb-1">Default relays</div>
                <div className="flex gap-2 mb-2">
                  <input
                    value={newDefaultRelay}
                    onChange={(e)=>setNewDefaultRelay(e.target.value)}
                    onKeyDown={(e)=>{ if (e.key === 'Enter') { const v = newDefaultRelay.trim(); if (v && !defaultRelays.includes(v)) { setDefaultRelays([...defaultRelays, v]); setNewDefaultRelay(""); } } }}
                    className="pill-input flex-1"
                    placeholder="wss://relay.example"
                  />
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={()=>{ const v = newDefaultRelay.trim(); if (v && !defaultRelays.includes(v)) { setDefaultRelays([...defaultRelays, v]); setNewDefaultRelay(""); } }}
                  >Add</button>
                </div>
                <ul className="space-y-2">
                  {defaultRelays.map((r) => (
                    <li key={r} className="p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2">
                      <div className="flex-1 truncate">{r}</div>
                      <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>setDefaultRelays(defaultRelays.filter(x => x !== r))}>Delete</button>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex gap-2">
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={()=>setDefaultRelays(DEFAULT_RELAYS.slice())}
                  >Reload defaults</button>
                </div>
              </div>
            </>
          )}
        </section>

        {/* Cashu mint: moved into Wallet → Mint balances */}

        {/* Backup & Restore */}
        <section className="wallet-section space-y-3">
          <div className="text-sm font-medium">Backup</div>
          <div className="flex flex-wrap gap-2">
            <button className="accent-button button-sm pressable flex-1" onClick={backupData}>Download backup</button>
            <label className="ghost-button button-sm pressable flex-1 justify-center cursor-pointer">
              Restore from backup
              <input type="file" accept="application/json" className="hidden" onChange={restoreFromBackup} />
            </label>
          </div>
        </section>

        {/* Tutorial */}
        <section className="wallet-section space-y-3">
          <div className="text-sm font-medium mb-2">Tutorial</div>
          <div className="text-xs text-secondary mb-3">
            Replay the guided tour to refresh how Taskify works.
          </div>
          <button className="accent-button button-sm pressable" onClick={onRestartTutorial}>View tutorial again</button>
        </section>

        {/* Development donation */}
        <section className="wallet-section space-y-3">
          <div className="text-sm font-medium mb-2">Support development</div>
          <div className="text-xs text-secondary mb-3">Donate from your internal wallet to dev@solife.me</div>
          <div className="flex gap-2 mb-2 w-full">
            <input
              className="pill-input flex-1 min-w-[7rem]"
              placeholder="Amount (sats)"
              value={donateAmt}
              onChange={(e)=>setDonateAmt(e.target.value)}
              inputMode="numeric"
            />
            <button
              className="accent-button button-sm pressable shrink-0 whitespace-nowrap"
              onClick={handleDonate}
              disabled={!mintUrl || donateState === 'sending'}
            >Donate now</button>
          </div>
          <input
            className="pill-input w-full"
            placeholder="Comment (optional)"
            value={donateComment}
            onChange={(e)=>setDonateComment(e.target.value)}
          />
          <div className="mt-2 text-xs text-secondary">
            {donateState === 'sending' && <span>Sending…</span>}
            {donateState === 'done' && <span className="text-accent">{donateMsg}</span>}
            {donateState === 'error' && <span className="text-rose-400">{donateMsg}</span>}
          </div>
        </section>

        {/* Feedback / Feature requests */}
        <section className="wallet-section space-y-2 text-xs text-secondary">
          <div>
            Please submit feedback or feature requests to{' '}
            <button
              className="link-accent"
              onClick={async ()=>{ try { await navigator.clipboard?.writeText('dev@solife.me'); showToast('Copied dev@solife.me'); } catch {} }}
            >dev@solife.me</button>{' '}or share Board ID{' '}
            <button
              className="link-accent"
              onClick={async ()=>{ try { await navigator.clipboard?.writeText('c3db0d84-ee89-43df-a31e-edb4c75be32b'); showToast('Copied Board ID'); } catch {} }}
            >c3db0d84-ee89-43df-a31e-edb4c75be32b</button>
          </div>
        </section>

        <div className="flex justify-end">
          <button className="ghost-button button-sm pressable" onClick={handleClose}>Close</button>
        </div>
      </div>
    </Modal>
    {showArchivedBoards && (
      <Modal onClose={() => setShowArchivedBoards(false)} title="Archived boards">
        {archivedBoards.length === 0 ? (
          <div className="text-sm text-secondary">No archived boards.</div>
        ) : (
          <ul className="space-y-2">
            {archivedBoards.map((b) => (
              <li
                key={b.id}
                className="bg-surface-muted border border-surface rounded-2xl p-3 flex items-center gap-2 cursor-pointer transition hover:bg-surface-highlight"
                role="button"
                tabIndex={0}
                onClick={() => openArchivedBoard(b.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openArchivedBoard(b.id);
                  }
                }}
              >
                <div className="flex-1 truncate">{b.name}</div>
                <div className="flex gap-2">
                  <button
                    className="accent-button button-sm pressable"
                    onClick={(e) => {
                      e.stopPropagation();
                      unarchiveBoard(b.id);
                    }}
                  >
                    Unarchive
                  </button>
                  <button
                    className="ghost-button button-sm pressable text-rose-400"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteBoard(b.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    )}
    {manageBoard && (
      <Modal
        onClose={() => setManageBoardId(null)}
        title="Manage board"
        actions={(
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="icon-button pressable"
              style={{ '--icon-size': '2.2rem' } as React.CSSProperties}
              data-active={manageBoard.hidden}
              aria-pressed={manageBoard.hidden}
              aria-label={manageBoard.hidden ? 'Unhide board' : 'Hide board'}
              title={manageBoard.hidden ? 'Unhide board' : 'Hide board'}
              onClick={() => setBoardHidden(manageBoard.id, !manageBoard.hidden)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-[16px] w-[16px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 12.5c2.4-3 5.4-4.5 8-4.5s5.6 1.5 8 4.5" />
                <path d="M6.5 15l1.6-1.6" />
                <path d="M12 15.5v-2.1" />
                <path d="M17.5 15l-1.6-1.6" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-button pressable"
              style={{ '--icon-size': '2.2rem' } as React.CSSProperties}
              data-active={manageBoard.archived}
              aria-pressed={manageBoard.archived}
              aria-label={manageBoard.archived ? 'Unarchive board' : 'Archive board'}
              title={manageBoard.archived ? 'Unarchive board' : 'Archive board'}
              onClick={() => {
                if (manageBoard.archived) unarchiveBoard(manageBoard.id);
                else archiveBoard(manageBoard.id);
              }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-[16px] w-[16px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4.5 7h15" />
                <rect x="5" y="7" width="14" height="12" rx="2" />
                <path d="M12 11v4" />
                <path d="M10.5 13.5L12 15l1.5-1.5" />
              </svg>
            </button>
          </div>
        )}
      >
        <input
          value={manageBoard.name}
          onChange={e => renameBoard(manageBoard.id, e.target.value)}
          className="pill-input w-full mb-4"
        />
        {manageBoard.kind === "lists" ? (
          <>
              <ul className="space-y-2">
              {manageBoard.columns.map(col => (
                <ColumnItem key={col.id} boardId={manageBoard.id} column={col} />
              ))}
            </ul>
            <div className="mt-2">
              <button className="accent-button button-sm pressable" onClick={()=>addColumn(manageBoard.id)}>Add list</button>
            </div>
            <div className="text-xs text-secondary mt-2">Tasks can be dragged between lists directly on the board.</div>
          </>
        ) : (
          <div className="text-xs text-secondary">The Week board has fixed columns (Sun–Sat, Bounties).</div>
        )}

        <div className="mt-6">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-sm font-medium">Sharing</div>
            <div className="ml-auto" />
            <button
              className="ghost-button button-sm pressable"
              onClick={()=>setShowAdvanced(a=>!a)}
            >{showAdvanced ? "Hide advanced" : "Advanced"}</button>
          </div>
          <div className="space-y-2">
            {manageBoard.nostr ? (
              <>
                <div className="text-xs text-secondary">Board ID</div>
                <div className="flex gap-2 items-center">
                  <input readOnly value={manageBoard.nostr.boardId}
                         className="pill-input flex-1 min-w-0"/>
                  <button className="ghost-button button-sm pressable" onClick={async ()=>{ try { await navigator.clipboard?.writeText(manageBoard.nostr!.boardId); } catch {} }}>Copy</button>
                </div>
                  {showAdvanced && (
                    <>
                      <div className="text-xs text-secondary">Relays</div>
                      <div className="flex gap-2 mb-2">
                        <input
                          value={newBoardRelay}
                          onChange={(e)=>setNewBoardRelay(e.target.value)}
                          onKeyDown={(e)=>{ if (e.key === 'Enter' && manageBoard?.nostr) { const v = newBoardRelay.trim(); if (v && !(manageBoard.nostr.relays || []).includes(v)) { setBoards(prev => prev.map(b => b.id === manageBoard.id ? ({...b, nostr: { boardId: manageBoard.nostr!.boardId, relays: [...(manageBoard.nostr!.relays || []), v] } }) : b)); setNewBoardRelay(""); } } }}
                          className="pill-input flex-1"
                          placeholder="wss://relay.example"
                        />
                        <button
                          className="ghost-button button-sm pressable"
                          onClick={()=>{ if (!manageBoard?.nostr) return; const v = newBoardRelay.trim(); if (v && !(manageBoard.nostr.relays || []).includes(v)) { setBoards(prev => prev.map(b => b.id === manageBoard.id ? ({...b, nostr: { boardId: manageBoard.nostr!.boardId, relays: [...(manageBoard.nostr!.relays || []), v] } }) : b)); setNewBoardRelay(""); } }}
                        >Add</button>
                      </div>
                      <ul className="space-y-2 mb-2">
                        {(manageBoard.nostr.relays || []).map((r) => (
                          <li key={r} className="p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2">
                            <div className="flex-1 truncate">{r}</div>
                            <button
                              className="ghost-button button-sm pressable text-rose-400"
                              onClick={()=>{
                                if (!manageBoard?.nostr) return;
                                const relays = (manageBoard.nostr.relays || []).filter(x => x !== r);
                                setBoards(prev => prev.map(b => b.id === manageBoard.id ? ({...b, nostr: { boardId: manageBoard.nostr!.boardId, relays } }) : b));
                              }}
                            >Delete</button>
                          </li>
                        ))}
                      </ul>
                      <button className="ghost-button button-sm pressable" onClick={()=>onRegenerateBoardId(manageBoard.id)}>Generate new board ID</button>
                    </>
                  )}
                  <div className="flex gap-2">
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={()=>onBoardChanged(manageBoard.id, { republishTasks: true })}
                  >Republish metadata</button>
                  <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>{
                    setBoards(prev => prev.map(b => b.id === manageBoard.id ? (b.kind === 'week'
                      ? { id: b.id, name: b.name, kind: 'week', archived: b.archived, hidden: b.hidden } as Board
                      : { id: b.id, name: b.name, kind: 'lists', columns: b.columns, archived: b.archived, hidden: b.hidden } as Board
                    ) : b));
                  }}>Stop sharing</button>
                </div>
              </>
            ) : (
              <>
                {showAdvanced && (
                  <>
                    <div className="text-xs text-secondary">Relays override (optional)</div>
                    <div className="flex gap-2 mb-2">
                      <input
                        value={newOverrideRelay}
                        onChange={(e)=>setNewOverrideRelay(e.target.value)}
                        onKeyDown={(e)=>{ if (e.key === 'Enter') { const v = newOverrideRelay.trim(); if (v) { setRelaysCsv(addRelayToCsv(relaysCsv, v)); setNewOverrideRelay(""); } } }}
                        className="pill-input flex-1"
                        placeholder="wss://relay.example"
                      />
                      <button className="ghost-button button-sm pressable" onClick={()=>{ const v = newOverrideRelay.trim(); if (v) { setRelaysCsv(addRelayToCsv(relaysCsv, v)); setNewOverrideRelay(""); } }}>Add</button>
                    </div>
                    <ul className="space-y-2 mb-2">
                      {parseCsv(relaysCsv).map((r) => (
                        <li key={r} className="p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2">
                          <div className="flex-1 truncate">{r}</div>
                          <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>setRelaysCsv(removeRelayFromCsv(relaysCsv, r))}>Delete</button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <button className="accent-button button-sm pressable w-full justify-center" onClick={()=>{onShareBoard(manageBoard.id, showAdvanced ? relaysCsv : ""); setRelaysCsv('');}}>Share this board</button>
              </>
            )}
            <button className="ghost-button button-sm pressable text-rose-400 mt-2 w-full justify-center" onClick={()=>deleteBoard(manageBoard.id)}>Delete board</button>
          </div>
        </div>
      </Modal>
    )}
    </>
  );
}
