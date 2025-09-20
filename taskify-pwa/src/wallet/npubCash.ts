import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, getPublicKey, nip19, type EventTemplate } from "nostr-tools";

const NPUB_CASH_API_BASE = "https://api.npub.cash/api/v1";

export class NpubCashError extends Error {
  status?: number;
  raw?: unknown;

  constructor(message: string, options: { status?: number; raw?: unknown } = {}) {
    super(message);
    this.name = "NpubCashError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = options.status;
    this.raw = options.raw;
  }
}

export type NpubCashIdentity = {
  secretKey: string;
  pubkey: string;
  npub: string;
  address: string;
};

export type NpubCashClaimResult = {
  tokens: string[];
  status: number;
  raw: unknown;
  sourceUrl: string;
};

function encodeBase64(data: string): string {
  if (typeof btoa === "function") {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(data);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }
  const globalBuffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } } }).Buffer;
  if (globalBuffer) {
    return globalBuffer.from(data, "utf8").toString("base64");
  }
  throw new Error("Base64 encoding unavailable");
}

function normalizeSecretKey(secretKey: string): string {
  const trimmed = secretKey.trim();
  if (!trimmed) {
    throw new Error("Missing Nostr secret key");
  }
  if (trimmed.startsWith("nsec")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== "nsec" || !decoded.data) {
        throw new Error("Invalid nsec key");
      }
      if (typeof decoded.data === "string") {
        return decoded.data;
      }
      if (decoded.data instanceof Uint8Array) {
        return bytesToHex(decoded.data);
      }
      if (Array.isArray(decoded.data)) {
        return bytesToHex(Uint8Array.from(decoded.data));
      }
      throw new Error("Unsupported nsec payload");
    } catch (err: any) {
      throw new Error(err?.message || "Invalid nsec key");
    }
  }
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
    throw new Error("Invalid Nostr secret key");
  }
  return trimmed.toLowerCase();
}

export function deriveNpubCashIdentity(secretKey: string): NpubCashIdentity {
  const normalizedSecret = normalizeSecretKey(secretKey);
  const pubkey = getPublicKey(normalizedSecret);
  const npub = nip19.npubEncode(pubkey);
  return {
    secretKey: normalizedSecret,
    pubkey,
    npub,
    address: `${npub}@npub.cash`,
  };
}

function buildNip98AuthHeader(url: string, method: string, secretKeyHex: string, body?: string): string {
  const normalizedMethod = method?.toUpperCase?.() || "GET";
  const template: EventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", normalizedMethod],
    ],
    content: body ?? "",
  };
  const event = finalizeEvent(template, secretKeyHex);
  const payload = JSON.stringify(event);
  return `Nostr ${encodeBase64(payload)}`;
}

function isProbablyJsonString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (
    (first === "{" && last === "}") ||
    (first === "[" && last === "]") ||
    (first === '"' && last === '"')
  );
}

function extractTokensFromString(value: string, seen: Set<string>): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const results: string[] = [];

  if (isProbablyJsonString(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      results.push(...normalizeTokens(parsed, seen));
    } catch {
      // fall through to regex extraction below
    }
  }

  const tokenPattern = /cashu[a-z0-9_-]+/gi;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(trimmed))) {
    const token = match[0];
    if (!seen.has(token)) {
      seen.add(token);
      results.push(token);
    }
  }

  if (!results.length && trimmed.startsWith("cashu")) {
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      results.push(trimmed);
    }
  }

  return results;
}

function normalizeTokens(data: unknown, seen: Set<string> = new Set()): string[] {
  if (!data) return [];
  if (typeof data === "string") {
    return extractTokensFromString(data, seen);
  }
  if (Array.isArray(data)) {
    const nested = data.flatMap((item) => normalizeTokens(item, seen));
    return nested.filter((token) => typeof token === "string" && token.trim().length > 0);
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const collected: string[] = [];
    for (const value of Object.values(obj)) {
      collected.push(...normalizeTokens(value, seen));
    }
    return collected.filter((token) => typeof token === "string" && token.trim().length > 0);
  }
  return [];
}

function uniqueTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

async function readResponseBody(res: Response): Promise<unknown> {
  const contentType = res.headers?.get?.("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

function buildClaimUrls(identity: NpubCashIdentity): string[] {
  const identifiers = [identity.npub, identity.pubkey, identity.pubkey?.toLowerCase?.(), identity.address].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const unique = Array.from(new Set(identifiers.map((value) => value.trim())));
  return unique.map((identifier) => `${NPUB_CASH_API_BASE}/ecash/${encodeURIComponent(identifier)}`);
}

export async function claimPendingEcashFromNpubCash(
  secretKey: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<NpubCashClaimResult> {
  const identity = deriveNpubCashIdentity(secretKey);
  const fetcher = options.fetcher ?? fetch;
  const targets = buildClaimUrls(identity);

  let lastNoTokenStatus: number | null = null;
  let lastNoTokenRaw: unknown = null;
  let lastError: Error | null = null;

  for (const url of targets) {
    try {
      const res = await fetcher(url, {
        method: "GET",
        headers: {
          Authorization: buildNip98AuthHeader(url, "GET", identity.secretKey),
          Accept: "application/json,text/plain",
        },
        signal: options.signal,
      });

      if (res.status === 404 || res.status === 204) {
        lastNoTokenStatus = res.status;
        lastNoTokenRaw = null;
        continue;
      }

      if (!res.ok) {
        const raw = await readResponseBody(res);
        const fallback = `npub.cash error ${res.status}`;
        const message =
          (typeof raw === "string" && raw.trim()) ||
          (raw && typeof raw === "object" && "message" in raw && typeof (raw as any).message === "string"
            ? (raw as any).message
            : undefined) ||
          (res.status === 504
            ? "npub.cash request timed out. Please try again later."
            : res.status === 502
            ? "npub.cash is temporarily unavailable. Please try again soon."
            : fallback);
        lastError = new NpubCashError(message, { status: res.status, raw });
        continue;
      }

      const raw = await readResponseBody(res);
      const tokens = uniqueTokens(normalizeTokens(raw));
      if (!tokens.length) {
        lastNoTokenStatus = res.status;
        lastNoTokenRaw = raw;
        continue;
      }

      return {
        tokens,
        status: res.status,
        raw,
        sourceUrl: url,
      };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (lastNoTokenStatus != null) {
    return {
      tokens: [],
      status: lastNoTokenStatus,
      raw: lastNoTokenRaw,
      sourceUrl: targets[targets.length - 1] ?? "",
    };
  }

  throw (lastError ?? new Error("Unable to fetch npub.cash claims."));
}

export async function acknowledgeNpubCashClaims(
  secretKey: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<boolean> {
  const identity = deriveNpubCashIdentity(secretKey);
  const fetcher = options.fetcher ?? fetch;
  const targets = buildClaimUrls(identity);
  let acknowledged = false;

  for (const url of targets) {
    try {
      const res = await fetcher(url, {
        method: "DELETE",
        headers: {
          Authorization: buildNip98AuthHeader(url, "DELETE", identity.secretKey),
        },
        signal: options.signal,
      });

      if (res.ok || res.status === 404 || res.status === 204) {
        acknowledged = true;
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw err;
      }
      acknowledged = acknowledged || false;
    }
  }

  return acknowledged;
}
