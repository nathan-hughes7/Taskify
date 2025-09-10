/**
 * Minimal Cashu wallet integration for demo purposes.
 * Stores tokens in browser localStorage and supports basic send/receive.
 */

import {
  createInvoice as lnCreateInvoice,
  decodeInvoice,
  payInvoice as lnPayInvoice,
} from "./lightning";

export type Token = {
  amount: number;
  secret: string;
};

const STORAGE_KEY = "cashu_tokens_v1";

function loadTokens(): Token[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Token[];
  } catch {}
  return [];
}

function saveTokens(tokens: Token[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  } catch {}
}

export class CashuWallet {
  /** Return current balance (sum of token amounts). */
  get balance(): number {
    return loadTokens().reduce((sum, t) => sum + t.amount, 0);
  }

  /** Receive a token (as JSON string) and store it. */
  receive(tokenStr: string) {
    try {
      const token = JSON.parse(tokenStr) as Token;
      const tokens = loadTokens();
      tokens.push(token);
      saveTokens(tokens);
    } catch {
      throw new Error("Invalid token");
    }
  }

  /** Send tokens totalling the requested amount. Returns token string or null. */
  send(amount: number): string | null {
    if (amount <= 0) return null;
    const tokens = loadTokens();
    const remaining: Token[] = [];
    const toSend: Token[] = [];
    let left = amount;

    for (const t of tokens) {
      if (left <= 0) remaining.push(t);
      else if (t.amount <= left) {
        toSend.push(t);
        left -= t.amount;
      } else {
        // split token
        toSend.push({ amount: left, secret: t.secret + "#part" });
        remaining.push({ amount: t.amount - left, secret: t.secret });
        left = 0;
      }
    }

    if (left > 0) return null; // insufficient balance
    saveTokens(remaining);
    return JSON.stringify(toSend[0]); // simplified single-token return
  }

  /** Create a Lightning invoice for the given amount. */
  async createLightningInvoice(amount: number): Promise<string> {
    return lnCreateInvoice(amount);
  }

  /** Pay a Lightning invoice using wallet balance. */
  async payLightningInvoice(invoice: string) {
    const amount = decodeInvoice(invoice);
    const token = this.send(amount);
    if (!token) throw new Error("Insufficient balance");
    await lnPayInvoice(invoice);
  }
}

export function getWallet() {
  return new CashuWallet();
}

