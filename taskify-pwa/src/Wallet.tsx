import React, { useEffect, useState } from "react";
import { EcashLightningWallet } from "./cashuWallet";

/**
 * Minimal wallet UI allowing users to interact with ecash and
 * Lightning via the cashu-ts library.
 */
export default function Wallet({ mint = "https://mint.solife.me" }: { mint?: string }) {
  const [wallet, setWallet] = useState(() => new EcashLightningWallet(mint));
  const [balance, setBalance] = useState(0);
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState<string>("");
  const [invoice, setInvoice] = useState("");

  useEffect(() => {
    setWallet(new EcashLightningWallet(mint));
  }, [mint]);

  useEffect(() => {
    wallet.balance().then(setBalance).catch(() => {});
  }, [wallet]);

  async function handleReceive() {
    if (!token) return;
    await wallet.receiveToken(token);
    setToken("");
    setBalance(await wallet.balance());
  }

  async function handleSend() {
    if (!amount) return;
    const t = await wallet.sendToken(Number(amount));
    await navigator.clipboard?.writeText(t);
    setAmount("");
    setBalance(await wallet.balance());
  }

  async function handleMint() {
    if (!amount || !invoice) return;
    await wallet.mintViaInvoice(Number(amount), invoice);
    setAmount("");
    setInvoice("");
    setBalance(await wallet.balance());
  }

  async function handlePay() {
    if (!invoice) return;
    await wallet.payInvoice(invoice);
    setInvoice("");
    setBalance(await wallet.balance());
  }

  return (
    <section className="mt-6 space-y-3">
      <div className="text-sm">Wallet balance: {balance} sats</div>
      <div className="flex gap-2">
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
          placeholder="Paste ecash token"
        />
        <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={handleReceive}>
          Receive
        </button>
      </div>
      <div className="flex gap-2">
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-24 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
          placeholder="Amount"
        />
        <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={handleSend}>
          Send
        </button>
      </div>
      <div className="flex gap-2">
        <input
          value={invoice}
          onChange={(e) => setInvoice(e.target.value)}
          className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800"
          placeholder="Lightning invoice"
        />
        <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={handleMint}>
          Mint
        </button>
        <button className="px-3 py-2 rounded-xl bg-neutral-800" onClick={handlePay}>
          Pay
        </button>
      </div>
    </section>
  );
}
