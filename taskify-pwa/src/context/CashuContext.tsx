import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Proof } from "@cashu/cashu-ts";
import { getDecodedToken } from "@cashu/cashu-ts";
import { CashuManager } from "../wallet/CashuManager";
import { getActiveMint, setActiveMint as persistActiveMint } from "../wallet/storage";

type MintInfo = {
  name?: string;
  unit?: string;
  version?: string;
};

type CashuContextType = {
  ready: boolean;
  mintUrl: string;
  setMintUrl: (url: string) => Promise<void>;
  balance: number;
  proofs: Proof[];
  info: MintInfo | null;
  createMintInvoice: (amount: number, description?: string) => Promise<{ request: string; quote: string; expiry: number }>;
  checkMintQuote: (quoteId: string) => Promise<"UNPAID" | "PAID" | "ISSUED">;
  claimMint: (quoteId: string, amount: number) => Promise<Proof[]>;
  receiveToken: (encoded: string) => Promise<{ proofs: Proof[]; usedMintUrl: string; activeMintUrl: string; crossMint: boolean }>;
  createSendToken: (amount: number) => Promise<{ token: string }>;
  payInvoice: (invoice: string) => Promise<{ state: string }>;
};

const CashuContext = createContext<CashuContextType | null>(null);

export function CashuProvider({ children }: { children: React.ReactNode }) {
  const [mintUrl, setMintUrlState] = useState<string>(() => getActiveMint());
  const [manager, setManager] = useState<CashuManager | null>(null);
  const [ready, setReady] = useState(false);
  const [balance, setBalance] = useState(0);
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [info, setInfo] = useState<MintInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      setReady(false);
      setInfo(null);
      if (!mintUrl) {
        setManager(null);
        setBalance(0);
        setProofs([]);
        setReady(true);
        return;
      }
      try {
        const m = new CashuManager(mintUrl);
        await m.init();
        if (cancelled) return;
        setManager(m);
        setBalance(m.balance);
        setProofs(m.proofs);
        const mi = await m.wallet.getMintInfo();
        setInfo({ name: mi?.name, unit: (mi as any)?.unit ?? "sat", version: mi?.version });
      } catch (e) {
        console.error("Failed to init Cashu", e);
        setManager(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    boot();
    return () => { cancelled = true; };
  }, [mintUrl]);

  const setMintUrl = useCallback(async (url: string) => {
    const clean = url.trim().replace(/\/$/, "");
    setMintUrlState(clean);
    persistActiveMint(clean);
  }, []);

  const createMintInvoice = useCallback(async (amount: number, description?: string) => {
    if (!manager) throw new Error("Wallet not ready");
    const q = await manager.createMintInvoice(amount, description);
    return { request: q.request, quote: q.quote, expiry: q.expiry };
  }, [manager]);

  const checkMintQuote = useCallback(async (quoteId: string) => {
    if (!manager) throw new Error("Wallet not ready");
    const q = await manager.checkMintQuote(quoteId);
    return q.state;
  }, [manager]);

  const claimMint = useCallback(async (quoteId: string, amount: number) => {
    if (!manager) throw new Error("Wallet not ready");
    const proofs = await manager.claimMint(quoteId, amount);
    setBalance(manager.balance);
    setProofs(manager.proofs);
    return proofs;
  }, [manager]);

  const receiveToken = useCallback(async (encoded: string) => {
    if (!manager) throw new Error("Wallet not ready");
    try {
      // Try to decode token to detect its mint. Handle both single-entry and multi-entry shapes.
      const decoded: any = getDecodedToken(encoded);
      const entry = Array.isArray(decoded?.token) ? decoded.token[0] : decoded;
      const tokenMint: string | undefined = (entry && typeof entry.mint === 'string') ? entry.mint : undefined;
      const normalize = (u: string) => u.replace(/\/$/, "");

      if (tokenMint && normalize(tokenMint) !== normalize(manager.mintUrl)) {
        // Receive using the token's mint without changing active mint state.
        const other = new CashuManager(tokenMint);
        await other.init();
        const proofs = await other.receiveToken(encoded);
        // Do not touch current manager balance/proofs because active mint differs.
        return { proofs, usedMintUrl: other.mintUrl, activeMintUrl: manager.mintUrl, crossMint: true };
      }
    } catch {
      // If decoding fails, fall back to active manager.receive (may still work for legacy tokens)
    }

    const proofs = await manager.receiveToken(encoded);
    setBalance(manager.balance);
    setProofs(manager.proofs);
    return { proofs, usedMintUrl: manager.mintUrl, activeMintUrl: manager.mintUrl, crossMint: false };
  }, [manager]);

  const createSendToken = useCallback(async (amount: number) => {
    if (!manager) throw new Error("Wallet not ready");
    const res = await manager.createSendToken(amount);
    setBalance(manager.balance);
    setProofs(manager.proofs);
    return { token: res.token };
  }, [manager]);

  const payInvoice = useCallback(async (invoice: string) => {
    if (!manager) throw new Error("Wallet not ready");
    const res = await manager.payInvoice(invoice);
    setBalance(manager.balance);
    setProofs(manager.proofs);
    return { state: (res.quote as any)?.state ?? "" };
  }, [manager]);

  const value = useMemo<CashuContextType>(() => ({
    ready,
    mintUrl,
    setMintUrl,
    balance,
    proofs,
    info,
    createMintInvoice,
    checkMintQuote,
    claimMint,
    receiveToken,
    createSendToken,
    payInvoice,
  }), [ready, mintUrl, setMintUrl, balance, proofs, info, createMintInvoice, checkMintQuote, claimMint, receiveToken, createSendToken, payInvoice]);

  return <CashuContext.Provider value={value}>{children}</CashuContext.Provider>;
}

export function useCashu() {
  const ctx = useContext(CashuContext);
  if (!ctx) throw new Error("useCashu must be used within CashuProvider");
  return ctx;
}
