import React, { useEffect, useMemo, useRef, useState } from "react";
import { useCashu } from "../context/CashuContext";
import { loadStore } from "../wallet/storage";
import { ActionSheet } from "./ActionSheet";

export function CashuWalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    mintUrl,
    setMintUrl,
    balance,
    info,
    createMintInvoice,
    checkMintQuote,
    claimMint,
    receiveToken,
    createSendToken,
    payInvoice,
    nwcConnection,
    setNwcConnection,
    clearNwcConnection,
    payWithNwc,
    requestNwcInvoice,
  } = useCashu();

  interface HistoryItem {
    id: string;
    summary: string;
    detail?: string;
  }

  const [showReceiveOptions, setShowReceiveOptions] = useState(false);
  const [showSendOptions, setShowSendOptions] = useState(false);
  const [receiveMode, setReceiveMode] = useState<null | "ecash" | "lightning" | "nwc">(null);
  const [sendMode, setSendMode] = useState<null | "ecash" | "lightning" | "nwc">(null);

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
  const [showNwcManager, setShowNwcManager] = useState(false);
  const [nwcInput, setNwcInput] = useState("");
  const [nwcSaveStatus, setNwcSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [nwcSaveError, setNwcSaveError] = useState("");
  const [nwcFundAmt, setNwcFundAmt] = useState("");
  const [nwcFundState, setNwcFundState] = useState<"idle" | "working" | "success" | "error">("idle");
  const [nwcFundMsg, setNwcFundMsg] = useState("");
  const [nwcWithdrawAmt, setNwcWithdrawAmt] = useState("");
  const [nwcWithdrawState, setNwcWithdrawState] = useState<"idle" | "working" | "success" | "error">("idle");
  const [nwcWithdrawMsg, setNwcWithdrawMsg] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem("cashuHistory");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [showHistory, setShowHistory] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const recvRef = useRef<HTMLTextAreaElement | null>(null);
  const lnRef = useRef<HTMLTextAreaElement | null>(null);
  const isLnAddress = useMemo(() => /^[^@\s]+@[^@\s]+$/.test(lnInput), [lnInput]);

  // Mint balances sheet
  const [showMintBalances, setShowMintBalances] = useState(false);
  const [mintInputSheet, setMintInputSheet] = useState("");
  const [mintEntries, setMintEntries] = useState<{ url: string; balance: number; count: number }[]>([]);

  function refreshMintEntries() {
    try {
      const store = loadStore();
      const entries = Object.entries(store).map(([url, proofs]) => ({
        url,
        balance: (Array.isArray(proofs) ? proofs : []).reduce((a: number, p: any) => a + (p?.amount || 0), 0),
        count: (Array.isArray(proofs) ? proofs : []).length,
      }))
      .filter(e => e.count > 0)
      .sort((a, b) => b.balance - a.balance || a.url.localeCompare(b.url));
      setMintEntries(entries);
    } catch {
      setMintEntries([]);
    }
  }

  useEffect(() => {
    localStorage.setItem("cashuHistory", JSON.stringify(history));
  }, [history]);

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
      setShowNwcManager(false);
      setNwcInput("");
      setNwcSaveStatus("idle");
      setNwcSaveError("");
      setNwcFundAmt("");
      setNwcFundState("idle");
      setNwcFundMsg("");
      setNwcWithdrawAmt("");
      setNwcWithdrawState("idle");
      setNwcWithdrawMsg("");
    }
  }, [open]);

  // Removed auto clipboard detection to avoid unwanted paste popup.
  // Users can explicitly paste via dedicated buttons in each view.

  useEffect(() => {
    if (!open || receiveMode !== "ecash") return;
    const timer = setTimeout(() => {
      recvRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [open, receiveMode]);

  useEffect(() => {
    if (!open || sendMode !== "lightning") return;
    const timer = setTimeout(() => {
      lnRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [open, sendMode]);

  useEffect(() => {
    if (!showMintBalances) return;
    setMintInputSheet(mintUrl || "");
    refreshMintEntries();
  }, [showMintBalances, mintUrl]);

  useEffect(() => {
    if (!showNwcManager) return;
    setNwcInput(nwcConnection?.connectionString || "");
    setNwcSaveStatus("idle");
    setNwcSaveError("");
  }, [showNwcManager, nwcConnection]);

  const headerInfo = useMemo(() => {
    if (!mintUrl) return "No mint set";
    const parts = [info?.name || "Mint", info?.version ? `v${info.version}` : undefined].filter(Boolean);
    return `${parts.join(" ")} • ${mintUrl}`;
  }, [info, mintUrl]);

  const shortKey = (key: string) => {
    if (!key) return "";
    return key.length <= 16 ? key : `${key.slice(0, 8)}…${key.slice(-8)}`;
  };

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function handleCreateInvoice() {
    setMintError("");
    try {
      const amt = Math.max(0, Math.floor(Number(mintAmt) || 0));
      if (!amt) throw new Error("Enter amount in sats");
      const q = await createMintInvoice(amt);
      setMintQuote(q);
      setMintStatus("waiting");
      setHistory((h) => [{ id: q.quote, summary: `Invoice for ${amt} sats`, detail: q.request }, ...h]);
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
           setHistory((h) => [{ id: `mint-${Date.now()}`, summary: `Minted ${amt} sats` }, ...h.filter((i) => i.id !== mintQuote.quote)]);
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
      setHistory((h) => [{ id: `token-${Date.now()}`, summary: `Token for ${amt} sats`, detail: token }, ...h]);
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
      const res = await receiveToken(t);
      const amt = res.proofs.reduce((a,p)=>a+(p?.amount||0),0);
      const crossNote = res.crossMint ? ` • Stored at ${res.usedMintUrl}` : '';
      setRecvMsg(`Received ${amt} sats${crossNote}`);
      setRecvTokenStr("");
      setHistory((h) => [{ id: `recv-${Date.now()}`, summary: `Received ${amt} sats${res.crossMint ? ` at ${res.usedMintUrl}` : ''}` }, ...h]);
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
          setHistory((h) => [{ id: `sent-${Date.now()}`, summary: `Sent ${amtMsat/1000} sats to ${input}` }, ...h]);
        } else {
          await payInvoice(input);
          setHistory((h) => [{ id: `paid-${Date.now()}`, summary: `Paid lightning invoice` }, ...h]);
        }
      setLnState("done");
      setLnInput("");
      setLnAddrAmt("");
    } catch (e: any) {
      setLnState("error");
      setLnError(e?.message || String(e));
    }
  }

  async function handleSaveNwcConnection() {
    setNwcSaveStatus("saving");
    setNwcSaveError("");
    try {
      const input = nwcInput.trim();
      if (!input) throw new Error("Paste a NWC connection string");
      await setNwcConnection(input);
      setNwcSaveStatus("saved");
    } catch (e: any) {
      setNwcSaveStatus("error");
      setNwcSaveError(e?.message || String(e));
    }
  }

  function handleDisconnectNwc() {
    clearNwcConnection();
    setNwcInput("");
    setNwcSaveStatus("idle");
    setNwcSaveError("");
  }

  async function handleFundWithNwc() {
    setNwcFundState("working");
    setNwcFundMsg("");
    try {
      if (!nwcConnection) throw new Error("Connect an NWC wallet first");
      const amt = Math.max(0, Math.floor(Number(nwcFundAmt) || 0));
      if (!amt) throw new Error("Enter amount in sats");
      const quote = await createMintInvoice(amt, "Taskify wallet top-up");
      await payWithNwc(quote.request);
      const deadline = Date.now() + 60000;
      let minted = false;
      while (Date.now() < deadline) {
        const status = await checkMintQuote(quote.quote);
        if (status === "PAID" || status === "ISSUED") {
          await claimMint(quote.quote, amt);
          minted = true;
          break;
        }
        await delay(2000);
      }
      if (!minted) throw new Error("Mint did not confirm payment in time");
      setNwcFundState("success");
      setNwcFundMsg(`Added ${amt} sats via NWC`);
      setNwcFundAmt("");
      setHistory((h) => [{ id: `nwc-fund-${Date.now()}`, summary: `Funded ${amt} sats via NWC` }, ...h]);
    } catch (e: any) {
      setNwcFundState("error");
      setNwcFundMsg(e?.message || String(e));
    }
  }

  async function handleWithdrawWithNwc() {
    setNwcWithdrawState("working");
    setNwcWithdrawMsg("");
    try {
      if (!nwcConnection) throw new Error("Connect an NWC wallet first");
      const amt = Math.max(0, Math.floor(Number(nwcWithdrawAmt) || 0));
      if (!amt) throw new Error("Enter amount in sats");
      const invoice = await requestNwcInvoice(amt, "Taskify wallet withdrawal");
      await payInvoice(invoice);
      setNwcWithdrawState("success");
      setNwcWithdrawMsg(`Sent ${amt} sats via NWC`);
      setNwcWithdrawAmt("");
      setHistory((h) => [{ id: `nwc-withdraw-${Date.now()}`, summary: `Withdrew ${amt} sats via NWC` }, ...h]);
    } catch (e: any) {
      setNwcWithdrawState("error");
      setNwcWithdrawMsg(e?.message || String(e));
    }
  }

  if (!open) return null;

  return (
    <div className="wallet-modal">
      <div className="wallet-modal__header">
        <button className="ghost-button button-sm pressable" onClick={onClose}>Close</button>
        <div className="wallet-modal__unit chip chip-accent">{info?.unit?.toUpperCase() || "SAT"}</div>
        <button className="ghost-button button-sm pressable" onClick={()=>setShowHistory(true)}>History</button>
      </div>
      <div className="wallet-modal__toolbar">
        <button className="ghost-button button-sm pressable" onClick={()=>setShowMintBalances(true)}>Mint balances</button>
        <button className="ghost-button button-sm pressable" onClick={()=>setShowNwcManager(true)}>Manage NWC</button>
      </div>
      <div className="wallet-modal__content">
        <div className="wallet-balance-card">
          <div className="wallet-balance-card__amount">{balance} sat</div>
          <div className="wallet-balance-card__meta">{headerInfo}</div>
        </div>
        <div className="wallet-modal__cta">
          <button className="accent-button pressable" onClick={()=>setShowReceiveOptions(true)}>Receive</button>
          <button className="ghost-button pressable" onClick={()=>setShowSendOptions(true)}>Send</button>
        </div>
      </div>

      {/* Receive options */}
      <ActionSheet open={showReceiveOptions && receiveMode === null} onClose={()=>setShowReceiveOptions(false)} title="Receive">
        <div className="wallet-section space-y-2 text-sm">
          <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setReceiveMode("ecash")}>
            <span>eCash token</span>
            <span className="text-tertiary">→</span>
          </button>
          <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setReceiveMode("lightning")}>
            <span>Lightning invoice</span>
            <span className="text-tertiary">→</span>
          </button>
          {nwcConnection && (
            <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setReceiveMode("nwc")}>
              <span>Fund via NWC</span>
              <span className="text-tertiary">→</span>
            </button>
          )}
        </div>
      </ActionSheet>

      <ActionSheet open={receiveMode === "ecash"} onClose={()=>{setReceiveMode(null); setShowReceiveOptions(false); setRecvTokenStr(""); setRecvMsg("");}} title="Receive eCash">
        <div className="wallet-section space-y-3">
          <textarea ref={recvRef} className="pill-textarea wallet-textarea" placeholder="Paste Cashu token (cashuA...)" value={recvTokenStr} onChange={(e)=>setRecvTokenStr(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-secondary">
            <button
              className="ghost-button button-sm pressable"
              onClick={async ()=>{
                try {
                  const t = (await navigator.clipboard.readText())?.trim();
                  if (t) setRecvTokenStr(t);
                } catch {
                  alert('Unable to read clipboard. Please paste manually.');
                }
              }}
            >Paste</button>
            <button className="accent-button button-sm pressable" onClick={handleReceive} disabled={!mintUrl || !recvTokenStr}>Redeem</button>
            {recvMsg && <span className="text-xs">{recvMsg}</span>}
          </div>
        </div>
      </ActionSheet>

      <ActionSheet open={receiveMode === "lightning"} onClose={()=>{setReceiveMode(null); setShowReceiveOptions(false);}} title="Mint via Lightning">
        <div className="wallet-section space-y-3">
          <div className="flex gap-2">
            <input className="pill-input flex-1" placeholder="Amount (sats)" value={mintAmt} onChange={(e)=>setMintAmt(e.target.value)} />
            <button className="accent-button button-sm pressable" onClick={handleCreateInvoice} disabled={!mintUrl}>Get invoice</button>
          </div>
          {mintQuote && (
            <div className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs space-y-2">
              <div className="text-secondary uppercase tracking-wide text-[0.68rem]">Invoice</div>
              <textarea readOnly className="pill-textarea wallet-textarea" value={mintQuote.request} />
              <div className="flex flex-wrap gap-2">
                <a className="ghost-button button-sm pressable" href={`lightning:${mintQuote.request}`}>Open wallet</a>
                <button
                  className="ghost-button button-sm pressable"
                  onClick={async ()=>{ try { await navigator.clipboard.writeText(mintQuote.request); } catch {} }}
                >Copy</button>
              </div>
              <div className="text-xs text-secondary">Status: {mintStatus}</div>
              {mintError && <div className="text-xs text-rose-400">{mintError}</div>}
            </div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet
        open={receiveMode === "nwc"}
        onClose={()=>{
          setReceiveMode(null);
          setShowReceiveOptions(false);
          setNwcFundAmt("");
          setNwcFundState("idle");
          setNwcFundMsg("");
        }}
        title="Fund via NWC"
      >
        <div className="wallet-section space-y-3">
          <div className="text-xs text-secondary">Connected wallet: {nwcConnection ? shortKey(nwcConnection.walletPubkey) : "None"}</div>
          <div className="flex gap-2">
            <input className="pill-input flex-1" placeholder="Amount (sats)" value={nwcFundAmt} onChange={(e)=>setNwcFundAmt(e.target.value)} />
            <button className="accent-button button-sm pressable" onClick={handleFundWithNwc} disabled={!nwcConnection || nwcFundState === "working"}>Fund</button>
          </div>
          {nwcFundState === "working" && <div className="text-xs text-secondary">Funding…</div>}
          {nwcFundState === "success" && <div className="text-xs text-accent">{nwcFundMsg}</div>}
          {nwcFundState === "error" && <div className="text-xs text-rose-400">{nwcFundMsg}</div>}
          {!nwcConnection && <div className="text-xs text-secondary">Connect an NWC wallet in wallet settings.</div>}
        </div>
      </ActionSheet>

      {/* Send options */}
      <ActionSheet open={showSendOptions && sendMode === null} onClose={()=>setShowSendOptions(false)} title="Send">
        <div className="wallet-section space-y-2 text-sm">
          <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setSendMode("ecash")}>
            <span>Create eCash token</span>
            <span className="text-tertiary">→</span>
          </button>
          <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setSendMode("lightning")}>
            <span>Pay lightning invoice</span>
            <span className="text-tertiary">→</span>
          </button>
          {nwcConnection && (
            <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setSendMode("nwc")}>
              <span>Withdraw via NWC</span>
              <span className="text-tertiary">→</span>
            </button>
          )}
        </div>
      </ActionSheet>

      <ActionSheet open={sendMode === "ecash"} onClose={()=>{setSendMode(null); setShowSendOptions(false);}} title="Send eCash">
        <div className="wallet-section space-y-3">
          <div className="flex gap-2">
            <input className="pill-input flex-1" placeholder="Amount (sats)" value={sendAmt} onChange={(e)=>setSendAmt(e.target.value)} />
            <button className="accent-button button-sm pressable" onClick={handleCreateSendToken} disabled={!mintUrl}>Create token</button>
          </div>
          {sendTokenStr && (
            <div className="bg-surface-muted border border-surface rounded-2xl p-3 space-y-2 text-xs">
              <div className="text-secondary uppercase tracking-wide text-[0.68rem]">Token</div>
              <textarea readOnly className="pill-textarea wallet-textarea" value={sendTokenStr} />
              <div className="flex flex-wrap gap-2">
                <button
                  className="ghost-button button-sm pressable"
                  onClick={async ()=>{ try { await navigator.clipboard.writeText(sendTokenStr); } catch {} }}
                >Copy</button>
              </div>
            </div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet open={sendMode === "lightning"} onClose={()=>{setSendMode(null); setShowSendOptions(false); setLnInput(""); setLnAddrAmt(""); setLnState("idle"); setLnError("");}} title="Pay Lightning Invoice">
        <div className="wallet-section space-y-3">
          <textarea ref={lnRef} className="pill-textarea wallet-textarea" placeholder="Paste BOLT11 invoice or enter lightning address" value={lnInput} onChange={(e)=>setLnInput(e.target.value)} />
          {isLnAddress && (
            <input className="pill-input" placeholder="Amount (sats)" value={lnAddrAmt} onChange={(e)=>setLnAddrAmt(e.target.value)} />
          )}
          <div className="flex flex-wrap gap-2 items-center text-xs text-secondary">
            <button
              className="ghost-button button-sm pressable"
              onClick={async ()=>{
                try {
                  const t = (await navigator.clipboard.readText())?.trim();
                  if (t) setLnInput(t);
                } catch {
                  alert('Unable to read clipboard. Please paste manually.');
                }
              }}
            >Paste</button>
            <button className="accent-button button-sm pressable" onClick={handlePayInvoice} disabled={!mintUrl || !lnInput || (isLnAddress && !lnAddrAmt)}>Pay</button>
            {lnState === "sending" && <span className="text-xs">Paying…</span>}
            {lnState === "done" && <span className="text-xs text-accent">Paid</span>}
            {lnState === "error" && <span className="text-xs text-rose-400">{lnError}</span>}
          </div>
        </div>
      </ActionSheet>

      <ActionSheet
        open={sendMode === "nwc"}
        onClose={()=>{
          setSendMode(null);
          setShowSendOptions(false);
          setNwcWithdrawAmt("");
          setNwcWithdrawState("idle");
          setNwcWithdrawMsg("");
        }}
        title="Withdraw via NWC"
      >
        <div className="wallet-section space-y-3">
          <div className="text-xs text-secondary">Connected wallet: {nwcConnection ? shortKey(nwcConnection.walletPubkey) : "None"}</div>
          <div className="flex gap-2">
            <input className="pill-input flex-1" placeholder="Amount (sats)" value={nwcWithdrawAmt} onChange={(e)=>setNwcWithdrawAmt(e.target.value)} />
            <button className="accent-button button-sm pressable" onClick={handleWithdrawWithNwc} disabled={!nwcConnection || nwcWithdrawState === "working"}>Withdraw</button>
          </div>
          {nwcWithdrawState === "working" && <div className="text-xs text-secondary">Processing…</div>}
          {nwcWithdrawState === "success" && <div className="text-xs text-accent">{nwcWithdrawMsg}</div>}
          {nwcWithdrawState === "error" && <div className="text-xs text-rose-400">{nwcWithdrawMsg}</div>}
          {!nwcConnection && <div className="text-xs text-secondary">Connect an NWC wallet in wallet settings.</div>}
        </div>
      </ActionSheet>

      <ActionSheet open={showHistory} onClose={()=>{setShowHistory(false); setExpandedIdx(null);}} title="History">
        {history.length ? (
          <ul className="space-y-2 text-sm">
            {history.map((h, i) => (
              <li key={h.id} className="wallet-section space-y-2">
                <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setExpandedIdx(expandedIdx===i?null:i)}>
                  <span>{h.summary}</span>
                  <span className="text-tertiary">{expandedIdx===i ? '−' : '+'}</span>
                </button>
                {expandedIdx === i && h.detail && (
                  <div className="space-y-2 text-xs">
                    <textarea readOnly className="pill-textarea wallet-textarea" value={h.detail} />
                    <button
                      className="ghost-button button-sm pressable"
                      onClick={async ()=>{ try { await navigator.clipboard.writeText(h.detail!); } catch {} }}
                    >Copy</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="wallet-section text-sm text-secondary">No history yet</div>
        )}
      </ActionSheet>

      <ActionSheet
        open={showNwcManager}
        onClose={()=>{
          setShowNwcManager(false);
          setNwcSaveStatus("idle");
          setNwcSaveError("");
        }}
        title="Manage NWC"
      >
        <div className="space-y-4 text-sm">
          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary uppercase tracking-wide">Connection string</div>
            <textarea
              className="pill-textarea wallet-textarea"
              placeholder="nwc://pubkey?relay=wss://relay&secret=..."
              value={nwcInput}
              onChange={(e)=>setNwcInput(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <button className="accent-button button-sm pressable" onClick={handleSaveNwcConnection} disabled={nwcSaveStatus === "saving"}>Save</button>
              {nwcConnection && (
                <button className="ghost-button button-sm pressable" onClick={handleDisconnectNwc}>Disconnect</button>
              )}
            </div>
            {nwcSaveStatus === "saving" && <div className="text-xs text-secondary">Connecting…</div>}
            {nwcSaveStatus === "saved" && <div className="text-xs text-accent">Connection saved</div>}
            {nwcSaveStatus === "error" && <div className="text-xs text-rose-400">{nwcSaveError}</div>}
          </div>
          {nwcConnection && (
            <div className="wallet-section space-y-2 text-xs">
              <div className="text-secondary uppercase tracking-wide">Active connection</div>
              <div><span className="text-secondary">Relay:</span> {nwcConnection.relay}</div>
              <div><span className="text-secondary">Wallet pubkey:</span> {shortKey(nwcConnection.walletPubkey)}</div>
              <div><span className="text-secondary">Client pubkey:</span> {shortKey(nwcConnection.clientPubkey)}</div>
            </div>
          )}
        </div>
      </ActionSheet>

      {/* Mint balances */}
      <ActionSheet open={showMintBalances} onClose={()=>setShowMintBalances(false)} title="Mint balances">
        <div className="space-y-4 text-sm">
          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary uppercase tracking-wide">Active mint</div>
            <div className="flex gap-2 items-center">
              <input
                className="pill-input flex-1"
                value={mintInputSheet}
                onChange={(e)=>setMintInputSheet(e.target.value)}
                placeholder="https://mint.minibits.cash/Bitcoin"
              />
              <button
                className="accent-button button-sm pressable"
                onClick={async ()=>{ try { await setMintUrl(mintInputSheet.trim()); refreshMintEntries(); } catch (e: any) { alert(e?.message || String(e)); } }}
              >Save</button>
            </div>
            <div className="text-xs text-secondary">Current: {mintUrl}</div>
          </div>

          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary uppercase tracking-wide">Mints with stored ecash</div>
            {mintEntries.length === 0 ? (
              <div className="text-secondary">No ecash stored yet.</div>
            ) : (
              <div className="space-y-2">
                {mintEntries.map(m => (
                  <div key={m.url} className="bg-surface-muted border border-surface rounded-2xl p-3 flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="text-xs text-secondary">{m.url === mintUrl ? 'Active' : 'Mint'}</div>
                      <button
                        className="text-left text-primary underline decoration-dotted decoration-surface-border break-all"
                        title={m.url}
                        onClick={async ()=>{ try { await navigator.clipboard?.writeText(m.url); } catch {} }}
                      >{m.url}</button>
                    </div>
                    <div className="text-right space-y-1">
                      <div className="text-xs text-secondary">Balance</div>
                      <div className="font-semibold">{m.balance} sat</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        className="ghost-button button-sm pressable"
                        onClick={async ()=>{ try { await navigator.clipboard?.writeText(m.url); } catch {} }}
                      >Copy</button>
                      {m.url !== mintUrl && (
                        <button className="accent-button button-sm pressable" onClick={async ()=>{ try { await setMintUrl(m.url); refreshMintEntries(); } catch (e: any) { alert(e?.message || String(e)); } }}>Set active</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </ActionSheet>
    </div>
  );
}
