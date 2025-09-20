import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bech32 } from "bech32";
import { decodePaymentRequest, PaymentRequest, PaymentRequestTransportType, type PaymentRequestTransport } from "@cashu/cashu-ts";
import QrScannerLib from "qr-scanner";
import qrScannerWorkerPath from "qr-scanner/qr-scanner-worker.min.js?url";
import { QRCodeCanvas } from "qrcode.react";
import { useCashu } from "../context/CashuContext";
import { useNwc } from "../context/NwcContext";
import { loadStore } from "../wallet/storage";
import { LS_LIGHTNING_CONTACTS } from "../localStorageKeys";
import { LS_NOSTR_SK } from "../nostrKeys";
import {
  NpubCashError,
  acknowledgeNpubCashClaims,
  claimPendingEcashFromNpubCash,
  deriveNpubCashIdentity,
} from "../wallet/npubCash";
import { ActionSheet } from "./ActionSheet";

QrScannerLib.WORKER_PATH = qrScannerWorkerPath;
type ScanResult = QrScannerLib.ScanResult;

const LNURL_DECODE_LIMIT = 2048;
const SMALL_ICON_BUTTON_STYLE = { "--icon-size": "2rem" } as React.CSSProperties;

type LightningContact = {
  id: string;
  name: string;
  address: string;
};

function makeContactId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

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

function PencilIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M4 13.75V16h2.25l8.43-8.43a1.59 1.59 0 0 0 0-2.25l-1.5-1.5a1.59 1.59 0 0 0-2.25 0L4 13.75z" />
      <path d="M11.5 4.5l2.5 2.5" />
    </svg>
  );
}

function TrashIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M5 6h10l-.85 10.2a1.5 1.5 0 0 1-1.5 1.3H7.35a1.5 1.5 0 0 1-1.5-1.3L5 6z" />
      <path d="M3 6h14" />
      <path d="M8.5 6V4.5A1.5 1.5 0 0 1 10 3h0a1.5 1.5 0 0 1 1.5 1.5V6" />
    </svg>
  );
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

const BOLT11_AMOUNT_MULTIPLIERS = {
  "": { numerator: 100_000_000_000n, denominator: 1n },
  m: { numerator: 100_000_000n, denominator: 1n },
  u: { numerator: 100_000n, denominator: 1n },
  n: { numerator: 100n, denominator: 1n },
  p: { numerator: 1n, denominator: 10n },
} as const satisfies Record<string, { numerator: bigint; denominator: bigint }>;

const SATS_PER_BTC = 100_000_000;
const COINBASE_SPOT_PRICE_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const PRICE_REFRESH_MS = 60_000;

type Bolt11AmountInfo = {
  amountMsat: bigint | null;
};

function decodeBolt11Amount(invoice: string): Bolt11AmountInfo {
  const trimmed = invoice.trim();
  if (!trimmed) throw new Error("Missing invoice");
  const lower = trimmed.toLowerCase();
  const separatorIdx = lower.lastIndexOf("1");
  if (separatorIdx <= 2) throw new Error("Invalid BOLT11 invoice");
  const hrp = lower.slice(0, separatorIdx);
  if (!hrp.startsWith("ln")) throw new Error("Invalid BOLT11 invoice");
  const hrpBody = hrp.slice(2);
  let idx = 0;
  while (idx < hrpBody.length && /[a-z]/.test(hrpBody[idx])) idx++;
  const amountPart = hrpBody.slice(idx);
  if (!amountPart) return { amountMsat: null };
  const match = amountPart.match(/^(\d+)([a-z]?)$/);
  if (!match) throw new Error("Unsupported BOLT11 amount encoding");
  const [, valuePart, unitPart] = match;
  const value = BigInt(valuePart);
  const unitKey = (unitPart || "") as keyof typeof BOLT11_AMOUNT_MULTIPLIERS;
  const multiplier = BOLT11_AMOUNT_MULTIPLIERS[unitKey];
  if (!multiplier) throw new Error("Unsupported BOLT11 amount unit");
  const numerator = value * multiplier.numerator;
  if (numerator % multiplier.denominator !== 0n) {
    throw new Error("Invoice amount has unsupported precision");
  }
  const amountMsat = numerator / multiplier.denominator;
  return { amountMsat };
}

function formatMsatAsSat(amountMsat: bigint): string {
  const wholeSat = amountMsat / 1000n;
  const remainderMsat = amountMsat % 1000n;
  if (remainderMsat === 0n) {
    return `${wholeSat.toString()} sat`;
  }
  const decimals = remainderMsat.toString().padStart(3, "0").replace(/0+$/, "");
  return `${wholeSat.toString()}.${decimals} sat`;
}

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
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const scannerRef = useRef<QrScannerLib | null>(null);
  const stopRequestedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const reportError = useCallback((message: string) => {
    setError(message);
    if (onError) onError(message);
  }, [onError]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const stopScanner = useCallback(() => {
    const scanner = scannerRef.current;
    if (scanner) {
      try {
        scanner.stop();
      } catch (err) {
        console.warn("Failed to stop scanner", err);
      }
      scanner.destroy();
      scannerRef.current = null;
    }
    const video = videoRef.current;
    if (video && video.srcObject instanceof MediaStream) {
      video.srcObject.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!active) {
      stopRequestedRef.current = true;
      stopScanner();
      clearError();
      return;
    }

    const video = videoRef.current;
    const overlay = overlayRef.current || undefined;
    if (!video) return;

    stopRequestedRef.current = false;
    let cancelled = false;

    async function start() {
      try {
        clearError();
        const scanner = new QrScannerLib(
          video,
          async (result: ScanResult) => {
            const value = result?.data?.trim();
            if (!value || stopRequestedRef.current) return;
            try {
              const shouldClose = await onDetected(value);
              if (shouldClose) {
                stopRequestedRef.current = true;
                stopScanner();
              }
            } catch (err) {
              console.warn("QR handler failed", err);
            }
          },
          {
            returnDetailedScanResult: true,
            highlightScanRegion: true,
            highlightCodeOutline: true,
            overlay,
            preferredCamera: "environment",
            maxScansPerSecond: 12,
            onDecodeError: (err) => {
              if (typeof err === "string" && err === QrScannerLib.NO_QR_CODE_FOUND) return;
            },
          }
        );

        video.setAttribute("playsinline", "true");
        video.setAttribute("muted", "true");
        video.setAttribute("autoplay", "true");
        video.playsInline = true;
        video.muted = true;

        scannerRef.current = scanner;
        await scanner.start();
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        reportError(message || "Unable to access camera");
        stopScanner();
      }
    }

    start();

    return () => {
      cancelled = true;
      stopRequestedRef.current = true;
      stopScanner();
    };
  }, [active, onDetected, reportError, stopScanner, clearError]);

  return (
    <div className="wallet-scanner space-y-3">
      <div className={`wallet-scanner__viewport${error ? " wallet-scanner__viewport--error" : ""}`}>
        {error ? (
          <div className="wallet-scanner__fallback">{error}</div>
        ) : (
          <>
            <video ref={videoRef} className="wallet-scanner__video" playsInline muted />
            <div ref={overlayRef} className="wallet-scanner__guide" aria-hidden="true" />
          </>
        )}
      </div>
      <div className="wallet-scanner__hint text-xs text-secondary text-center">
        {error ? "Camera unavailable. Try entering the code manually." : "Align a QR code inside the frame."}
      </div>
    </div>
  );
}

export function CashuWalletModal({
  open,
  onClose,
  walletConversionEnabled,
  walletPrimaryCurrency,
  setWalletPrimaryCurrency,
  npubCashLightningAddressEnabled,
  npubCashAutoClaim,
}: {
  open: boolean;
  onClose: () => void;
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  setWalletPrimaryCurrency: (currency: "sat" | "usd") => void;
  npubCashLightningAddressEnabled: boolean;
  npubCashAutoClaim: boolean;
}) {
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
  const [receiveMode, setReceiveMode] = useState<
    | null
    | "ecash"
    | "lightning"
    | "lnurlWithdraw"
    | "nwcFund"
    | "npubCashAddress"
  >(null);
  const [sendMode, setSendMode] = useState<null | "ecash" | "lightning" | "paymentRequest" | "nwcWithdraw">(null);

  const [btcUsdPrice, setBtcUsdPrice] = useState<number | null>(null);
  const [priceStatus, setPriceStatus] = useState<"idle" | "loading" | "error">("idle");
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<number | null>(null);

  const [mintAmt, setMintAmt] = useState("");
  const [mintQuote, setMintQuote] = useState<{ request: string; quote: string; expiry: number } | null>(null);
  const [mintQuoteAmountSat, setMintQuoteAmountSat] = useState<number | null>(null);
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
  const [contacts, setContacts] = useState<LightningContact[]>(() => {
    try {
      const saved = localStorage.getItem(LS_LIGHTNING_CONTACTS);
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item: any) => {
          if (!item) return null;
          const name = typeof item.name === "string" ? item.name : "";
          const address = typeof item.address === "string" ? item.address : "";
          if (!address.trim()) return null;
          return {
            id: typeof item.id === "string" && item.id ? item.id : makeContactId(),
            name,
            address,
          } satisfies LightningContact;
        })
        .filter(Boolean) as LightningContact[];
    } catch {
      return [];
    }
  });
  const [contactsOpen, setContactsOpen] = useState(false);
  const [contactFormVisible, setContactFormVisible] = useState(false);
  const [contactForm, setContactForm] = useState<{ id: string | null; name: string; address: string }>({
    id: null,
    name: "",
    address: "",
  });
  const [contactFormError, setContactFormError] = useState("");

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
  const [npubCashIdentity, setNpubCashIdentity] = useState<{ npub: string; address: string } | null>(null);
  const [npubCashIdentityError, setNpubCashIdentityError] = useState<string | null>(null);
  const [npubCashClaimStatus, setNpubCashClaimStatus] = useState<"idle" | "checking" | "success" | "error">("idle");
  const [npubCashClaimMessage, setNpubCashClaimMessage] = useState("");
  const recvRef = useRef<HTMLTextAreaElement | null>(null);
  const lnRef = useRef<HTMLTextAreaElement | null>(null);
  const npubCashClaimAbortRef = useRef<AbortController | null>(null);
  const npubCashClaimingRef = useRef(false);
  const normalizedLnInput = useMemo(() => lnInput.trim().replace(/^lightning:/i, "").trim(), [lnInput]);
  const isLnAddress = useMemo(() => /^[^@\s]+@[^@\s]+$/.test(normalizedLnInput), [normalizedLnInput]);
  const isLnurlInput = useMemo(() => /^lnurl[0-9a-z]+$/i.test(normalizedLnInput), [normalizedLnInput]);
  const isBolt11Input = useMemo(() => /^ln(bc|tb|sb|bcrt)[0-9]/i.test(normalizedLnInput), [normalizedLnInput]);
  const bolt11Details = useMemo(() => {
    if (!isBolt11Input) return null;
    try {
      const { amountMsat } = decodeBolt11Amount(normalizedLnInput);
      if (amountMsat === null) {
        return { message: "Invoice amount: not specified" };
      }
      return { message: `Invoice amount: ${formatMsatAsSat(amountMsat)}` };
    } catch (err: any) {
      return { error: err?.message || "Unable to decode invoice" };
    }
  }, [isBolt11Input, normalizedLnInput]);
  const lnurlRequiresAmount = useMemo(() => {
    if (!isLnurlInput) return false;
    if (!lnurlPayData) return true;
    if (lnurlPayData.lnurl.trim().toLowerCase() !== normalizedLnInput.toLowerCase()) return true;
    return lnurlPayData.minSendable !== lnurlPayData.maxSendable;
  }, [isLnurlInput, lnurlPayData, normalizedLnInput]);
  const hasNwcConnection = !!nwcConnection;
  const sortedContacts = useMemo(() => {
    return [...contacts].sort((a, b) => {
      const nameA = (a.name || a.address).toLowerCase();
      const nameB = (b.name || b.address).toLowerCase();
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return a.address.localeCompare(b.address);
    });
  }, [contacts]);
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

  const resetContactForm = useCallback(() => {
    setContactForm({ id: null, name: "", address: "" });
    setContactFormError("");
    setContactFormVisible(false);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LS_LIGHTNING_CONTACTS, JSON.stringify(contacts));
    } catch (err) {
      console.warn("Unable to save contacts", err);
    }
  }, [contacts]);

  useEffect(() => {
    if (!contactsOpen) {
      resetContactForm();
    }
  }, [contactsOpen, resetContactForm]);

  const handleSelectContact = useCallback(
    (contact: LightningContact) => {
      setLnInput(contact.address);
      setContactsOpen(false);
      resetContactForm();
      setTimeout(() => {
        lnRef.current?.focus();
      }, 0);
    },
    [resetContactForm, lnRef],
  );

  const handleStartNewContact = useCallback(() => {
    setContactsOpen(true);
    setContactForm({ id: null, name: "", address: "" });
    setContactFormError("");
    setContactFormVisible(true);
  }, []);

  const handleStartEditContact = useCallback((contact: LightningContact) => {
    setContactsOpen(true);
    setContactForm({ id: contact.id, name: contact.name, address: contact.address });
    setContactFormError("");
    setContactFormVisible(true);
  }, []);

  const handleDeleteContact = useCallback((id: string) => {
    setContacts((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const handleSubmitContact = useCallback(
    (ev?: React.FormEvent) => {
      if (ev) ev.preventDefault();
      const name = contactForm.name.trim();
      const address = contactForm.address.trim();
      if (!address) {
        setContactFormError("Lightning address is required");
        return;
      }
      const isEditing = !!contactForm.id;
      const contact: LightningContact = {
        id: contactForm.id || makeContactId(),
        name,
        address,
      };
      setContacts((prev) => {
        const exists = prev.some((c) => c.id === contact.id);
        if (exists) {
          return prev.map((c) => (c.id === contact.id ? contact : c));
        }
        return [...prev, contact];
      });
      setContactFormError("");
      setLnInput(address);
      if (!isEditing) {
        setContactsOpen(false);
      }
      resetContactForm();
      setTimeout(() => {
        lnRef.current?.focus();
      }, 0);
    },
    [contactForm, lnRef, resetContactForm],
  );
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

  const handleClaimNpubCash = useCallback(
    async (options?: { auto?: boolean }) => {
      if (!npubCashLightningAddressEnabled) return;
      if (npubCashClaimingRef.current) return;
      const auto = options?.auto === true;
      const storedSk = localStorage.getItem(LS_NOSTR_SK) || "";
      if (!storedSk) {
        setNpubCashIdentity(null);
        const message = "Add your Taskify Nostr key in Settings → Nostr to use npub.cash.";
        setNpubCashIdentityError(message);
        if (!auto) {
          setNpubCashClaimStatus("error");
          setNpubCashClaimMessage(message);
        }
        return;
      }

      let identity: ReturnType<typeof deriveNpubCashIdentity> | null = null;
      try {
        identity = deriveNpubCashIdentity(storedSk);
        setNpubCashIdentity({ npub: identity.npub, address: identity.address });
        setNpubCashIdentityError(null);
      } catch (err: any) {
        const message = err?.message || "Unable to derive npub.cash address.";
        setNpubCashIdentity(null);
        setNpubCashIdentityError(message);
        if (!auto) {
          setNpubCashClaimStatus("error");
          setNpubCashClaimMessage(message);
        }
        return;
      }

      if (!mintUrl) {
        if (!auto) {
          setNpubCashClaimStatus("error");
          setNpubCashClaimMessage("Select an active mint before claiming from npub.cash.");
        }
        return;
      }

      const controller = new AbortController();
      npubCashClaimAbortRef.current = controller;
      npubCashClaimingRef.current = true;
      setNpubCashClaimStatus("checking");
      setNpubCashClaimMessage("Checking npub.cash for pending tokens…");

      try {
        const result = await claimPendingEcashFromNpubCash(storedSk, { signal: controller.signal });
        const tokens = Array.isArray(result.tokens) ? result.tokens : [];
        const reportedBalance = Number.isFinite(result.balance)
          ? Math.max(0, Math.floor(result.balance))
          : 0;
        if (reportedBalance > 0) {
          setNpubCashClaimMessage(
            `npub.cash reports ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"} ready to claim…`,
          );
        }
        if (!tokens.length) {
          if (reportedBalance > 0) {
            setNpubCashClaimStatus("error");
            setNpubCashClaimMessage(
              `npub.cash reported ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"}, but no token was returned. Please try again later.`,
            );
          } else {
            setNpubCashClaimStatus("idle");
            setNpubCashClaimMessage("No pending eCash found.");
          }
          return;
        }

        let successCount = 0;
        let totalSat = 0;
        let lastError: string | null = null;
        const successTokens: string[] = [];
        const crossMintMints = new Set<string>();
        for (const token of tokens) {
          try {
            const normalizedToken = typeof token === "string" ? token.trim() : "";
            if (!normalizedToken) {
              continue;
            }
            const res = await receiveToken(normalizedToken);
            successCount += 1;
            successTokens.push(normalizedToken);
            const tokenAmount = Array.isArray(res.proofs)
              ? res.proofs.reduce((sum, proof) => sum + (proof?.amount || 0), 0)
              : 0;
            totalSat += tokenAmount;
            if (res.crossMint && res.usedMintUrl) {
              crossMintMints.add(res.usedMintUrl);
            }
          } catch (err: any) {
            lastError = err?.message || String(err);
          }
        }

        if (lastError) {
          setNpubCashClaimStatus("error");
          const prefix = successCount ? `Claimed ${successCount} token${successCount === 1 ? "" : "s"}, but ` : "";
          setNpubCashClaimMessage(`${prefix}${lastError}`);
        } else {
          if (successTokens.length) {
            try {
              await acknowledgeNpubCashClaims(storedSk);
            } catch (ackErr) {
              console.warn("Failed to acknowledge npub.cash claims", ackErr);
            }
          }
          setNpubCashClaimStatus("success");
          const baseMessage = totalSat
            ? `Claimed ${totalSat} sat${totalSat === 1 ? "" : "s"} from npub.cash`
            : `Claimed ${successCount} token${successCount === 1 ? "" : "s"} from npub.cash`;
          const suffixParts: string[] = [];
          if (crossMintMints.size) {
            suffixParts.push(`stored at ${Array.from(crossMintMints).join(", ")}`);
          }
          if (reportedBalance > 0) {
            suffixParts.push(`npub.cash reported ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"}`);
          }
          const suffix = suffixParts.length ? ` (${suffixParts.join("; ")})` : "";
          setNpubCashClaimMessage(`${baseMessage}${suffix}.`);
          const detailParts = [`Address ${identity.address}`];
          if (identity.npub) detailParts.push(`npub ${identity.npub}`);
          if (totalSat) {
            detailParts.push(`${totalSat} sat${totalSat === 1 ? "" : "s"}`);
          }
          if (crossMintMints.size) {
            detailParts.push(`Stored at ${Array.from(crossMintMints).join(", ")}`);
          }
          if (reportedBalance > 0) {
            detailParts.push(`npub.cash reported ${reportedBalance} sat${reportedBalance === 1 ? "" : "s"}`);
          }
          const summary = totalSat
            ? `Claimed ${totalSat} sat${totalSat === 1 ? "" : "s"} via npub.cash`
            : `Claimed ${successCount} token${successCount === 1 ? "" : "s"} via npub.cash`;
          setHistory((prev) => [
            {
              id: `npubcash-${Date.now()}`,
              summary,
              detail: detailParts.join(" · "),
            },
            ...prev,
          ]);
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        if (err instanceof NpubCashError && err.status === 504) {
          const message = err.message || "npub.cash request timed out. Please try again later.";
          setNpubCashClaimStatus(auto ? "idle" : "error");
          setNpubCashClaimMessage(message);
          return;
        }
        const message = err?.message || "Unable to claim eCash from npub.cash.";
        setNpubCashClaimStatus("error");
        setNpubCashClaimMessage(message);
      } finally {
        npubCashClaimingRef.current = false;
        if (npubCashClaimAbortRef.current === controller) {
          npubCashClaimAbortRef.current = null;
        }
      }
    },
    [mintUrl, npubCashLightningAddressEnabled, receiveToken, setHistory],
  );

  useEffect(() => {
    localStorage.setItem("cashuHistory", JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (!npubCashLightningAddressEnabled) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError(null);
      return;
    }
    const storedSk = localStorage.getItem(LS_NOSTR_SK) || "";
    if (!storedSk) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError("Add your Taskify Nostr key in Settings → Nostr to use npub.cash.");
      return;
    }
    try {
      const identity = deriveNpubCashIdentity(storedSk);
      setNpubCashIdentity({ npub: identity.npub, address: identity.address });
      setNpubCashIdentityError(null);
    } catch (err: any) {
      setNpubCashIdentity(null);
      setNpubCashIdentityError(err?.message || "Unable to derive npub.cash address.");
    }
  }, [npubCashLightningAddressEnabled, open]);

  useEffect(() => {
    if (!open || !npubCashLightningAddressEnabled || !npubCashAutoClaim) return;
    void handleClaimNpubCash({ auto: true });
  }, [open, npubCashLightningAddressEnabled, npubCashAutoClaim, handleClaimNpubCash]);

  useEffect(() => {
    return () => {
      if (npubCashClaimAbortRef.current) {
        npubCashClaimAbortRef.current.abort();
        npubCashClaimAbortRef.current = null;
      }
      npubCashClaimingRef.current = false;
    };
  }, []);

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

  useEffect(() => {
    if (!open || !walletConversionEnabled) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const loadPrice = async () => {
      try {
        setPriceStatus((prev) => (prev === "loading" ? prev : "loading"));
        const response = await fetch(COINBASE_SPOT_PRICE_URL, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: any = await response.json();
        const amount = Number(payload?.data?.amount);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid price data");
        if (cancelled) return;
        setBtcUsdPrice(amount);
        setPriceUpdatedAt(Date.now());
        setPriceStatus("idle");
      } catch {
        if (!cancelled) {
          setPriceStatus("error");
        }
      } finally {
        if (!cancelled) {
          refreshTimer = setTimeout(() => {
            void loadPrice();
          }, PRICE_REFRESH_MS);
        }
      }
    };

    void loadPrice();

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [open, walletConversionEnabled]);

  useEffect(() => {
    if (!walletConversionEnabled) {
      setPriceStatus("idle");
    }
  }, [walletConversionEnabled]);

  const mintMeta = useMemo(() => {
    if (!mintUrl) return "No mint set";
    const parts = [info?.name || "Mint", info?.version ? `v${info.version}` : undefined].filter(Boolean);
    return `${parts.join(" ")} • ${mintUrl}`;
  }, [info, mintUrl]);

  const usdFormatterLarge = useMemo(() => new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }), []);

  const usdFormatterSmall = useMemo(() => new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }), []);

  const satFormatter = useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }), []);

  const formatUsdAmount = useCallback((amount: number | null) => {
    if (amount == null || !Number.isFinite(amount)) return "—";
    if (amount <= 0) return "$0.00";
    if (amount >= 1) return usdFormatterLarge.format(amount);
    return usdFormatterSmall.format(amount);
  }, [usdFormatterLarge, usdFormatterSmall]);

  const effectivePrimaryCurrency = walletConversionEnabled ? walletPrimaryCurrency : "sat";

  const usdBalance = useMemo(() => {
    if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) return null;
    return (balance / SATS_PER_BTC) * btcUsdPrice;
  }, [walletConversionEnabled, btcUsdPrice, balance]);

  const primaryCurrency = effectivePrimaryCurrency === "usd" ? "usd" : "sat";
  const unitLabel = primaryCurrency === "usd" ? "USD" : "SAT";
  const amountInputUnitLabel = primaryCurrency === "usd" ? "USD" : "sats";
  const amountInputPlaceholder = `Amount (${amountInputUnitLabel})`;
  const canToggleCurrency = walletConversionEnabled;

  const unitButtonClass = useMemo(
    () => `wallet-modal__unit chip chip-accent${canToggleCurrency ? " pressable" : ""}`,
    [canToggleCurrency]
  );

  const parseAmountInput = useCallback((raw: string) => {
    const trimmed = raw.trim();
    const unitLabelLocal = primaryCurrency === "usd" ? "USD" : "sats";
    if (!trimmed) {
      return { sats: 0, raw: 0 };
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return { sats: 0, raw: numeric, error: `Enter amount in ${unitLabelLocal}` };
    }
    if (primaryCurrency === "usd") {
      if (!walletConversionEnabled || btcUsdPrice == null || btcUsdPrice <= 0) {
        return { sats: 0, raw: numeric, error: "USD price unavailable. Try again in a moment." };
      }
      const sats = Math.floor((numeric / btcUsdPrice) * SATS_PER_BTC);
      if (sats <= 0) {
        return { sats: 0, raw: numeric, error: "Amount too small. Increase the USD value." };
      }
      return { sats, raw: numeric, usd: numeric };
    }
    const sats = Math.floor(numeric);
    if (sats <= 0) {
      return { sats: 0, raw: numeric, error: `Enter amount in ${unitLabelLocal}` };
    }
    return { sats, raw: numeric };
  }, [primaryCurrency, walletConversionEnabled, btcUsdPrice]);

  const canSubmitNwcFund = useMemo(() => {
    const parsed = parseAmountInput(nwcFundAmt);
    return !parsed.error && parsed.sats > 0;
  }, [parseAmountInput, nwcFundAmt]);

  const canSubmitNwcWithdraw = useMemo(() => {
    const parsed = parseAmountInput(nwcWithdrawAmt);
    return !parsed.error && parsed.sats > 0;
  }, [parseAmountInput, nwcWithdrawAmt]);

  const handleTogglePrimary = useCallback(() => {
    if (!walletConversionEnabled) return;
    const next = walletPrimaryCurrency === "usd" ? "sat" : "usd";
    setWalletPrimaryCurrency(next);
  }, [walletConversionEnabled, walletPrimaryCurrency, setWalletPrimaryCurrency]);
  const primaryAmountDisplay = useMemo(() => {
    if (primaryCurrency === "usd") {
      if (usdBalance == null) {
        if (!walletConversionEnabled) return "$0.00";
        return priceStatus === "error" ? "USD unavailable" : "Fetching price…";
      }
      return formatUsdAmount(usdBalance);
    }
    return `${satFormatter.format(Math.max(0, Math.floor(balance)))} sat`;
  }, [primaryCurrency, usdBalance, walletConversionEnabled, priceStatus, formatUsdAmount, satFormatter, balance]);

  const secondaryAmountDisplay = useMemo(() => {
    if (!walletConversionEnabled) return null;
    if (primaryCurrency === "usd") {
      return `≈ ${satFormatter.format(Math.max(0, Math.floor(balance)))} sat`;
    }
    if (usdBalance == null) {
      return priceStatus === "error" ? "USD unavailable" : "Fetching price…";
    }
    return `≈ ${formatUsdAmount(usdBalance)}`;
  }, [walletConversionEnabled, primaryCurrency, satFormatter, balance, usdBalance, priceStatus, formatUsdAmount]);

  const priceMeta = useMemo(() => {
    if (!walletConversionEnabled) return null;
    if (btcUsdPrice == null || btcUsdPrice <= 0) {
      return priceStatus === "error" ? "Coinbase price unavailable" : "Fetching BTC/USD price…";
    }
    const base = `Coinbase ${usdFormatterLarge.format(btcUsdPrice)} / BTC`;
    if (priceStatus === "error") {
      return `${base} • Using last update`;
    }
    if (priceUpdatedAt) {
      const timeStr = new Date(priceUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `${base} • Updated ${timeStr}`;
    }
    return base;
  }, [walletConversionEnabled, btcUsdPrice, priceStatus, priceUpdatedAt, usdFormatterLarge]);

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

    const lowerCandidate = candidate.toLowerCase();

    if (lowerCandidate.startsWith("cashu")) {
      setPendingScan({ type: "ecash", token: candidate });
      setShowScanner(false);
      return true;
    }

    if (/^creqa[0-9a-z]+$/i.test(candidate)) {
      setPendingScan({ type: "paymentRequest", request: candidate });
      setShowScanner(false);
      return true;
    }

    if (/^ln(bc|tb|sb|bcrt)[0-9]/.test(lowerCandidate)) {
      setPendingScan({ type: "bolt11", invoice: lowerCandidate });
      setShowScanner(false);
      return true;
    }

    if (/^[^@\s]+@[^@\s]+$/.test(candidate)) {
      setPendingScan({ type: "lightningAddress", address: candidate.toLowerCase() });
      setShowScanner(false);
      return true;
    }

    if (/^lnurl[0-9a-z]+$/i.test(candidate)) {
      setPendingScan({ type: "lnurl", data: candidate });
      setShowScanner(false);
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
    } catch (err: any) {
      console.error("Payment request scan failed", err);
      setPaymentRequestState(null);
      setPaymentRequestStatus("error");
      setPaymentRequestMessage("");
      setScannerMessage(err?.message || "Invalid payment request");
    }
  }, [info?.unit, mintUrl]);

  const openScanner = useCallback(async () => {
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    };
    if (navigator?.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stream.getTracks().forEach((track) => track.stop());
      } catch (err: any) {
        setScannerMessage(err?.message || "Camera permission denied");
        setPendingScan(null);
        setShowScanner(true);
        return;
      }
    }
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

    async function process() {
      switch (pendingScan.type) {
        case "ecash": {
          setRecvTokenStr(pendingScan.token);
          setRecvMsg("");
          setSendMode(null);
          setShowSendOptions(false);
          setReceiveMode("ecash");
          setShowReceiveOptions(true);
          setScannerMessage("");
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
          setScannerMessage("");
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
          setScannerMessage("");
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
      const { sats, error } = parseAmountInput(mintAmt);
      if (error) throw new Error(error);
      if (!sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
      const q = await createMintInvoice(sats);
      setMintQuote(q);
      setMintQuoteAmountSat(sats);
      setMintStatus("waiting");
      setHistory((h) => [{ id: q.quote, summary: `Invoice for ${sats} sats`, detail: q.request }, ...h]);
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
          const amountSat = mintQuoteAmountSat ?? 0;
          if (!amountSat) {
            setMintStatus("error");
            setMintError("Unable to determine mint amount. Try again.");
            clearInterval(timer);
            return;
          }
          await claimMint(mintQuote.quote, amountSat);
          setMintStatus("minted");
          setMintQuote(null);
          setMintQuoteAmountSat(null);
          setMintAmt("");
           setHistory((h) => [{ id: `mint-${Date.now()}`, summary: `Minted ${amountSat} sats` }, ...h.filter((i) => i.id !== mintQuote.quote)]);
          clearInterval(timer);
        }
      } catch (e: any) {
        setMintError(e?.message || String(e));
        setMintStatus("error");
        setMintQuoteAmountSat(null);
        clearInterval(timer);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [mintQuote, mintQuoteAmountSat, checkMintQuote, claimMint]);

  async function handleCreateSendToken() {
    try {
      const { sats, error } = parseAmountInput(sendAmt);
      if (error) throw new Error(error);
      if (!sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
      const { token } = await createSendToken(sats);
      setSendTokenStr(token);
      setHistory((h) => [{ id: `token-${Date.now()}`, summary: `Token for ${sats} sats`, detail: token }, ...h]);
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
        const normalizedAddress = normalized.toLowerCase();
        const [name, domain] = normalizedAddress.split("@");
        const infoRes = await fetch(`https://${domain}/.well-known/lnurlp/${name}`);
        if (!infoRes.ok) throw new Error("Failed to fetch LNURL pay info");
        const info = await infoRes.json();
        const parsed = parseAmountInput(lnAddrAmt);
        if (parsed.error) throw new Error(parsed.error);
        if (!parsed.sats) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
        const amtMsat = Math.max(
          info.minSendable || 0,
          Math.min(info.maxSendable || Infinity, parsed.sats * 1000)
        );
        if (!amtMsat) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
        const invRes = await fetch(`${info.callback}?amount=${amtMsat}`);
        if (!invRes.ok) throw new Error("Failed to fetch invoice");
        const inv = await invRes.json();
        if (inv?.status === "ERROR") throw new Error(inv?.reason || "Invoice request failed");
        await payMintInvoice(inv.pr);
        setHistory((h) => [{ id: `sent-${Date.now()}`, summary: `Sent ${amtMsat/1000} sats to ${normalizedAddress}` }, ...h]);
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
          : (() => {
              const parsed = parseAmountInput(lnAddrAmt);
              if (parsed.error) throw new Error(parsed.error);
              return parsed.sats;
            })();
        if (!amountSat) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
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
      const { sats: amount, error } = parseAmountInput(nwcFundAmt);
      if (error) throw new Error(error);
      if (!amount) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
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
      const { sats: amountSat, error } = parseAmountInput(lnurlWithdrawAmt);
      if (error) throw new Error(error);
      if (!amountSat) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
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
      const { sats: amount, error } = parseAmountInput(nwcWithdrawAmt);
      if (error) throw new Error(error);
      if (!amount) throw new Error(`Enter amount in ${amountInputUnitLabel}`);
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
        <button
          type="button"
          className={unitButtonClass}
          onClick={handleTogglePrimary}
          aria-disabled={!canToggleCurrency}
          title={canToggleCurrency ? "Toggle primary currency" : "Currency toggle available when conversion is enabled"}
        >
          {unitLabel}
        </button>
        <button className="ghost-button button-sm pressable" onClick={()=>setShowHistory(true)}>History</button>
      </div>
      <div className="wallet-modal__toolbar">
        <button className="ghost-button button-sm pressable" onClick={()=>setShowMintBalances(true)}>Mint balances</button>
      </div>
      <div className="wallet-modal__content">
        <div className="wallet-balance-card">
          <div className="wallet-balance-card__amount">{primaryAmountDisplay}</div>
          {secondaryAmountDisplay && (
            <div className="wallet-balance-card__secondary">{secondaryAmountDisplay}</div>
          )}
          <div className="wallet-balance-card__meta">
            <div>{mintMeta}</div>
            {priceMeta && <div>{priceMeta}</div>}
          </div>
        </div>
        <div className="wallet-modal__cta">
          <button className="accent-button pressable" onClick={()=>{ setShowReceiveOptions(true); }}>{"Receive"}</button>
          <button
            type="button"
            className="wallet-modal__scan-button pressable"
            onClick={()=>{ void openScanner(); }}
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
          {npubCashLightningAddressEnabled && (
            <button
              className="ghost-button button-sm pressable w-full justify-between"
              onClick={()=>setReceiveMode("npubCashAddress")}
            >
              <span>Lightning address (npub.cash)</span>
              <span className="text-tertiary">→</span>
            </button>
          )}
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

      <ActionSheet
        open={receiveMode === "npubCashAddress"}
        onClose={()=>{
          setReceiveMode(null);
          setShowReceiveOptions(false);
        }}
        title="npub.cash Lightning address"
      >
        <div className="wallet-section space-y-3">
          {npubCashIdentity ? (
            <>
              <QrCodeCard
                value={npubCashIdentity.address}
                label="Lightning address"
                copyLabel="Copy address"
              />
              <div className="text-xs text-secondary">
                Share this address to receive Lightning payments that arrive as Cashu tokens.
              </div>
              <div className="text-xs text-secondary break-all">Nostr npub: {npubCashIdentity.npub}</div>
              <div className="space-y-2">
                <div className="text-sm font-medium">Claim pending eCash</div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-secondary">
                  <button
                    className="accent-button button-sm pressable"
                    onClick={() => { void handleClaimNpubCash(); }}
                    disabled={npubCashClaimStatus === "checking"}
                  >
                    {npubCashClaimStatus === "checking" ? "Checking…" : "Claim now"}
                  </button>
                  {npubCashAutoClaim && (
                    <span>Auto-claim runs when you open the wallet.</span>
                  )}
                </div>
                {npubCashClaimMessage && (
                  <div
                    className={`text-xs ${
                      npubCashClaimStatus === "error"
                        ? "text-rose-500"
                        : npubCashClaimStatus === "success"
                          ? "text-emerald-500"
                          : "text-secondary"
                    }`}
                  >
                    {npubCashClaimMessage}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="text-xs text-secondary">{npubCashIdentityError || "Add your Taskify Nostr key to enable npub.cash."}</div>
          )}
        </div>
      </ActionSheet>

      <ActionSheet open={receiveMode === "lightning"} onClose={()=>{setReceiveMode(null); setShowReceiveOptions(false);}} title="Mint via Lightning">
        <div className="wallet-section space-y-3">
          <div className="flex gap-2">
            <input className="pill-input flex-1" placeholder={amountInputPlaceholder} value={mintAmt} onChange={(e)=>setMintAmt(e.target.value)} />
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
              placeholder={amountInputPlaceholder}
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
            <input className="pill-input" placeholder={amountInputPlaceholder} value={nwcFundAmt} onChange={(e)=>setNwcFundAmt(e.target.value)} />
          <div className="flex flex-wrap gap-2 items-center text-xs text-secondary">
            <button
              className="accent-button button-sm pressable"
              onClick={handleNwcFund}
              disabled={!hasNwcConnection || !mintUrl || nwcFundInProgress || !canSubmitNwcFund}
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
            <input className="pill-input flex-1" placeholder={amountInputPlaceholder} value={sendAmt} onChange={(e)=>setSendAmt(e.target.value)} />
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

      <ActionSheet
        open={sendMode === "lightning"}
        onClose={() => {
          setSendMode(null);
          setShowSendOptions(false);
          setLnInput("");
          setLnAddrAmt("");
          setLnState("idle");
          setLnError("");
          setContactsOpen(false);
          resetContactForm();
        }}
        title="Pay Lightning Invoice"
      >
        <div className="wallet-section space-y-3">
          <div className="flex flex-wrap gap-2 items-center text-xs text-secondary">
            <button
              className="ghost-button button-sm pressable"
              type="button"
              onClick={() => setContactsOpen((prev) => !prev)}
              aria-expanded={contactsOpen}
            >
              {contactsOpen ? "Hide contacts" : "Contacts"}
            </button>
            {contactsOpen && (
              <button
                className="ghost-button button-sm pressable"
                type="button"
                onClick={handleStartNewContact}
              >
                New contact
              </button>
            )}
            {!contactsOpen && sortedContacts.length > 0 && (
              <span>Select a saved contact to fill their address.</span>
            )}
            {!contactsOpen && sortedContacts.length === 0 && (
              <span>No saved contacts yet.</span>
            )}
          </div>
          {contactsOpen && (
            <div
              className="flex flex-col gap-3 bg-surface-muted border border-surface rounded-2xl p-3 text-xs"
              style={{ maxHeight: "min(calc(100dvh - 23rem), calc(100vh - 9rem))" }}
            >
              <div className="text-secondary text-[11px]">
                {sortedContacts.length
                  ? "Select a contact to use their lightning address."
                  : "Add a contact to quickly reuse a lightning address."}
              </div>
              {contactFormVisible && (
                <form className="space-y-2" onSubmit={handleSubmitContact}>
                  <div className="space-y-2">
                    <input
                      className="pill-input"
                      placeholder="Contact name (optional)"
                      value={contactForm.name}
                      onChange={(e) => setContactForm((prev) => ({ ...prev, name: e.target.value }))}
                      autoComplete="name"
                    />
                    <input
                      className="pill-input"
                      placeholder="Lightning address"
                      value={contactForm.address}
                      onChange={(e) => setContactForm((prev) => ({ ...prev, address: e.target.value }))}
                      autoComplete="off"
                      aria-required={true}
                    />
                  </div>
                  <div className="text-[11px] text-secondary">
                    {contactForm.id
                      ? `Editing ${contactForm.name?.trim() || "saved contact"}`
                      : "Create a shortcut for frequently used lightning addresses."}
                  </div>
                  {contactFormError && <div className="text-[11px] text-rose-500">{contactFormError}</div>}
                  <div className="flex flex-wrap gap-2 text-xs">
                    <button className="accent-button button-sm pressable" type="submit">
                      {contactForm.id ? "Save contact" : "Add contact"}
                    </button>
                    <button
                      className="ghost-button button-sm pressable"
                      type="button"
                      onClick={resetContactForm}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
              {sortedContacts.length ? (
                <div className="flex-1 min-h-0 space-y-2 overflow-y-auto pr-1">
                  {sortedContacts.map((contact) => (
                    <div key={contact.id} className="flex flex-col gap-1 rounded-xl border border-transparent bg-surface px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="ghost-button button-sm pressable w-full text-left truncate"
                          onClick={() => handleSelectContact(contact)}
                        >
                          {contact.name?.trim() || contact.address}
                        </button>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            className="icon-button pressable"
                            style={SMALL_ICON_BUTTON_STYLE}
                            onClick={() => handleStartEditContact(contact)}
                            aria-label={`Edit contact ${contact.name || contact.address}`}
                            title={`Edit contact ${contact.name || contact.address}`}
                          >
                            <PencilIcon className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="icon-button pressable icon-button--danger"
                            style={SMALL_ICON_BUTTON_STYLE}
                            onClick={() => {
                              if (window.confirm("Remove this contact?")) {
                                handleDeleteContact(contact.id);
                              }
                            }}
                            aria-label={`Delete contact ${contact.name || contact.address}`}
                            title={`Delete contact ${contact.name || contact.address}`}
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      {contact.name?.trim() && (
                        <div className="text-[11px] text-secondary break-all">{contact.address}</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                !contactFormVisible && (
                  <div className="text-secondary">Add a contact to quickly reuse a lightning address.</div>
                )
              )}
            </div>
          )}
          <textarea ref={lnRef} className="pill-textarea wallet-textarea" placeholder="Paste BOLT11 invoice or enter lightning address" value={lnInput} onChange={(e)=>setLnInput(e.target.value)} />
          {(isLnAddress || isLnurlInput) && (
          <input className="pill-input" placeholder={amountInputPlaceholder} value={lnAddrAmt} onChange={(e)=>setLnAddrAmt(e.target.value)} />
          )}
          {isLnurlInput && lnurlPayData && (
            <div className="text-xs text-secondary">
              Limits: {Math.ceil(lnurlPayData.minSendable / 1000)} – {Math.floor(lnurlPayData.maxSendable / 1000)} sats
            </div>
          )}
          {bolt11Details?.message && (
            <div className="text-xs text-secondary">{bolt11Details.message}</div>
          )}
          {bolt11Details?.error && (
            <div className="text-xs text-rose-400">{bolt11Details.error}</div>
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
          <input className="pill-input" placeholder={amountInputPlaceholder} value={nwcWithdrawAmt} onChange={(e)=>setNwcWithdrawAmt(e.target.value)} />
          <div className="flex flex-wrap gap-2 items-center text-xs text-secondary">
            <button
              className="accent-button button-sm pressable"
              onClick={handleNwcWithdraw}
              disabled={!hasNwcConnection || !mintUrl || nwcWithdrawInProgress || !canSubmitNwcWithdraw}
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
                    <div className="flex flex-col gap-2 w-full sm:w-auto">
                      <button
                        className="ghost-button button-sm pressable w-full"
                        onClick={async ()=>{ try { await navigator.clipboard?.writeText(m.url); } catch {} }}
                      >Copy</button>
                      {m.url !== mintUrl && (
                        <button className="accent-button button-sm pressable w-full" onClick={async ()=>{ try { await setMintUrl(m.url); refreshMintEntries(); } catch (e: any) { alert(e?.message || String(e)); } }}>Set active</button>
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
