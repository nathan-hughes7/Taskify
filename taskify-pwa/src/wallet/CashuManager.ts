import { CashuMint, CashuWallet, getEncodedToken, type MintQuoteResponse, type MeltQuoteResponse, type Proof } from "@cashu/cashu-ts";
import { addProofs, getProofs, setProofs } from "./storage";

export type MintQuoteState = "UNPAID" | "PAID" | "ISSUED";

export class CashuManager {
  readonly mintUrl: string;
  wallet!: CashuWallet;
  unit = "sat";

  constructor(mintUrl: string) {
    this.mintUrl = mintUrl.replace(/\/$/, "");
  }

  async init() {
    const mint = new CashuMint(this.mintUrl);
    this.wallet = new CashuWallet(mint, { unit: this.unit });
    await this.wallet.loadMint();
  }

  get proofs(): Proof[] {
    return getProofs(this.mintUrl) || [];
  }

  private setProofs(proofs: Proof[]) {
    setProofs(this.mintUrl, proofs);
  }

  get balance(): number {
    return this.proofs.reduce((a, p) => a + (p?.amount || 0), 0);
  }

  async createMintInvoice(amount: number, description?: string) {
    const quote = await this.wallet.createMintQuote(amount, description);
    return quote; // {request, quote, state, expiry, unit, amount}
  }

  async checkMintQuote(quoteOrId: string | MintQuoteResponse): Promise<MintQuoteResponse> {
    // normalize to id
    const res = await (typeof quoteOrId === "string"
      ? this.wallet.checkMintQuote(quoteOrId)
      : this.wallet.checkMintQuote(quoteOrId.quote));
    // Type narrowing: ensure amount/unit exist (MintQuoteResponse) by probing wallet.getMintInfo if needed
    const info = await this.wallet.lazyGetMintInfo();
    return {
      amount: (res as any).amount ?? 0,
      unit: (res as any).unit ?? info?.unit ?? this.unit,
      request: res.request,
      quote: res.quote,
      state: res.state as MintQuoteState,
      expiry: res.expiry,
      pubkey: (res as any).pubkey,
    } as MintQuoteResponse;
  }

  async claimMint(quoteId: string, amount: number) {
    const proofs = await this.wallet.mintProofs(amount, quoteId);
    addProofs(this.mintUrl, proofs);
    return proofs;
  }

  async receiveToken(encoded: string) {
    const newProofs = await this.wallet.receive(encoded);
    addProofs(this.mintUrl, newProofs);
    return newProofs;
  }

  async createSendToken(amount: number, pubkey?: string) {
    const all = this.proofs;
    const bal = all.reduce((a, p) => a + (p?.amount || 0), 0);
    if (bal < amount) {
      throw new Error("Insufficient balance");
    }
    const opts: any = { proofsWeHave: all };
    if (pubkey) opts.pubkey = pubkey;
    const { keep, send } = await this.wallet.send(amount, all, opts);
    this.setProofs(keep);
    const token = getEncodedToken({ mint: this.mintUrl, proofs: send, unit: this.unit });
    return { token, send, keep };
  }

  async createMeltQuote(invoice: string) {
    const quote = await this.wallet.createMeltQuote(invoice);
    return quote; // {quote, amount, fee_reserve, request, state, expiry, unit}
  }

  async payInvoice(invoice: string) {
    const meltQuote = await this.wallet.createMeltQuote(invoice);
    const required = (meltQuote.amount || 0) + (meltQuote.fee_reserve || 0);
    const all = this.proofs;
    const bal = all.reduce((a, p) => a + (p?.amount || 0), 0);
    if (bal < required) throw new Error("Insufficient balance for invoice + fees");

    const { keep, send } = await this.wallet.send(required, all, { proofsWeHave: all });
    this.setProofs(keep);

    const res = await this.wallet.meltProofs(meltQuote as MeltQuoteResponse, send);
    if (res?.change?.length) addProofs(this.mintUrl, res.change);
    return res;
  }
}
