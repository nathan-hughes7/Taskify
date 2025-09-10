import React, { useEffect, useMemo, useState } from "react";
import { useCashu } from "../context/CashuContext";

export function CashuWalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mintUrl, balance, info, createMintInvoice, checkMintQuote, claimMint, receiveToken, createSendToken, payInvoice } = useCashu();

  const [mintAmt, setMintAmt] = useState<string>("");
  const [mintQuote, setMintQuote] = useState<{ request: string; quote: string; expiry: number } | null>(null);
  const [mintStatus, setMintStatus] = useState<"idle" | "waiting" | "minted" | "error">("idle");
  const [mintError, setMintError] = useState<string>("");

  const [sendAmt, setSendAmt] = useState<string>("");
  const [sendTokenStr, setSendTokenStr] = useState<string>("");

  const [recvTokenStr, setRecvTokenStr] = useState<string>("");
  const [recvMsg, setRecvMsg] = useState<string>("");

  const [lnInvoice, setLnInvoice] = useState<string>("");
  const [lnState, setLnState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [lnError, setLnError] = useState<string>("");

    useEffect(() => {
      if (!open) {
        setMintQuote(null);
        setMintStatus("idle");
      setMintError("");
      setSendTokenStr("");
      setRecvMsg("");
      setLnState("idle");
      setLnError("");
    }
  }, [open]);

  const headerInfo = useMemo(() => {
    if (!mintUrl) return "No mint set";
    const parts = [info?.name || "Mint", info?.version ? `v${info.version}` : undefined].filter(Boolean);
    return `${parts.join(" ")} • ${mintUrl}`;
  }, [info, mintUrl]);

    async function handleCreateInvoice() {
      setMintError("");
      try {
        const amt = Math.max(0, Math.floor(Number(mintAmt) || 0));
        if (!amt) throw new Error("Enter amount in sats");
        const q = await createMintInvoice(amt);
        setMintQuote(q);
        setMintStatus("waiting");
      } catch (e: any) {
        setMintError(e?.message || String(e));
      }
    }

    useEffect(() => {
      if (!mintQuote) return;
      const timer = setInterval(async () => {
        try {
          const st = await checkMintQuote(mintQuote.quote);
          if (st === "PAID") {
            const amt = Math.max(0, Math.floor(Number(mintAmt) || 0));
            await claimMint(mintQuote.quote, amt);
            setMintStatus("minted");
            setMintQuote(null);
            setMintAmt("");
            clearInterval(timer);
          }
        } catch (e: any) {
          setMintError(e?.message || String(e));
          setMintStatus("error");
          clearInterval(timer);
        }
      }, 3000);
      return () => clearInterval(timer);
    }, [mintQuote, mintAmt, checkMintQuote, claimMint]);

  async function handleCreateSendToken() {
    try {
      const amt = Math.max(0, Math.floor(Number(sendAmt) || 0));
      if (!amt) throw new Error("Enter amount in sats");
      const { token } = await createSendToken(amt);
      setSendTokenStr(token);
    } catch (e: any) {
      setSendTokenStr("");
      alert(e?.message || String(e));
    }
  }

  async function handleReceive() {
    setRecvMsg("");
    try {
      const t = recvTokenStr.trim();
      if (!t) throw new Error("Paste a Cashu token");
      const recvd = await receiveToken(t);
      setRecvMsg(`Received ${recvd.reduce((a,p)=>a+(p?.amount||0),0)} sats`);
      setRecvTokenStr("");
    } catch (e: any) {
      setRecvMsg(e?.message || String(e));
    }
  }

  async function handlePayInvoice() {
    setLnState("sending");
    setLnError("");
    try {
      const inv = lnInvoice.trim();
      if (!inv) throw new Error("Paste a BOLT11 invoice");
      await payInvoice(inv);
      setLnState("done");
      setLnInvoice("");
    } catch (e: any) {
      setLnState("error");
      setLnError(e?.message || String(e));
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-2xl rounded-2xl bg-neutral-900 border border-neutral-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">Cashu Wallet</div>
          <button className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700" onClick={onClose}>Close</button>
        </div>

        <div className="text-xs text-neutral-400 mb-3">{headerInfo}</div>
        <div className="mb-4 text-sm">Balance: <span className="font-mono">{balance}</span> sats</div>

        <div className="grid gap-4">
          <section className="rounded-xl border border-neutral-800 p-3">
            <div className="text-sm font-medium mb-2">Top up (Mint eCash)</div>
            <div className="flex gap-2 mb-2">
              <input className="flex-1 px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" placeholder="Amount (sats)" value={mintAmt} onChange={(e)=>setMintAmt(e.target.value)} />
              <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700" onClick={handleCreateInvoice} disabled={!mintUrl}>Get Invoice</button>
            </div>
            {mintQuote && (
              <div className="text-xs bg-neutral-950 border border-neutral-800 rounded-xl p-2">
                <div className="mb-1">Invoice:</div>
                <textarea readOnly className="w-full h-20 bg-transparent outline-none" value={mintQuote.request} />
                <div className="flex gap-2 mt-2">
                  <a className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700" href={`lightning:${mintQuote.request}`}>Open Wallet</a>
                  <button className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700" onClick={()=>navigator.clipboard.writeText(mintQuote.request)}>Copy</button>
                </div>
                <div className="mt-2 text-xs">Status: {mintStatus}</div>
                {mintError && <div className="mt-1 text-xs text-rose-400">{mintError}</div>}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-neutral-800 p-3">
            <div className="text-sm font-medium mb-2">Pay Lightning Invoice with eCash</div>
            <textarea className="w-full h-20 px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" placeholder="Paste BOLT11 invoice" value={lnInvoice} onChange={(e)=>setLnInvoice(e.target.value)} />
            <div className="mt-2 flex gap-2">
              <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700" onClick={handlePayInvoice} disabled={!mintUrl || !lnInvoice}>Pay</button>
              {lnState === "sending" && <div className="text-xs">Paying…</div>}
              {lnState === "done" && <div className="text-xs text-emerald-400">Paid</div>}
              {lnState === "error" && <div className="text-xs text-rose-400">{lnError}</div>}
            </div>
          </section>

          <section className="rounded-xl border border-neutral-800 p-3">
            <div className="text-sm font-medium mb-2">Send eCash</div>
            <div className="flex gap-2 mb-2">
              <input className="flex-1 px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" placeholder="Amount (sats)" value={sendAmt} onChange={(e)=>setSendAmt(e.target.value)} />
              <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700" onClick={handleCreateSendToken} disabled={!mintUrl}>Create Token</button>
            </div>
            {sendTokenStr && (
              <div className="text-xs bg-neutral-950 border border-neutral-800 rounded-xl p-2">
                <textarea readOnly className="w-full h-24 bg-transparent outline-none" value={sendTokenStr} />
                <div className="mt-2">
                  <button className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700" onClick={()=>navigator.clipboard.writeText(sendTokenStr)}>Copy</button>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-neutral-800 p-3">
            <div className="text-sm font-medium mb-2">Receive eCash</div>
            <textarea className="w-full h-24 px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" placeholder="Paste Cashu token (cashuA...)" value={recvTokenStr} onChange={(e)=>setRecvTokenStr(e.target.value)} />
            <div className="mt-2 flex gap-2 items-center">
              <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700" onClick={handleReceive} disabled={!mintUrl || !recvTokenStr}>Redeem</button>
              {recvMsg && <div className="text-xs">{recvMsg}</div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

