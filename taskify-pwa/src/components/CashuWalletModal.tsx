import React, { useEffect, useMemo, useRef, useState } from "react";
import { useCashu } from "../context/CashuContext";
import { ActionSheet } from "./ActionSheet";

export function CashuWalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mintUrl, balance, info, createMintInvoice, checkMintQuote, claimMint, receiveToken, createSendToken, payInvoice } = useCashu();

  const [showReceiveOptions, setShowReceiveOptions] = useState(false);
  const [showSendOptions, setShowSendOptions] = useState(false);
  const [receiveMode, setReceiveMode] = useState<null | "ecash" | "lightning">(null);
  const [sendMode, setSendMode] = useState<null | "ecash" | "lightning">(null);

  const [mintAmt, setMintAmt] = useState("");
  const [mintQuote, setMintQuote] = useState<{ request: string; quote: string; expiry: number } | null>(null);
  const [mintStatus, setMintStatus] = useState<"idle" | "waiting" | "minted" | "error">("idle");
  const [mintError, setMintError] = useState("");

  const [sendAmt, setSendAmt] = useState("");
  const [sendTokenStr, setSendTokenStr] = useState("");

  const [recvTokenStr, setRecvTokenStr] = useState("");
  const [recvMsg, setRecvMsg] = useState("");

  const [lnInput, setLnInput] = useState("");
  const [lnAddrAmt, setLnAddrAmt] = useState("");
  const [lnState, setLnState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [lnError, setLnError] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const recvRef = useRef<HTMLTextAreaElement | null>(null);
  const lnRef = useRef<HTMLTextAreaElement | null>(null);
  const isLnAddress = useMemo(() => /^[^@\s]+@[^@\s]+$/.test(lnInput), [lnInput]);

  useEffect(() => {
    if (!open) {
      setSendTokenStr("");
      setRecvTokenStr("");
      setRecvMsg("");
      setLnInput("");
      setLnAddrAmt("");
      setLnState("idle");
      setLnError("");
      setShowReceiveOptions(false);
      setShowSendOptions(false);
      setReceiveMode(null);
      setSendMode(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const t = (await navigator.clipboard.readText()).trim();
        if (t.startsWith("cashu")) {
          setReceiveMode("ecash");
          setRecvTokenStr(t);
        } else if (/^ln\w+/i.test(t) || /^[^@\s]+@[^@\s]+$/.test(t)) {
          setSendMode("lightning");
          setLnInput(t);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!open || receiveMode !== "ecash") return;
    recvRef.current?.focus();
    (async () => {
      try {
        const t = (await navigator.clipboard.readText()).trim();
        if (t.startsWith("cashu")) setRecvTokenStr(t);
      } catch {
        /* ignore */
      }
    })();
  }, [open, receiveMode]);

  useEffect(() => {
    if (!open || sendMode !== "lightning") return;
    lnRef.current?.focus();
    (async () => {
      try {
        const t = (await navigator.clipboard.readText()).trim();
        if (/^ln\w+/i.test(t) || /^[^@\s]+@[^@\s]+$/.test(t)) setLnInput(t);
      } catch {
        /* ignore */
      }
    })();
  }, [open, sendMode]);

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
          setHistory((h) => [`Minted ${amt} sats`, ...h]);
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
      const amt = recvd.reduce((a,p)=>a+(p?.amount||0),0);
      setRecvMsg(`Received ${amt} sats`);
      setRecvTokenStr("");
      setHistory((h) => [`Received ${amt} sats`, ...h]);
    } catch (e: any) {
      setRecvMsg(e?.message || String(e));
    }
  }

  async function handlePayInvoice() {
    setLnState("sending");
    setLnError("");
    try {
      const input = lnInput.trim();
      if (!input) throw new Error("Paste an invoice or enter lightning address");
      if (/^[^@\s]+@[^@\s]+$/.test(input)) {
        const [name, domain] = input.split("@");
        const infoRes = await fetch(`https://${domain}/.well-known/lnurlp/${name}`);
        const info = await infoRes.json();
        const amtMsat = Math.max(info.minSendable || 0, Math.min(info.maxSendable || Infinity, Math.floor(Number(lnAddrAmt) || 0) * 1000));
        if (!amtMsat) throw new Error("Enter amount in sats");
        const invRes = await fetch(`${info.callback}?amount=${amtMsat}`);
        const inv = await invRes.json();
        await payInvoice(inv.pr);
        setHistory((h) => [`Sent ${amtMsat/1000} sats to ${input}`, ...h]);
      } else {
        await payInvoice(input);
        setHistory((h) => [`Paid lightning invoice`, ...h]);
      }
      setLnState("done");
      setLnInput("");
      setLnAddrAmt("");
    } catch (e: any) {
      setLnState("error");
      setLnError(e?.message || String(e));
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-neutral-950 text-white">
      <div className="flex items-center justify-between p-4">
        <button className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700" onClick={onClose}>Close</button>
        <div className="text-sm font-medium">{info?.unit?.toUpperCase() || "SAT"}</div>
        <button className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700" onClick={()=>setShowHistory(true)}>History</button>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="text-5xl font-semibold mb-1">{balance} sat</div>
        <div className="text-neutral-400 text-xs">{headerInfo}</div>
      </div>
      <div className="p-4 flex gap-3">
        <button className="flex-1 py-3 rounded-full bg-neutral-100 text-neutral-900 font-semibold" onClick={()=>setShowReceiveOptions(true)}>RECEIVE</button>
        <button className="flex-1 py-3 rounded-full bg-neutral-100 text-neutral-900 font-semibold" onClick={()=>setShowSendOptions(true)}>SEND</button>
      </div>

      {/* Receive options */}
      <ActionSheet open={showReceiveOptions && receiveMode === null} onClose={()=>setShowReceiveOptions(false)} title="Receive">
        <div className="grid gap-2">
          <button className="w-full px-4 py-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-left" onClick={()=>setReceiveMode("ecash")}>ECASH</button>
          <button className="w-full px-4 py-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-left" onClick={()=>setReceiveMode("lightning")}>LIGHTNING</button>
        </div>
      </ActionSheet>

      <ActionSheet open={receiveMode === "ecash"} onClose={()=>{setReceiveMode(null); setShowReceiveOptions(false); setRecvTokenStr(""); setRecvMsg("");}} title="Receive eCash">
        <textarea ref={recvRef} className="w-full h-24 px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" placeholder="Paste Cashu token (cashuA...)" value={recvTokenStr} onChange={(e)=>setRecvTokenStr(e.target.value)} />
        <div className="mt-2 flex gap-2 items-center">
          <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700" onClick={handleReceive} disabled={!mintUrl || !recvTokenStr}>Redeem</button>
          {recvMsg && <div className="text-xs">{recvMsg}</div>}
        </div>
      </ActionSheet>

      <ActionSheet open={receiveMode === "lightning"} onClose={()=>{setReceiveMode(null); setShowReceiveOptions(false);}} title="Mint via Lightning">
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
      </ActionSheet>

      {/* Send options */}
      <ActionSheet open={showSendOptions && sendMode === null} onClose={()=>setShowSendOptions(false)} title="Send">
        <div className="grid gap-2">
          <button className="w-full px-4 py-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-left" onClick={()=>setSendMode("ecash")}>ECASH</button>
          <button className="w-full px-4 py-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-left" onClick={()=>setSendMode("lightning")}>LIGHTNING</button>
        </div>
      </ActionSheet>

      <ActionSheet open={sendMode === "ecash"} onClose={()=>{setSendMode(null); setShowSendOptions(false);}} title="Send eCash">
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
      </ActionSheet>

      <ActionSheet open={sendMode === "lightning"} onClose={()=>{setSendMode(null); setShowSendOptions(false); setLnInput(""); setLnAddrAmt(""); setLnState("idle"); setLnError("");}} title="Pay Lightning Invoice">
        <textarea ref={lnRef} className="w-full h-20 px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" placeholder="Paste BOLT11 invoice or enter lightning address" value={lnInput} onChange={(e)=>setLnInput(e.target.value)} />
        {isLnAddress && (
          <input className="mt-2 w-full px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" placeholder="Amount (sats)" value={lnAddrAmt} onChange={(e)=>setLnAddrAmt(e.target.value)} />
        )}
        <div className="mt-2 flex gap-2">
          <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700" onClick={handlePayInvoice} disabled={!mintUrl || !lnInput || (isLnAddress && !lnAddrAmt)}>Pay</button>
          {lnState === "sending" && <div className="text-xs">Paying…</div>}
          {lnState === "done" && <div className="text-xs text-emerald-400">Paid</div>}
          {lnState === "error" && <div className="text-xs text-rose-400">{lnError}</div>}
        </div>
      </ActionSheet>

      <ActionSheet open={showHistory} onClose={()=>setShowHistory(false)} title="History">
        {history.length ? (
          <ul className="text-sm space-y-1">
            {history.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        ) : (
          <div className="text-sm">No history yet</div>
        )}
      </ActionSheet>
    </div>
  );
}

