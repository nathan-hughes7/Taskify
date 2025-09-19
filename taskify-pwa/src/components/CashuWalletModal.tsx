import React, { useEffect, useMemo, useRef, useState } from "react";
import { useCashu } from "../context/CashuContext";
import { useNwc } from "../context/NwcContext";
import { loadStore } from "../wallet/storage";
import { ActionSheet } from "./ActionSheet";

export function CashuWalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mintUrl, setMintUrl, balance, info, createMintInvoice, checkMintQuote, claimMint, receiveToken, createSendToken, payInvoice: payMintInvoice } = useCashu();
  const { status: nwcStatus, connection: nwcConnection, info: nwcInfo, lastError: nwcError, connect: connectNwc, disconnect: disconnectNwc, refreshInfo: refreshNwcInfo, getBalanceMsat: getNwcBalanceMsat, payInvoice: payWithNwc, makeInvoice: makeNwcInvoice } = useNwc();

  interface HistoryItem {
    id: string;
    summary: string;
    detail?: string;
  }

  const [showReceiveOptions, setShowReceiveOptions] = useState(false);
  const [showSendOptions, setShowSendOptions] = useState(false);
  const [receiveMode, setReceiveMode] = useState<null | "ecash" | "lightning" | "nwcFund">(null);
  const [sendMode, setSendMode] = useState<null | "ecash" | "lightning" | "nwcWithdraw">(null);

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
  const [nwcUrlInput, setNwcUrlInput] = useState("");
  const [nwcBusy, setNwcBusy] = useState(false);
  const [nwcFeedback, setNwcFeedback] = useState("");

  const [nwcFundAmt, setNwcFundAmt] = useState("");
  const [nwcFundState, setNwcFundState] = useState<"idle" | "creating" | "paying" | "waiting" | "claiming" | "done" | "error">("idle");
  const [nwcFundMessage, setNwcFundMessage] = useState("");
  const [nwcFundInvoice, setNwcFundInvoice] = useState("");

  const [nwcWithdrawAmt, setNwcWithdrawAmt] = useState("");
  const [nwcWithdrawState, setNwcWithdrawState] = useState<"idle" | "requesting" | "paying" | "done" | "error">("idle");
  const [nwcWithdrawMessage, setNwcWithdrawMessage] = useState("");
  const [nwcWithdrawInvoice, setNwcWithdrawInvoice] = useState("");
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
  const hasNwcConnection = !!nwcConnection;
  const nwcAlias = nwcInfo?.alias || nwcConnection?.walletName || "";
  const nwcBalanceSats = typeof nwcInfo?.balanceMsat === "number" ? Math.floor(nwcInfo.balanceMsat / 1000) : null;
  const nwcPrimaryRelay = nwcConnection?.relayUrls?.[0];
  const nwcStatusLabel = useMemo(() => {
    if (!hasNwcConnection) return "Not connected";
    switch (nwcStatus) {
      case "connecting":
        return "Connecting…";
      case "error":
        return "Error";
      default:
        return "Connected";
    }
  }, [hasNwcConnection, nwcStatus]);
  const nwcFundStatusText = useMemo(() => {
    switch (nwcFundState) {
      case "creating":
        return "Creating invoice…";
      case "paying":
        return "Paying via NWC…";
      case "waiting":
        return "Waiting on mint…";
      case "claiming":
        return "Claiming ecash…";
      case "done":
        return "Completed";
      default:
        return "";
    }
  }, [nwcFundState]);
  const nwcWithdrawStatusText = useMemo(() => {
    switch (nwcWithdrawState) {
      case "requesting":
        return "Requesting invoice…";
      case "paying":
        return "Paying from wallet…";
      case "done":
        return "Completed";
      default:
        return "";
    }
  }, [nwcWithdrawState]);
  const nwcFundInProgress = nwcFundState === "creating" || nwcFundState === "paying" || nwcFundState === "waiting" || nwcFundState === "claiming";
  const nwcWithdrawInProgress = nwcWithdrawState === "requesting" || nwcWithdrawState === "paying";

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
      setNwcUrlInput(nwcConnection?.uri || "");
      setNwcBusy(false);
      setNwcFeedback("");
      setNwcFundAmt("");
      setNwcFundState("idle");
      setNwcFundMessage("");
      setNwcFundInvoice("");
      setNwcWithdrawAmt("");
      setNwcWithdrawState("idle");
      setNwcWithdrawMessage("");
      setNwcWithdrawInvoice("");
    }
  }, [open, nwcConnection]);

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
    setNwcUrlInput(nwcConnection?.uri || "");
    setNwcFeedback("");
  }, [showNwcManager, nwcConnection]);

  const headerInfo = useMemo(() => {
    if (!mintUrl) return "No mint set";
    const parts = [info?.name || "Mint", info?.version ? `v${info.version}` : undefined].filter(Boolean);
    return `${parts.join(" ")} • ${mintUrl}`;
  }, [info, mintUrl]);

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
          await payMintInvoice(inv.pr);
          setHistory((h) => [{ id: `sent-${Date.now()}`, summary: `Sent ${amtMsat/1000} sats to ${input}` }, ...h]);
        } else {
          await payMintInvoice(input);
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

  function resetNwcFundState() {
    setNwcFundState("idle");
    setNwcFundMessage("");
    setNwcFundInvoice("");
  }

  function resetNwcWithdrawState() {
    setNwcWithdrawState("idle");
    setNwcWithdrawMessage("");
    setNwcWithdrawInvoice("");
  }

  async function handleNwcConnect() {
    const url = nwcUrlInput.trim();
    if (!url) {
      setNwcFeedback("Enter NWC connection URL");
      return;
    }
    setNwcBusy(true);
    setNwcFeedback("");
    try {
      await connectNwc(url);
      await refreshNwcInfo().catch(() => null);
      await getNwcBalanceMsat().catch(() => null);
      setNwcFeedback("NWC wallet connected");
    } catch (e: any) {
      setNwcFeedback(e?.message || String(e));
    } finally {
      setNwcBusy(false);
    }
  }

  async function handleNwcTest() {
    setNwcBusy(true);
    setNwcFeedback("");
    try {
      const latest = await refreshNwcInfo().catch(() => null);
      const balanceMsat = await getNwcBalanceMsat().catch(() => latest?.balanceMsat ?? null);
      if (typeof balanceMsat === "number") {
        setNwcFeedback(`Balance: ${Math.floor(balanceMsat / 1000)} sats`);
      } else {
        setNwcFeedback("Connection OK");
      }
    } catch (e: any) {
      setNwcFeedback(e?.message || String(e));
    } finally {
      setNwcBusy(false);
    }
  }

  function handleNwcDisconnect() {
    disconnectNwc();
    setNwcUrlInput("");
    setNwcFeedback("Disconnected");
  }

  async function handleNwcFund() {
    setNwcFundMessage("");
    try {
      if (!hasNwcConnection) throw new Error("Connect an NWC wallet first");
      if (!mintUrl) throw new Error("Set an active mint first");
      const amount = Math.max(0, Math.floor(Number(nwcFundAmt) || 0));
      if (!amount) throw new Error("Enter amount in sats");
      setNwcFundState("creating");
      const quote = await createMintInvoice(amount, `Taskify via NWC (${amount} sat)`);
      setNwcFundInvoice(quote.request);
      setNwcFundState("paying");
      await payWithNwc(quote.request);
      setNwcFundState("waiting");
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const state = await checkMintQuote(quote.quote);
        if (state === "PAID" || state === "ISSUED") {
          setNwcFundState("claiming");
          await claimMint(quote.quote, amount);
          setNwcFundState("done");
          setNwcFundMessage(`Added ${amount} sats from NWC wallet`);
          setHistory((h) => [{ id: `nwc-fund-${Date.now()}`, summary: `Funded ${amount} sats via NWC`, detail: quote.request }, ...h]);
          setNwcFundAmt("");
          setNwcFundInvoice("");
          await getNwcBalanceMsat().catch(() => null);
          return;
        }
        await sleep(2500);
      }
      throw new Error("Mint invoice not paid yet. Try again in a moment.");
    } catch (e: any) {
      setNwcFundState("error");
      setNwcFundMessage(e?.message || String(e));
    }
  }

  async function handleNwcWithdraw() {
    setNwcWithdrawMessage("");
    try {
      if (!hasNwcConnection) throw new Error("Connect an NWC wallet first");
      const amount = Math.max(0, Math.floor(Number(nwcWithdrawAmt) || 0));
      if (!amount) throw new Error("Enter amount in sats");
      setNwcWithdrawState("requesting");
      const msat = amount * 1000;
      const invoiceRes = await makeNwcInvoice(msat, `Taskify withdrawal ${amount} sat`);
      setNwcWithdrawInvoice(invoiceRes.invoice);
      setNwcWithdrawState("paying");
      await payMintInvoice(invoiceRes.invoice);
      setHistory((h) => [{ id: `nwc-withdraw-${Date.now()}`, summary: `Withdrew ${amount} sats via NWC`, detail: invoiceRes.invoice }, ...h]);
      setNwcWithdrawState("done");
      setNwcWithdrawMessage(`Sent ${amount} sats to NWC wallet`);
      setNwcWithdrawAmt("");
      await getNwcBalanceMsat().catch(() => null);
    } catch (e: any) {
      setNwcWithdrawState("error");
      setNwcWithdrawMessage(e?.message || String(e));
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
          {hasNwcConnection && (
            <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setReceiveMode("nwcFund")}>
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

      <ActionSheet open={receiveMode === "nwcFund"} onClose={()=>{resetNwcFundState(); setReceiveMode(null); setShowReceiveOptions(false);}} title="Fund via NWC">
        <div className="wallet-section space-y-3">
          <div className="text-xs text-secondary">Creates a mint invoice and pays it automatically with your linked NWC wallet.</div>
          <input className="pill-input" placeholder="Amount (sats)" value={nwcFundAmt} onChange={(e)=>setNwcFundAmt(e.target.value)} />
          <div className="flex flex-wrap gap-2 items-center text-xs text-secondary">
            <button
              className="accent-button button-sm pressable"
              onClick={handleNwcFund}
              disabled={!hasNwcConnection || !mintUrl || nwcFundInProgress || Math.floor(Number(nwcFundAmt) || 0) <= 0}
            >Fund now</button>
            {nwcFundInProgress && nwcFundStatusText && <span>{nwcFundStatusText}</span>}
            {nwcFundState === "done" && nwcFundMessage && <span className="text-accent">{nwcFundMessage}</span>}
            {nwcFundState === "error" && nwcFundMessage && <span className="text-rose-400">{nwcFundMessage}</span>}
          </div>
          {nwcFundInvoice && (
            <div className="bg-surface-muted border border-surface rounded-2xl p-3 space-y-2 text-xs">
              <div className="text-secondary uppercase tracking-wide text-[0.68rem]">Mint invoice (paid)</div>
              <textarea readOnly className="pill-textarea wallet-textarea" value={nwcFundInvoice} />
              <button
                className="ghost-button button-sm pressable"
                onClick={async ()=>{ try { await navigator.clipboard.writeText(nwcFundInvoice); } catch {} }}
              >Copy</button>
            </div>
          )}
          {!hasNwcConnection && (
            <div className="text-xs text-secondary">Connect an NWC wallet from the mint balances sheet to enable this option.</div>
          )}
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
          {hasNwcConnection && (
            <button className="ghost-button button-sm pressable w-full justify-between" onClick={()=>setSendMode("nwcWithdraw")}>
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

      <ActionSheet open={sendMode === "nwcWithdraw"} onClose={()=>{resetNwcWithdrawState(); setSendMode(null); setShowSendOptions(false);}} title="Withdraw via NWC">
        <div className="wallet-section space-y-3">
          <div className="text-xs text-secondary">Requests an invoice from your NWC wallet and pays it using your current Cashu balance.</div>
          <input className="pill-input" placeholder="Amount (sats)" value={nwcWithdrawAmt} onChange={(e)=>setNwcWithdrawAmt(e.target.value)} />
          <div className="flex flex-wrap gap-2 items-center text-xs text-secondary">
            <button
              className="accent-button button-sm pressable"
              onClick={handleNwcWithdraw}
              disabled={!hasNwcConnection || !mintUrl || nwcWithdrawInProgress || Math.floor(Number(nwcWithdrawAmt) || 0) <= 0}
            >Withdraw</button>
            {nwcWithdrawInProgress && nwcWithdrawStatusText && <span>{nwcWithdrawStatusText}</span>}
            {nwcWithdrawState === "done" && nwcWithdrawMessage && <span className="text-accent">{nwcWithdrawMessage}</span>}
            {nwcWithdrawState === "error" && nwcWithdrawMessage && <span className="text-rose-400">{nwcWithdrawMessage}</span>}
          </div>
          {nwcWithdrawInvoice && (
            <div className="bg-surface-muted border border-surface rounded-2xl p-3 space-y-2 text-xs">
              <div className="text-secondary uppercase tracking-wide text-[0.68rem]">Wallet invoice</div>
              <textarea readOnly className="pill-textarea wallet-textarea" value={nwcWithdrawInvoice} />
              <button
                className="ghost-button button-sm pressable"
                onClick={async ()=>{ try { await navigator.clipboard.writeText(nwcWithdrawInvoice); } catch {} }}
              >Copy</button>
            </div>
          )}
          {!hasNwcConnection && (
            <div className="text-xs text-secondary">Connect an NWC wallet to send funds externally.</div>
          )}
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

          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary uppercase tracking-wide">NWC connection</div>
            <div className="space-y-1 text-xs text-secondary">
              <div>{hasNwcConnection ? (nwcAlias ? `Connected to ${nwcAlias}` : "Connected to NWC wallet") : "Link an NWC wallet to move sats between Taskify and your external wallet."}</div>
              {hasNwcConnection && (
                <>
                  <div className="break-all">Wallet npub: {nwcConnection?.walletNpub}</div>
                  {nwcPrimaryRelay && <div className="break-all">Relay: {nwcPrimaryRelay}</div>}
                  {nwcBalanceSats !== null && <div>Reported balance: {nwcBalanceSats} sats</div>}
                  <div>Status: {nwcStatusLabel}</div>
                </>
              )}
            </div>
            <button className="accent-button button-sm pressable" onClick={()=>setShowNwcManager(true)}>
              {hasNwcConnection ? "Manage NWC" : "Connect NWC"}
            </button>
          </div>
        </div>
      </ActionSheet>

      <ActionSheet open={showNwcManager} onClose={()=>{ setShowNwcManager(false); setNwcFeedback(""); setNwcBusy(false); }} title="Manage NWC">
        <div className="space-y-4 text-sm">
          {hasNwcConnection ? (
            <div className="wallet-section space-y-2 text-xs text-secondary">
              {nwcAlias && <div className="text-sm font-semibold text-primary">{nwcAlias}</div>}
              {nwcConnection?.walletLud16 && <div>{nwcConnection.walletLud16}</div>}
              <div className="break-all">Wallet npub: {nwcConnection?.walletNpub}</div>
              <div className="break-all">Client npub: {nwcConnection?.clientNpub}</div>
              <div className="break-all">Relay{(nwcConnection?.relayUrls?.length || 0) > 1 ? 's' : ''}: {nwcConnection?.relayUrls.join(", ")}</div>
              {nwcInfo?.methods && nwcInfo.methods.length > 0 && (
                <div>Methods: {nwcInfo.methods.join(", ")}</div>
              )}
              {nwcBalanceSats !== null && <div>Balance: {nwcBalanceSats} sats</div>}
              <div>Status: {nwcStatusLabel}</div>
            </div>
          ) : (
            <div className="wallet-section text-sm text-secondary">Paste your NWC connection string (nostr+walletconnect://…) to link an external wallet.</div>
          )}

          <div className="wallet-section space-y-3">
            <input
              className="pill-input w-full"
              placeholder="nostr+walletconnect://npub...?relay=wss://...&secret=..."
              value={nwcUrlInput}
              onChange={(e)=>setNwcUrlInput(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <button
                className="accent-button button-sm pressable"
                onClick={handleNwcConnect}
                disabled={nwcBusy || !nwcUrlInput.trim()}
              >{hasNwcConnection ? "Update connection" : "Connect"}</button>
              <button
                className="ghost-button button-sm pressable"
                onClick={handleNwcTest}
                disabled={nwcBusy || !hasNwcConnection}
              >Test</button>
              <button
                className="ghost-button button-sm pressable"
                onClick={handleNwcDisconnect}
                disabled={nwcBusy || !hasNwcConnection}
              >Disconnect</button>
            </div>
            {nwcBusy && <div className="text-xs text-secondary">Working…</div>}
            {nwcFeedback && <div className="text-xs text-secondary">{nwcFeedback}</div>}
            {nwcError && <div className="text-xs text-rose-400">{nwcError}</div>}
          </div>
        </div>
      </ActionSheet>
    </div>
  );
}
