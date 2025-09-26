/* eslint-disable no-console */
export interface Env {
  ASSETS: AssetFetcher;
  TASKIFY_DEVICES: KVNamespace;
  TASKIFY_REMINDERS: KVNamespace;
  TASKIFY_PENDING: KVNamespace;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
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

interface ScheduledEvent {
  scheduledTime: number;
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

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    event.waitUntil(processDueReminders(env));
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
      await sendPushPing(env, device, deviceId);
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

async function sendPushPing(env: Env, device: DeviceRecord, deviceId: string): Promise<void> {
  try {
    const endpoint = device.subscription.endpoint;
    const url = new URL(endpoint);
    const aud = `${url.protocol}//${url.host}`;
    const token = await createVapidJWT(env, aud);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        TTL: "60",
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
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) {
    throw new Error("VAPID keys are not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 60 * 60; // 12 hours
  const header = base64UrlEncodeJSON({ alg: "ES256", typ: "JWT" });
  const payload = base64UrlEncodeJSON({ aud, exp, sub: env.VAPID_SUBJECT });
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
  const raw = decodePemKey(env.VAPID_PRIVATE_KEY);
  cachedPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    raw,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return cachedPrivateKey;
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

function decodePemKey(pem: string): ArrayBuffer {
  const cleaned = pem.replace(/-----BEGIN [^-----]+-----/g, "").replace(/-----END [^-----]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64UrlEncode(buffer: Uint8Array): string {
  let string = "";
  buffer.forEach((byte) => {
    string += String.fromCharCode(byte);
  });
  return btoa(string).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeJSON(value: unknown): string {
  const text = JSON.stringify(value);
  return base64UrlEncode(new TextEncoder().encode(text));
}
