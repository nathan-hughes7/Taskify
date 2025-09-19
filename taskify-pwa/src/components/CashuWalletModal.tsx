import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bech32 } from "bech32";
import { decodePaymentRequest, PaymentRequest, PaymentRequestTransportType, type PaymentRequestTransport } from "@cashu/cashu-ts";
import QrScannerLib, { type QrScannerScanResult as ScanResult } from "qr-scanner";
import qrScannerWorkerPath from "qr-scanner/qr-scanner-worker.min.js?url";
import { QRCodeCanvas } from "qrcode.react";
import { useCashu } from "../context/CashuContext";
import { useNwc } from "../context/NwcContext";
import { loadStore } from "../wallet/storage";
import { ActionSheet } from "./ActionSheet";

const LNURL_DECODE_LIMIT = 2048;

function decodeLnurlString(lnurl: string): string {
  try {
    const trimmed = lnurl.trim();
    const decoded = bech32.decode(trimmed.toLowerCase(), LNURL_DECODE_LIMIT);
    const bytes = bech32.fromWords(decoded.words);
    return new TextDecoder().decode(Uint8Array.from(bytes));
  } catch {
    throw new Error("Invalid LNURL");
  }
}

function normalizeMintUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function extractDomain(target: string): string {
  try {
    const hostname = new URL(target).hostname;
    return hostname || target;
  } catch {
    return target;
  }
}

type LnurlPayData = {
  lnurl: string;
  callback: string;
  domain: string;
  minSendable: number;
  maxSendable: number;
  commentAllowed: number;
  metadata?: string;
};

type LnurlWithdrawData = {
  lnurl: string;
  callback: string;
  domain: string;
  k1: string;
  minWithdrawable: number;
  maxWithdrawable: number;
  defaultDescription?: string;
};

function QrCodeCard({ value, label, copyLabel = "Copy", extraActions, size = 220, className }: { value: string; label: string; copyLabel?: string; extraActions?: React.ReactNode; size?: number; className?: string; }) {
  const trimmed = value?.trim();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!trimmed) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(trimmed);
      setCopied(true);
    } catch (e) {
      console.warn("Copy failed", e);
      setCopied(false);
    }
  }

  return (
    <div className={`wallet-qr-card${className ? ` ${className}` : ""}`}>
      <div className="wallet-qr-card__label">{label}</div>
      <div className="wallet-qr-card__code" aria-live="polite">
        <div className="wallet-qr-card__canvas" aria-hidden="true">
          <QRCodeCanvas value={trimmed} size={size} includeMargin={false} className="wallet-qr-card__qr" />
        </div>
      </div>
      <div className="wallet-qr-card__actions">
        {extraActions}
        <button className="ghost-button button-sm pressable" onClick={handleCopy} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? "Copied" : copyLabel}
        </button>
      </div>
    </div>
  );
}

function QrScanner({ active, onDetected, onError }: { active: boolean; onDetected: (value: string) => boolean | Promise<boolean>; onError?: (message: string) => void; }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const processingRef = useRef(false);
  const closingRef = useRef(false);
  const lastValueRef = useRef<string | null>(null);
  const resetTimerRef = useRef<number>();
  const [error, setError] = useState<string | null>(null);

  const reportError = useCallback((message: string) => {
    setError(message);
    if (onError) onError(message);
  }, [onError]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const stopScanner = useCallback(() => {
    if (controlsRef.current) {
      try {
        controlsRef.current.stop();
      } catch (err) {
        console.warn("Failed to stop scanner", err);
      }
      controlsRef.current = null;
    }
    const video = videoRef.current;
    const stream = (video?.srcObject as MediaStream | null) || null;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    if (readerRef.current) {
      readerRef.current.reset();
    }
    closingRef.current = false;
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!active) {
      stopScanner();
      clearError();
      lastValueRef.current = null;
      processingRef.current = false;
      closingRef.current = false;
      return;
    }

    if (!navigator?.mediaDevices?.getUserMedia) {
      reportError("Camera access not supported on this device");
      return;
    }

    async function start() {
      try {
        clearError();
        if (!readerRef.current) {
          const hints = new Map();
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
          readerRef.current = new BrowserMultiFormatReader(hints, 180);
        } else {
          readerRef.current.reset();
        }
        const reader = readerRef.current;
        const video = videoRef.current;
        if (!reader || !video) throw new Error("Unable to access camera");

        const constraints: MediaStreamConstraints = {
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        };

        const controls = await reader.decodeFromConstraints(constraints, video, async (result, err, ctrl) => {
          if (cancelled || !active) {
            ctrl.stop();
            return;
          }
          if (result) {
            const raw = result.getText()?.trim();
            if (raw && !closingRef.current && raw !== lastValueRef.current) {
              if (!processingRef.current) {
                processingRef.current = true;
                lastValueRef.current = raw;
                if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
                resetTimerRef.current = window.setTimeout(() => {
                  if (!closingRef.current) lastValueRef.current = null;
                }, 1400);

                let shouldClose = false;
                try {
                  shouldClose = await onDetected(raw);
                } catch (handlerError) {
                  console.warn("QR handler failed", handlerError);
                }

                if (shouldClose) {
                  closingRef.current = true;
                  return;
                }

                processingRef.current = false;
              }
            } else if (!raw) {
              lastValueRef.current = null;
            }
          } else if (err && (err as { name?: string }).name !== "NotFoundException") {
            console.warn("ZXing scanner error", err);
          }
        });

        if (cancelled) {
          controls.stop();
          return;
        }

        controlsRef.current = controls;
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (/NotAllowedError|denied/i.test(message)) {
          reportError("Camera permission denied");
        } else if (/NotFoundError|device not found/i.test(message)) {
          reportError("Camera not available");
        } else {
          reportError(message || "Unable to access camera");
        }
        stopScanner();
      }
    }

    start();

    return () => {
      cancelled = true;
      stopScanner();
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = undefined;
      }
      lastValueRef.current = null;
      processingRef.current = false;
      closingRef.current = false;
    };
  }, [active, clearError, onDetected, reportError, stopScanner]);

  return (
    <div className="wallet-scanner space-y-3">
      <div className={`wallet-scanner__viewport${error ? " wallet-scanner__viewport--error" : ""}`}>
        {error ? (
          <div className="wallet-scanner__fallback">{error}</div>
        ) : (
          <>
            <video ref={videoRef} className="wallet-scanner__video" playsInline muted />
            <div className="wallet-scanner__guide" aria-hidden="true" />
          </>
        )}
      </div>
      <div className="wallet-scanner__hint text-xs text-secondary text-center">
        {error ? "Camera unavailable. Try entering the code manually." : "Align a QR code inside the frame."}
      </div>
    </div>
  );
}

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
  const [showScanner, setShowScanner] = useState(false);
  const [scannerMessage, setScannerMessage] = useState("");
  type PendingScan =
    | { type: "ecash"; token: string }
    | { type: "bolt11"; invoice: string }
    | { type: "lightningAddress"; address: string }
    | { type: "lnurl"; data: string }
    | { type: "paymentRequest"; request: string };
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [receiveMode, setReceiveMode] = useState<null | "ecash" | "lightning" | "lnurlWithdraw" | "nwcFund">(null);
  const [sendMode, setSendMode] = useState<null | "ecash" | "lightning" | "paymentRequest" | "nwcWithdraw">(null);

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
  const [lnurlPayData, setLnurlPayData] = useState<LnurlPayData | null>(null);

  const [lnurlWithdrawInfo, setLnurlWithdrawInfo] = useState<LnurlWithdrawData | null>(null);
  const [lnurlWithdrawAmt, setLnurlWithdrawAmt] = useState("");
  const [lnurlWithdrawState, setLnurlWithdrawState] = useState<"idle" | "creating" | "waiting" | "done" | "error">("idle");
  const [lnurlWithdrawMessage, setLnurlWithdrawMessage] = useState("");
  const [lnurlWithdrawInvoice, setLnurlWithdrawInvoice] = useState("");

  const [paymentRequestState, setPaymentRequestState] = useState<{ encoded: string; request: PaymentRequest } | null>(null);
  const [paymentRequestStatus, setPaymentRequestStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [paymentRequestMessage, setPaymentRequestMessage] = useState("");

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
  const normalizedLnInput = useMemo(() => lnInput.trim().replace(/^lightning:/i, "").trim(), [lnInput]);
  const isLnAddress = useMemo(() => /^[^@\s]+@[^@\s]+$/.test(normalizedLnInput), [normalizedLnInput]);
  const isLnurlInput = useMemo(() => /^lnurl[0-9a-z]+$/i.test(normalizedLnInput), [normalizedLnInput]);
  const isBolt11Input = useMemo(() => /^ln(bc|tb|sb|bcrt)[0-9]/i.test(normalizedLnInput), [normalizedLnInput]);
  const lnurlRequiresAmount = useMemo(() => {
    if (!isLnurlInput) return false;
    if (!lnurlPayData) return true;
    if (lnurlPayData.lnurl.trim().toLowerCase() !== normalizedLnInput.toLowerCase()) return true;
    return lnurlPayData.minSendable !== lnurlPayData.maxSendable;
  }, [isLnurlInput, lnurlPayData, normalizedLnInput]);
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
  const lnurlWithdrawStatusText = useMemo(() => {
    switch (lnurlWithdrawState) {
      case "creating":
        return "Creating invoice…";
      case "waiting":
        return "Waiting for payment…";
      case "done":
        return "Completed";
      case "error":
        return "Error";
      default:
        return "";
    }
  }, [lnurlWithdrawState]);
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
      setLnurlPayData(null);
      setLnurlWithdrawInfo(null);
      setLnurlWithdrawAmt("");
      setLnurlWithdrawState("idle");
      setLnurlWithdrawMessage("");
      setLnurlWithdrawInvoice("");
      setPaymentRequestState(null);
      setPaymentRequestStatus("idle");
      setPaymentRequestMessage("");
      setPendingScan(null);
      setShowScanner(false);
      setScannerMessage("");
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
    if (!lnurlPayData) return;
    if (normalizedLnInput.toLowerCase() !== lnurlPayData.lnurl.trim().toLowerCase()) {
      setLnurlPayData(null);
    }
  }, [lnurlPayData, normalizedLnInput]);

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

  const scannerMessageTone = useMemo(() => {
    if (!scannerMessage) return "info";
    return /denied|unsupported|not supported|unrecognized|error|unable/i.test(scannerMessage) ? "error" : "info";
  }, [scannerMessage]);

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const handleScannerError = useCallback((message: string) => {
    setScannerMessage(message);
  }, []);

  const handleScannerDetected = useCallback(async (rawValue: string) => {
    const text = rawValue.trim();
    if (!text) return false;

    const compact = text.replace(/\s+/g, "");

    if (/^https?:\/\//i.test(compact) || /^www\./i.test(compact)) {
      setScannerMessage("Unsupported QR code. Only Cashu tokens and Lightning requests are allowed.");
      return false;
    }

    let candidate = compact;

    if (/^bitcoin:/i.test(candidate)) {
      const [, query = ""] = candidate.split("?");
      if (query) {
        const params = new URLSearchParams(query);
        const lightningParam = params.get("lightning") || params.get("lightning_pay");
        const tokenParam = params.get("token");
        if (lightningParam) {
          try {
            candidate = decodeURIComponent(lightningParam);
          } catch {
            candidate = lightningParam;
          }
        } else if (tokenParam?.toLowerCase().startsWith("cashu")) {
          try {
            candidate = decodeURIComponent(tokenParam);
          } catch {
            candidate = tokenParam;
          }
        }
      }
    }

    candidate = candidate.replace(/^lightning:/i, "").trim();

    if (/^cashu[0-9a-z]+$/i.test(candidate)) {
      setPendingScan({ type: "ecash", token: candidate });
      return true;
    }

    if (/^creqa[0-9a-z]+$/i.test(candidate)) {
      setPendingScan({ type: "paymentRequest", request: candidate });
      return true;
    }

    const lowered = candidate.toLowerCase();

    if (/^ln(bc|tb|sb|bcrt)[0-9]/.test(lowered)) {
      setPendingScan({ type: "bolt11", invoice: lowered });
      return true;
    }

    if (/^[^@\s]+@[^@\s]+$/.test(candidate)) {
      setPendingScan({ type: "lightningAddress", address: candidate.toLowerCase() });
      return true;
    }

    if (/^lnurl[0-9a-z]+$/i.test(candidate)) {
      setPendingScan({ type: "lnurl", data: candidate });
      return true;
    }

    setScannerMessage("Unrecognized code. Scan a Cashu token, Lightning invoice/address, LNURL or payment request.");
    return false;
  }, []);

  const handleLnurlScan = useCallback(async (lnurlValue: string) => {
    try {
      const url = decodeLnurlString(lnurlValue);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`LNURL request failed (${res.status})`);
      const data = await res.json();
      const tag = String(data?.tag || "").toLowerCase();
      const domain = extractDomain(url);

      if (tag === "payrequest") {
        const minSendable = Number(data?.minSendable ?? 0);
        const maxSendable = Number(data?.maxSendable ?? 0);
        const commentAllowed = Number(data?.commentAllowed ?? 0);
        if (!data?.callback) throw new Error("LNURL pay is missing callback URL");
        if (!minSendable || !maxSendable) throw new Error("LNURL pay missing sendable range");

        const payload: LnurlPayData = {
          lnurl: lnurlValue.trim(),
          callback: data.callback,
          domain,
          minSendable,
          maxSendable,
          commentAllowed,
          metadata: typeof data?.metadata === "string" ? data.metadata : undefined,
        };

        setLnurlPayData(payload);
        setLnurlWithdrawInfo(null);
        setReceiveMode(null);
        setShowReceiveOptions(false);
        setSendMode("lightning");
        setShowSendOptions(true);
        setLnInput(lnurlValue.trim());
        if (minSendable === maxSendable) {
          setLnAddrAmt(String(Math.floor(minSendable / 1000)));
        } else {
          setLnAddrAmt("");
        }
        setLnState("idle");
        setLnError("");
        setScannerMessage("");
        setTimeout(() => setShowScanner(false), 90);
        return;
      }

      if (tag === "withdrawrequest") {
        if (!data?.callback || !data?.k1) throw new Error("LNURL withdraw missing callback parameters");
        const minWithdrawable = Number(data?.minWithdrawable ?? 0);
        const maxWithdrawable = Number(data?.maxWithdrawable ?? 0);
        if (!minWithdrawable || !maxWithdrawable) throw new Error("LNURL withdraw missing withdrawable range");

        const info: LnurlWithdrawData = {
          lnurl: lnurlValue.trim(),
          callback: data.callback,
          domain,
          k1: data.k1,
          minWithdrawable,
          maxWithdrawable,
          defaultDescription: typeof data?.defaultDescription === "string" ? data.defaultDescription : undefined,
        };

        setLnurlWithdrawInfo(info);
        const maxSat = Math.floor(maxWithdrawable / 1000);
        setLnurlWithdrawAmt(maxSat > 0 ? String(maxSat) : "");
        setLnurlWithdrawState("idle");
        setLnurlWithdrawMessage("");
        setLnurlWithdrawInvoice("");
        setLnurlPayData(null);
        setSendMode(null);
        setShowSendOptions(false);
        setReceiveMode("lnurlWithdraw");
        setShowReceiveOptions(false);
        setScannerMessage("");
        setTimeout(() => setShowScanner(false), 90);
        return;
      }

      throw new Error("Unsupported LNURL tag");
    } catch (err: any) {
      console.error("handleLnurlScan failed", err);
      setScannerMessage(err?.message || String(err));
    }
  }, []);

  const handlePaymentRequestScan = useCallback(async (encodedRequest: string) => {
    try {
      const request = decodePaymentRequest(encodedRequest);
      if (request.mints && request.mints.length) {
        if (!mintUrl) {
          throw new Error("Set an active mint before fulfilling payment requests");
        }
        const normalizedActive = normalizeMintUrl(mintUrl);
        const compatible = request.mints.some((m) => normalizeMintUrl(m) === normalizedActive);
        if (!compatible) {
          throw new Error("Payment request targets a different mint");
        }
      }
      if (request.unit && info?.unit && request.unit.toLowerCase() !== info.unit.toLowerCase()) {
        throw new Error(`Payment request unit ${request.unit} does not match active mint unit ${info.unit}`);
      }

      setPaymentRequestState({ encoded: encodedRequest, request });
      setPaymentRequestStatus("idle");
      setPaymentRequestMessage("");
      setReceiveMode(null);
      setShowReceiveOptions(false);
      setSendMode("paymentRequest");
      setShowSendOptions(true);
      setScannerMessage("");
      setTimeout(() => setShowScanner(false), 90);
    } catch (err: any) {
      console.error("Payment request scan failed", err);
      setPaymentRequestState(null);
      setPaymentRequestStatus("error");
      setPaymentRequestMessage("");
      setScannerMessage(err?.message || "Invalid payment request");
    }
  }, [info?.unit, mintUrl]);

  const openScanner = useCallback(() => {
    setScannerMessage("");
    setPendingScan(null);
    setShowReceiveOptions(false);
    setReceiveMode(null);
    setShowSendOptions(false);
    setSendMode(null);
    setShowScanner(true);
  }, []);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    setScannerMessage("");
    setPendingScan(null);
  }, []);

  useEffect(() => {
    if (!pendingScan) return;
    let cancelled = false;

    const closeCamera = () => {
      setScannerMessage("");
      setTimeout(() => {
        if (!cancelled) {
          setShowScanner(false);
        }
      }, 90);
    };

    async function process() {
      switch (pendingScan.type) {
        case "ecash": {
          setRecvTokenStr(pendingScan.token);
          setRecvMsg("");
          setSendMode(null);
          setShowSendOptions(false);
          setReceiveMode("ecash");
          setShowReceiveOptions(true);
          closeCamera();
          break;
        }
        case "bolt11": {
          setReceiveMode(null);
          setShowReceiveOptions(false);
          setSendMode("lightning");
          setShowSendOptions(true);
          setLnInput(pendingScan.invoice);
          setLnAddrAmt("");
          setLnState("idle");
          setLnError("");
          closeCamera();
          break;
        }
        case "lightningAddress": {
          setReceiveMode(null);
          setShowReceiveOptions(false);
          setSendMode("lightning");
          setShowSendOptions(true);
          setLnInput(pendingScan.address);
          setLnAddrAmt("");
          setLnState("idle");
          setLnError("");
          closeCamera();
          break;
        }
        case "lnurl": {
          setScannerMessage("Processing LNURL…");
          await handleLnurlScan(pendingScan.data);
          break;
        }
        case "paymentRequest": {
          setScannerMessage("Processing payment request…");
          await handlePaymentRequestScan(pendingScan.request);
          break;
        }
        default:
          closeCamera();
          break;
      }
    }

    process().finally(() => {
      if (!cancelled) setPendingScan(null);
    });

    return () => {
      cancelled = true;
    };
  }, [pendingScan, handleLnurlScan, handlePaymentRequestScan]);

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
      const raw = lnInput.trim();
      if (!raw) throw new Error("Paste an invoice or enter lightning address");
      const normalized = raw.replace(/^lightning:/i, "").trim();

      if (isLnAddress) {
        const [name, domain] = normalized.split("@");
        const infoRes = await fetch(`https://${domain}/.well-known/lnurlp/${name}`);
        if (!infoRes.ok) throw new Error("Failed to fetch LNURL pay info");
        const info = await infoRes.json();
        const amtMsat = Math.max(
          info.minSendable || 0,
          Math.min(info.maxSendable || Infinity, Math.floor(Number(lnAddrAmt) || 0) * 1000)
        );
        if (!amtMsat) throw new Error("Enter amount in sats");
        const invRes = await fetch(`${info.callback}?amount=${amtMsat}`);
        if (!invRes.ok) throw new Error("Failed to fetch invoice");
        const inv = await invRes.json();
        if (inv?.status === "ERROR") throw new Error(inv?.reason || "Invoice request failed");
        await payMintInvoice(inv.pr);
        setHistory((h) => [{ id: `sent-${Date.now()}`, summary: `Sent ${amtMsat/1000} sats to ${normalized}` }, ...h]);
      } else if (isLnurlInput) {
        const payData = await (async () => {
          if (lnurlPayData && lnurlPayData.lnurl.trim().toLowerCase() === normalized.toLowerCase()) return lnurlPayData;
          const url = decodeLnurlString(normalized);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`LNURL request failed (${res.status})`);
          const data = await res.json();
          if (String(data?.tag || "").toLowerCase() !== "payrequest") {
            throw new Error("LNURL is not a pay request");
          }
          const minSendable = Number(data?.minSendable ?? 0);
          const maxSendable = Number(data?.maxSendable ?? 0);
          if (!data?.callback || !minSendable || !maxSendable) {
            throw new Error("LNURL pay metadata incomplete");
          }
          const payload: LnurlPayData = {
            lnurl: normalized,
            callback: data.callback,
            domain: extractDomain(url),
            minSendable,
            maxSendable,
            commentAllowed: Number(data?.commentAllowed ?? 0),
            metadata: typeof data?.metadata === "string" ? data.metadata : undefined,
          };
          setLnurlPayData(payload);
          return payload;
        })();

        const minSat = Math.ceil(payData.minSendable / 1000);
        const maxSat = Math.floor(payData.maxSendable / 1000);
        const amountSat = payData.minSendable === payData.maxSendable
          ? Math.floor(payData.minSendable / 1000)
          : Math.max(0, Math.floor(Number(lnAddrAmt) || 0));
        if (!amountSat) throw new Error("Enter amount in sats");
        if (amountSat < minSat || amountSat > maxSat) {
          throw new Error(`Amount must be between ${minSat} and ${maxSat} sats`);
        }
        const params = new URLSearchParams({ amount: String(amountSat * 1000) });
        const invoiceRes = await fetch(`${payData.callback}?${params.toString()}`);
        if (!invoiceRes.ok) throw new Error("Failed to fetch LNURL invoice");
        const invoice = await invoiceRes.json();
        if (invoice?.status === "ERROR") throw new Error(invoice?.reason || "LNURL pay error");
        await payMintInvoice(invoice.pr);
        setHistory((h) => [{ id: `paid-lnurl-${Date.now()}`, summary: `Paid ${amountSat} sats via LNURL (${payData.domain})` }, ...h]);
        setLnurlPayData(null);
      } else if (isBolt11Input) {
        await payMintInvoice(normalized);
        setHistory((h) => [{ id: `paid-${Date.now()}`, summary: `Paid lightning invoice` }, ...h]);
      } else {
        throw new Error("Unsupported lightning input");
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

  function resetLnurlWithdrawView() {
    setLnurlWithdrawState("idle");
    setLnurlWithdrawMessage("");
    setLnurlWithdrawInvoice("");
    setLnurlWithdrawAmt("");
    setLnurlWithdrawInfo(null);
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

  async function handleLnurlWithdrawConfirm() {
    if (!lnurlWithdrawInfo) {
      setLnurlWithdrawMessage("Scan an LNURL withdraw code first");
      return;
    }
    setLnurlWithdrawMessage("");
    try {
      const amountSat = Math.max(0, Math.floor(Number(lnurlWithdrawAmt) || 0));
      if (!amountSat) throw new Error("Enter amount in sats");
      const minSat = Math.ceil(lnurlWithdrawInfo.minWithdrawable / 1000);
      const maxSat = Math.floor(lnurlWithdrawInfo.maxWithdrawable / 1000);
      if (amountSat < minSat || amountSat > maxSat) {
        throw new Error(`Amount must be between ${minSat} and ${maxSat} sats`);
      }
      if (!mintUrl) throw new Error("Set an active mint first");

      setLnurlWithdrawState("creating");
      const description = lnurlWithdrawInfo.defaultDescription || `LNURL withdraw (${lnurlWithdrawInfo.domain})`;
      const quote = await createMintInvoice(amountSat, description);
      setLnurlWithdrawInvoice(quote.request);
      setLnurlWithdrawState("waiting");

      const params = new URLSearchParams({ k1: lnurlWithdrawInfo.k1, pr: quote.request });
      const callbackUrl = lnurlWithdrawInfo.callback.includes("?")
        ? `${lnurlWithdrawInfo.callback}&${params.toString()}`
        : `${lnurlWithdrawInfo.callback}?${params.toString()}`;

      const resp = await fetch(callbackUrl);
      let body: any = null;
      try {
        body = await resp.clone().json();
      } catch {
        // ignore parse issues for non-json responses
      }
      if (!resp.ok || body?.status === "ERROR") {
        throw new Error(body?.reason || "LNURL withdraw callback failed");
      }

      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const state = await checkMintQuote(quote.quote);
        if (state === "PAID" || state === "ISSUED") {
          await claimMint(quote.quote, amountSat);
          setLnurlWithdrawState("done");
          setLnurlWithdrawMessage(`Received ${amountSat} sats via LNURL withdraw`);
          setLnurlWithdrawAmt("");
          setHistory((h) => [
            {
              id: `lnurl-withdraw-${Date.now()}`,
              summary: `Received ${amountSat} sats via LNURLw (${lnurlWithdrawInfo.domain})`,
              detail: quote.request,
            },
            ...h,
          ]);
          return;
        }
        await sleep(2500);
      }

      throw new Error("Withdraw still pending. Try again shortly.");
    } catch (err: any) {
      setLnurlWithdrawState("error");
      setLnurlWithdrawMessage(err?.message || String(err));
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

  async function handleFulfillPaymentRequest() {
    if (!paymentRequestState) {
      setPaymentRequestMessage("Scan a payment request first");
      return;
    }
    setPaymentRequestMessage("");
    setPaymentRequestStatus("sending");
    try {
      const request = paymentRequestState.request;
      const amount = Math.max(0, Math.floor(Number(request.amount) || 0));
      if (!amount) throw new Error("Payment request missing amount");
      if (!mintUrl) throw new Error("Set an active mint first");

      if (request.mints && request.mints.length) {
        const normalizedActive = normalizeMintUrl(mintUrl);
        const compatible = request.mints.some((m) => normalizeMintUrl(m) === normalizedActive);
        if (!compatible) {
          throw new Error("Payment request targets a different mint");
        }
      }

      if (request.unit && info?.unit && request.unit.toLowerCase() !== info.unit.toLowerCase()) {
        throw new Error(`Payment request unit ${request.unit} does not match active mint unit ${info.unit}`);
      }

      const transport = request.getTransport(PaymentRequestTransportType.POST) as PaymentRequestTransport | undefined;
      if (!transport || transport.type !== PaymentRequestTransportType.POST) {
        throw new Error("Unsupported payment request transport");
      }

      const { proofs, mintUrl: proofMintUrl } = await createSendToken(amount);
      const payload = {
        id: request.id,
        memo: request.description,
        unit: (request.unit || info?.unit || "sat").toLowerCase(),
        mint: proofMintUrl,
        proofs,
      };

      const resp = await fetch(transport.target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      let body: any = null;
      try {
        body = await resp.clone().json();
      } catch {
        // ignore non-json response bodies
      }
      if (!resp.ok || body?.status === "ERROR") {
        throw new Error(body?.reason || "Payment request endpoint failed");
      }

      setPaymentRequestStatus("done");
      setPaymentRequestMessage("");
      setHistory((h) => [
        {
          id: `payment-request-${Date.now()}`,
          summary: `Sent ${amount} sats via payment request`,
          detail: transport.target,
        },
        ...h,
      ]);
    } catch (err: any) {
      setPaymentRequestStatus("error");
      setPaymentRequestMessage(err?.message || String(err));
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
          <button
            type="button"
            className="wallet-modal__scan-button pressable"
            onClick={openScanner}
            aria-label="Scan code"
            title="Scan code"
          >
            <svg className="wallet-modal__scan-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 6h2.4l1.1-2h3l1.1 2H17a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
              <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" fill="none" />
              <circle cx="18.25" cy="9.25" r="0.75" fill="currentColor" />
            </svg>
          </button>
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
              <QrCodeCard
                value={mintQuote.request}
                label="Invoice"
                copyLabel="Copy invoice"
                extraActions={(
                  <a className="ghost-button button-sm pressable" href={`lightning:${mintQuote.request}`}>
                    Open wallet
                  </a>
                )}
                size={240}
              />
              <div className="text-xs text-secondary">Status: {mintStatus}</div>
              {mintError && <div className="text-xs text-rose-400">{mintError}</div>}
            </div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet open={receiveMode === "lnurlWithdraw"} onClose={()=>{resetLnurlWithdrawView(); setReceiveMode(null); setShowReceiveOptions(false);}} title="LNURL Withdraw">
        {lnurlWithdrawInfo ? (
          <div className="wallet-section space-y-3">
            <div className="text-xs text-secondary">Source: {lnurlWithdrawInfo.domain}</div>
            <div className="text-xs text-secondary">
              Limits: {Math.ceil(lnurlWithdrawInfo.minWithdrawable / 1000)} – {Math.floor(lnurlWithdrawInfo.maxWithdrawable / 1000)} sats
            </div>
            <input
              className="pill-input"
              placeholder="Amount (sats)"
              value={lnurlWithdrawAmt}
              onChange={(e)=>setLnurlWithdrawAmt(e.target.value)}
              inputMode="decimal"
            />
            <div className="flex flex-wrap gap-2 items-center text-xs text-secondary">
              <button
                className="accent-button button-sm pressable"
                onClick={handleLnurlWithdrawConfirm}
                disabled={!mintUrl || lnurlWithdrawState === "creating" || lnurlWithdrawState === "waiting"}
              >Withdraw</button>
              {lnurlWithdrawStatusText && <span>{lnurlWithdrawStatusText}</span>}
              {lnurlWithdrawMessage && (
                <span className={lnurlWithdrawState === "error" ? "text-rose-400" : "text-accent"}>{lnurlWithdrawMessage}</span>
              )}
            </div>
            {lnurlWithdrawInvoice && (
              <QrCodeCard
                className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                value={lnurlWithdrawInvoice}
                label="Mint invoice"
                copyLabel="Copy invoice"
                size={220}
              />
            )}
          </div>
        ) : (
          <div className="wallet-section text-sm text-secondary">Scan an LNURL withdraw QR code to pull sats into your wallet.</div>
        )}
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
            <QrCodeCard
              className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
              value={nwcFundInvoice}
              label="Mint invoice (paid)"
              copyLabel="Copy invoice"
              size={240}
            />
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
            <QrCodeCard
              className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
              value={sendTokenStr}
              label="Token"
              copyLabel="Copy token"
              size={240}
            />
          )}
        </div>
      </ActionSheet>

      <ActionSheet open={sendMode === "lightning"} onClose={()=>{setSendMode(null); setShowSendOptions(false); setLnInput(""); setLnAddrAmt(""); setLnState("idle"); setLnError("");}} title="Pay Lightning Invoice">
        <div className="wallet-section space-y-3">
          <textarea ref={lnRef} className="pill-textarea wallet-textarea" placeholder="Paste BOLT11 invoice or enter lightning address" value={lnInput} onChange={(e)=>setLnInput(e.target.value)} />
          {(isLnAddress || isLnurlInput) && (
            <input className="pill-input" placeholder="Amount (sats)" value={lnAddrAmt} onChange={(e)=>setLnAddrAmt(e.target.value)} />
          )}
          {isLnurlInput && lnurlPayData && (
            <div className="text-xs text-secondary">
              Limits: {Math.ceil(lnurlPayData.minSendable / 1000)} – {Math.floor(lnurlPayData.maxSendable / 1000)} sats
            </div>
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
            <button
              className="accent-button button-sm pressable"
              onClick={handlePayInvoice}
              disabled={!mintUrl || !lnInput || ((isLnAddress || lnurlRequiresAmount) && !lnAddrAmt)}
            >Pay</button>
            {lnState === "sending" && <span className="text-xs">Paying…</span>}
            {lnState === "done" && <span className="text-xs text-accent">Paid</span>}
            {lnState === "error" && <span className="text-xs text-rose-400">{lnError}</span>}
          </div>
        </div>
      </ActionSheet>

      <ActionSheet open={sendMode === "paymentRequest"} onClose={()=>{setSendMode(null); setShowSendOptions(false); setPaymentRequestState(null); setPaymentRequestStatus("idle"); setPaymentRequestMessage("");}} title="Fulfill eCash Request">
        {paymentRequestState ? (
          <div className="wallet-section space-y-3 text-sm">
            <div className="space-y-1 text-xs text-secondary">
              <div>Amount: {paymentRequestState.request.amount ?? "?"} {paymentRequestState.request.unit?.toUpperCase() || info?.unit?.toUpperCase() || "SAT"}</div>
              {paymentRequestState.request.description && <div>Memo: {paymentRequestState.request.description}</div>}
              {paymentRequestState.request.mints?.length ? (
                <div>Mint: {paymentRequestState.request.mints.map(normalizeMintUrl).join(", ")}</div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 items-center text-xs text-secondary">
              <button
                className="accent-button button-sm pressable"
                onClick={handleFulfillPaymentRequest}
                disabled={paymentRequestStatus === "sending"}
              >Send</button>
              {paymentRequestStatus === "sending" && <span>Sending…</span>}
              {paymentRequestStatus === "done" && <span className="text-accent">Payment sent</span>}
              {paymentRequestStatus === "error" && paymentRequestMessage && <span className="text-rose-400">{paymentRequestMessage}</span>}
            </div>
            {paymentRequestStatus !== "error" && paymentRequestMessage && (
              <div className="text-xs text-secondary">{paymentRequestMessage}</div>
            )}
          </div>
        ) : (
          <div className="wallet-section text-sm text-secondary">Scan an eCash withdrawal request to continue.</div>
        )}
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
            <QrCodeCard
              className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
              value={nwcWithdrawInvoice}
              label="Wallet invoice"
              copyLabel="Copy invoice"
              size={240}
            />
          )}
          {!hasNwcConnection && (
            <div className="text-xs text-secondary">Connect an NWC wallet to send funds externally.</div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet open={showScanner} onClose={closeScanner} title="Scan Code">
        <div className="wallet-section space-y-3">
          <QrScanner active={showScanner} onDetected={handleScannerDetected} onError={handleScannerError} />
          {scannerMessage && (
            <div className={`text-xs text-center ${scannerMessageTone === "error" ? "text-rose-400" : "text-secondary"}`}>
              {scannerMessage}
            </div>
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
                  <QrCodeCard
                    className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
                    value={h.detail}
                    label="Details"
                    copyLabel="Copy detail"
                    size={220}
                  />
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
