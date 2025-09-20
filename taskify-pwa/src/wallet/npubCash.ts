import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, getPublicKey, nip19, type EventTemplate } from "nostr-tools";

const NPUB_CASH_API_BASE = "https://api.npub.cash/api/v1";

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

function normalizeTokens(data: unknown): string[] {
  if (!data) return [];
  if (typeof data === "string") {
    const trimmed = data.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(data)) {
    const nested = data.flatMap((item) => normalizeTokens(item));
    return nested.filter((token) => typeof token === "string" && token.trim().length > 0);
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const collected: string[] = [];
    const keysToProbe = ["token", "tokens", "ecash", "proofs", "result", "values"] as const;
    for (const key of keysToProbe) {
      if (key in obj) {
        collected.push(...normalizeTokens(obj[key]));
      }
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

export async function claimPendingEcashFromNpubCash(
  secretKey: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<NpubCashClaimResult> {
  const identity = deriveNpubCashIdentity(secretKey);
  const fetcher = options.fetcher ?? fetch;
  const targets = [
    `${NPUB_CASH_API_BASE}/ecash/${identity.npub}`,
    `${NPUB_CASH_API_BASE}/ecash/${identity.pubkey}`,
  ];

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
        const bodyText = await res.text().catch(() => "");
        lastError = new Error(bodyText || `npub.cash error ${res.status}`);
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
    };
  }

  throw (lastError ?? new Error("Unable to fetch npub.cash claims."));
}
