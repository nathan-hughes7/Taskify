import type { Proof } from "@cashu/cashu-ts";

const LS_KEY = "cashu_proofs_v1";
const LS_ACTIVE_MINT = "cashu_active_mint_v1";

export type ProofStore = {
  [mintUrl: string]: Proof[];
};

function safeParse<T>(raw: string | null, fallback: T): T {
  try {
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function loadStore(): ProofStore {
  return safeParse<ProofStore>(localStorage.getItem(LS_KEY), {});
}

export function saveStore(store: ProofStore) {
  localStorage.setItem(LS_KEY, JSON.stringify(store));
}

export function getProofs(mintUrl: string): Proof[] {
  const s = loadStore();
  return Array.isArray(s[mintUrl]) ? s[mintUrl] : [];
}

export function setProofs(mintUrl: string, proofs: Proof[]) {
  const s = loadStore();
  s[mintUrl] = proofs;
  saveStore(s);
}

export function addProofs(mintUrl: string, proofs: Proof[]) {
  const current = getProofs(mintUrl);
  // dedupe by secret
  const merged = [...current, ...proofs];
  const seen = new Set<string>();
  const deduped: Proof[] = [];
  for (const p of merged) {
    if (!p?.secret) continue;
    if (seen.has(p.secret)) continue;
    seen.add(p.secret);
    deduped.push(p);
  }
  setProofs(mintUrl, deduped);
}

export function clearProofs(mintUrl: string) {
  const s = loadStore();
  delete s[mintUrl];
  saveStore(s);
}

export function getActiveMint(): string {
  try {
    return localStorage.getItem(LS_ACTIVE_MINT) || "https://mint.solife.me";
  } catch {
    return "https://mint.solife.me";
  }
}

export function setActiveMint(url: string | null) {
  if (!url) localStorage.removeItem(LS_ACTIVE_MINT);
  else localStorage.setItem(LS_ACTIVE_MINT, url);
}
