/* eslint-disable no-console */
export interface Env {
  ASSETS: AssetFetcher;
  TASKIFY_DEVICES: KVNamespace;
  TASKIFY_REMINDERS: KVNamespace;
  TASKIFY_PENDING: KVNamespace;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string | KVNamespace;
  VAPID_SUBJECT: string;
}

type PushPlatform = "ios" | "android";

type SubscriptionRecord = {
  endpoint: string;
  keys: { auth: string; p256dh: string };
};

type DeviceRecord = {
  deviceId: string;
  platform: PushPlatform;
  subscription: SubscriptionRecord;
  endpointHash: string;
};

type ReminderTaskInput = {
  taskId: string;
  boardId?: string;
  title: string;
  dueISO: string;
  minutesBefore: number[];
};

type ReminderEntry = {
  reminderKey: string;
  taskId: string;
  boardId?: string;
  title: string;
  dueISO: string;
  minutes: number;
  sendAt: number;
};

type PendingReminder = {
  taskId: string;
  boardId?: string;
  title: string;
  dueISO: string;
  minutes: number;
};

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface KVNamespaceListKey {
  name: string;
}

interface KVNamespaceListResult {
  keys: KVNamespaceListKey[];
  cursor?: string;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KVNamespaceListResult>;
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const MINUTE_MS = 60_000;
const MAX_LEAD_MS = 30 * 24 * 60 * MINUTE_MS; // 30 days

let cachedPrivateKey: CryptoKey | null = null;
const PRIVATE_KEY_KV_KEYS = ["VAPID_PRIVATE_KEY", "private-key", "key"] as const;

interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

interface SchedulerController {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/config" && request.method === "GET") {
        return jsonResponse({
          workerBaseUrl: url.origin,
          vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
        });
      }
      if (url.pathname === "/api/devices" && request.method === "PUT") {
        return await handleRegisterDevice(request, env);
      }
      if (url.pathname.startsWith("/api/devices/") && request.method === "DELETE") {
        const deviceId = decodeURIComponent(url.pathname.substring("/api/devices/".length));
        return await handleDeleteDevice(deviceId, env);
      }
      if (url.pathname === "/api/reminders" && request.method === "PUT") {
        return await handleSaveReminders(request, env);
      }
      if (url.pathname === "/api/reminders/poll" && request.method === "POST") {
        return await handlePollReminders(request, env);
      }
    } catch (err) {
      console.error("Worker error", err);
      return jsonResponse({ error: (err as Error).message || "Internal error" }, 500);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: SchedulerController): Promise<void> {
    const runner = async () => {
      try {
        await processDueReminders(env);
      } catch (err) {
        console.error('Scheduled task failed', { cron: event?.cron, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    };

    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(runner());
    } else if (event && typeof (event as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil === 'function') {
      (event as unknown as { waitUntil: (promise: Promise<unknown>) => void }).waitUntil(runner());
    } else {
      await runner();
    }
  },
};

async function handleRegisterDevice(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const { deviceId, platform, subscription } = body || {};
  if (!deviceId || typeof deviceId !== "string") {
    return jsonResponse({ error: "deviceId is required" }, 400);
  }
  if (platform !== "ios" && platform !== "android") {
    return jsonResponse({ error: "platform must be ios or android" }, 400);
  }
  if (!subscription || typeof subscription !== "object" || typeof subscription.endpoint !== "string") {
    return jsonResponse({ error: "subscription is required" }, 400);
  }
  if (!subscription.keys || typeof subscription.keys.auth !== "string" || typeof subscription.keys.p256dh !== "string") {
    return jsonResponse({ error: "subscription keys are invalid" }, 400);
  }

  const endpointHash = await hashEndpoint(subscription.endpoint);
  const record: DeviceRecord = {
    deviceId,
    platform,
    subscription: {
      endpoint: subscription.endpoint,
      keys: {
        auth: subscription.keys.auth,
        p256dh: subscription.keys.p256dh,
      },
    },
    endpointHash,
  };

  await env.TASKIFY_DEVICES.put(deviceKey(deviceId), JSON.stringify(record));
  await env.TASKIFY_DEVICES.put(endpointKey(endpointHash), deviceId);

  return jsonResponse({ subscriptionId: endpointHash });
}

async function handleDeleteDevice(deviceId: string, env: Env): Promise<Response> {
  const existing = await env.TASKIFY_DEVICES.get(deviceKey(deviceId));
  if (existing) {
    const record = JSON.parse(existing) as DeviceRecord;
    await env.TASKIFY_DEVICES.delete(endpointKey(record.endpointHash));
  }
  await env.TASKIFY_DEVICES.delete(deviceKey(deviceId));
  await env.TASKIFY_REMINDERS.delete(remindersKey(deviceId));
  await env.TASKIFY_PENDING.delete(pendingKey(deviceId));
  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

async function handleSaveReminders(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const { deviceId, reminders } = body || {};
  if (!deviceId || typeof deviceId !== "string") {
    return jsonResponse({ error: "deviceId is required" }, 400);
  }
  const deviceRecordRaw = await env.TASKIFY_DEVICES.get(deviceKey(deviceId));
  if (!deviceRecordRaw) {
    return jsonResponse({ error: "Unknown device" }, 404);
  }
  if (!Array.isArray(reminders)) {
    return jsonResponse({ error: "reminders must be an array" }, 400);
  }

  const now = Date.now();
  const entries: ReminderEntry[] = [];
  for (const item of reminders as ReminderTaskInput[]) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.taskId !== "string" || typeof item.title !== "string" || typeof item.dueISO !== "string") continue;
    if (!Array.isArray(item.minutesBefore)) continue;
    const dueTime = Date.parse(item.dueISO);
    if (Number.isNaN(dueTime)) continue;
    for (const minutes of item.minutesBefore) {
      if (typeof minutes !== "number" || minutes < 0) continue;
      const sendAt = dueTime - minutes * MINUTE_MS;
      if (sendAt <= now - MINUTE_MS) continue; // skip very old reminders
      if (sendAt - now > MAX_LEAD_MS) continue; // skip too far in future
      const reminderKey = `${item.taskId}:${minutes}`;
      entries.push({
        reminderKey,
        taskId: item.taskId,
        boardId: item.boardId,
        title: item.title,
        dueISO: item.dueISO,
        minutes,
        sendAt,
      });
    }
  }

  if (entries.length > 0) {
    entries.sort((a, b) => a.sendAt - b.sendAt);
    await env.TASKIFY_REMINDERS.put(remindersKey(deviceId), JSON.stringify(entries));
  } else {
    await env.TASKIFY_REMINDERS.delete(remindersKey(deviceId));
  }
  await env.TASKIFY_PENDING.delete(pendingKey(deviceId));

  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

async function handlePollReminders(request: Request, env: Env): Promise<Response> {
  const body = await parseJson(request);
  const { endpoint, deviceId } = body || {};
  let resolvedDeviceId = typeof deviceId === "string" ? deviceId : undefined;
  if (!resolvedDeviceId && typeof endpoint === "string") {
    const hash = await hashEndpoint(endpoint);
    const linkedDevice = await env.TASKIFY_DEVICES.get(endpointKey(hash));
    if (linkedDevice) resolvedDeviceId = linkedDevice;
  }
  if (!resolvedDeviceId) {
    return jsonResponse({ error: "Device not registered" }, 404);
  }
  const pending = await env.TASKIFY_PENDING.get(pendingKey(resolvedDeviceId));
  if (!pending) {
    return jsonResponse([]);
  }
  await env.TASKIFY_PENDING.delete(pendingKey(resolvedDeviceId));
  return jsonResponse(JSON.parse(pending));
}

async function processDueReminders(env: Env): Promise<void> {
  const now = Date.now();
  let cursor: string | undefined;

  do {
    const list = await env.TASKIFY_REMINDERS.list({ prefix: "reminders:", cursor, limit: 1000 });
    cursor = list.cursor;
    for (const entry of list.keys) {
      const deviceId = entry.name.substring("reminders:".length);
      const raw = await env.TASKIFY_REMINDERS.get(entry.name);
      if (!raw) {
        await env.TASKIFY_REMINDERS.delete(entry.name);
        continue;
      }
      let reminders: ReminderEntry[];
      try {
        reminders = JSON.parse(raw) as ReminderEntry[];
      } catch {
        reminders = [];
      }
      if (!Array.isArray(reminders) || reminders.length === 0) {
        await env.TASKIFY_REMINDERS.delete(entry.name);
        continue;
      }

      const remaining: ReminderEntry[] = [];
      const due: ReminderEntry[] = [];
      for (const reminder of reminders) {
        if (reminder.sendAt <= now) {
          due.push(reminder);
        } else {
          remaining.push(reminder);
        }
      }

      if (remaining.length > 0) {
        await env.TASKIFY_REMINDERS.put(entry.name, JSON.stringify(remaining));
      } else {
        await env.TASKIFY_REMINDERS.delete(entry.name);
      }

      if (!due.length) continue;

      const deviceRaw = await env.TASKIFY_DEVICES.get(deviceKey(deviceId));
      if (!deviceRaw) {
        await env.TASKIFY_PENDING.delete(pendingKey(deviceId));
        continue;
      }
      const device = JSON.parse(deviceRaw) as DeviceRecord;
      const pendingNotifications: PendingReminder[] = due.map((reminder) => ({
        taskId: reminder.taskId,
        boardId: reminder.boardId,
        title: reminder.title,
        dueISO: reminder.dueISO,
        minutes: reminder.minutes,
      }));
      await appendPending(env, deviceId, pendingNotifications);
      const ttlSeconds = computeReminderTTL(pendingNotifications, now);
      await sendPushPing(env, device, deviceId, ttlSeconds);
    }
  } while (cursor);
}

async function appendPending(env: Env, deviceId: string, notifications: PendingReminder[]): Promise<void> {
  const key = pendingKey(deviceId);
  const existing = await env.TASKIFY_PENDING.get(key);
  let payload: PendingReminder[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) payload = parsed as PendingReminder[];
    } catch {}
  }
  payload.push(...notifications);
  await env.TASKIFY_PENDING.put(key, JSON.stringify(payload));
}

function computeReminderTTL(reminders: PendingReminder[], now: number): number {
  let ttl = 300; // minimum of 5 minutes to give the device time to wake
  for (const reminder of reminders) {
    if (!reminder || typeof reminder.dueISO !== "string") continue;
    const due = Date.parse(reminder.dueISO);
    if (Number.isNaN(due)) continue;
    const secondsUntilDue = Math.max(0, Math.ceil((due - now) / 1000));
    ttl = Math.max(ttl, secondsUntilDue + 120); // allow a small buffer past due time
  }
  return Math.max(300, Math.min(86400, ttl));
}

async function sendPushPing(env: Env, device: DeviceRecord, deviceId: string, ttlSeconds: number): Promise<void> {
  try {
    const endpoint = device.subscription.endpoint;
    const url = new URL(endpoint);
    const aud = `${url.protocol}//${url.host}`;
    const token = await createVapidJWT(env, aud);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        TTL: String(ttlSeconds),
        Authorization: `WebPush ${token}`,
        "Crypto-Key": `p256ecdsa=${env.VAPID_PUBLIC_KEY}`,
        "Content-Length": "0",
      },
    });

    if (response.status === 404 || response.status === 410) {
      console.warn("Subscription expired", deviceId);
      await handleDeleteDevice(deviceId, env);
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      console.warn("Push ping failed", response.status, text);
    }
  } catch (err) {
    console.error("Push ping error", err);
  }
}

async function createVapidJWT(env: Env, aud: string): Promise<string> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) {
    throw new Error("VAPID keys are not configured");
  }
  const subject = normalizeVapidSubject(env.VAPID_SUBJECT);
  if (!subject) {
    throw new Error("VAPID subject is not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 60 * 60; // 12 hours
  const header = base64UrlEncodeJSON({ alg: "ES256", typ: "JWT" });
  const payload = base64UrlEncodeJSON({ aud, exp, sub: subject });
  const signingInput = `${header}.${payload}`;
  const key = await getPrivateKey(env);
  const signatureBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const signature = base64UrlEncode(new Uint8Array(signatureBuffer));
  return `${signingInput}.${signature}`;
}

async function getPrivateKey(env: Env): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const pem = await resolvePrivateKeyPem(env);
  const keyBytes = decodePemKey(pem);
  if (!keyBytes.length) {
    throw new Error("VAPID private key material is empty");
  }

  try {
    cachedPrivateKey = await crypto.subtle.importKey(
      "pkcs8",
      keyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return cachedPrivateKey;
  } catch (err) {
    if (!shouldAttemptRawVapidImport(err, keyBytes)) {
      throw err;
    }
    cachedPrivateKey = await importRawVapidPrivateKey(env, keyBytes);
    return cachedPrivateKey;
  }
}

async function resolvePrivateKeyPem(env: Env): Promise<string> {
  const binding = env.VAPID_PRIVATE_KEY as unknown;
  if (typeof binding === "string") {
    const trimmed = binding.trim();
    if (trimmed) return trimmed;
  }

  const maybeKv = binding as KVNamespace | undefined;
  if (maybeKv && typeof maybeKv.get === "function") {
    for (const candidate of PRIVATE_KEY_KV_KEYS) {
      try {
        const value = await maybeKv.get(candidate);
        if (value && value.trim()) return value.trim();
      } catch {
        // ignore and try next candidate
      }
    }
  }

  throw new Error("VAPID private key is not configured");
}

function shouldAttemptRawVapidImport(err: unknown, keyBytes: Uint8Array): boolean {
  if (!keyBytes || keyBytes.length !== 32) return false;
  if (!err) return false;
  const name = typeof (err as { name?: string }).name === "string" ? (err as { name?: string }).name : "";
  if (name === "DataError") return true;
  const message = typeof (err as Error).message === "string" ? (err as Error).message : "";
  return /invalid pkcs8/i.test(message);
}

async function importRawVapidPrivateKey(env: Env, scalar: Uint8Array): Promise<CryptoKey> {
  if (scalar.length !== 32) {
    throw new Error("Raw VAPID private key must be 32 bytes");
  }
  if (!env.VAPID_PUBLIC_KEY) {
    throw new Error("VAPID public key is required to import raw private key material");
  }
  const publicBytes = base64UrlDecode(env.VAPID_PUBLIC_KEY.trim());
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) {
    throw new Error("VAPID public key is not a valid uncompressed P-256 point");
  }
  const xBytes = publicBytes.slice(1, 33);
  const yBytes = publicBytes.slice(33, 65);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    ext: false,
    key_ops: ["sign"],
    d: base64UrlEncode(scalar),
    x: base64UrlEncode(xBytes),
    y: base64UrlEncode(yBytes),
  } as JsonWebKey;

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function deviceKey(deviceId: string): string {
  return `device:${deviceId}`;
}

function remindersKey(deviceId: string): string {
  return `reminders:${deviceId}`;
}

function pendingKey(deviceId: string): string {
  return `pending:${deviceId}`;
}

function endpointKey(hash: string): string {
  return `endpoint:${hash}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

async function parseJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function hashEndpoint(endpoint: string): Promise<string> {
  const data = new TextEncoder().encode(endpoint);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodePemKey(pem: string): Uint8Array {
  const trimmed = pem.trim();
  if (!trimmed) return new Uint8Array();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const nested = typeof parsed?.privateKey === "string"
        ? parsed.privateKey
        : typeof parsed?.key === "string"
          ? parsed.key
          : typeof parsed?.value === "string"
            ? parsed.value
            : undefined;
      if (nested) {
        return decodePemKey(nested);
      }
    } catch {
      // fall through to base64 decoding
    }
  }

  const cleaned = trimmed
    .replace(/-----BEGIN [^-----]+-----/g, "")
    .replace(/-----END [^-----]+-----/g, "")
    .replace(/\s+/g, "");

  if (!cleaned) return new Uint8Array();
  return base64UrlDecode(cleaned);
}

function base64UrlEncode(buffer: Uint8Array): string {
  let string = "";
  buffer.forEach((byte) => {
    string += String.fromCharCode(byte);
  });
  return btoa(string).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.length % 4 === 0 ? normalized : `${normalized}${"=".repeat(4 - (normalized.length % 4))}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlEncodeJSON(value: unknown): string {
  const text = JSON.stringify(value);
  return base64UrlEncode(new TextEncoder().encode(text));
}

function normalizeVapidSubject(subjectRaw: string): string {
  if (typeof subjectRaw !== "string") return "";
  const trimmed = subjectRaw.trim();
  if (!trimmed) return "";

  if (/^mailto:/i.test(trimmed)) {
    const mailto = trimmed.replace(/^mailto:/i, "").replace(/\s+/g, "");
    return mailto ? `mailto:${mailto}` : "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\s+/g, "");
  }

  return trimmed;
}
