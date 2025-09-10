import { useEffect, useState } from "react";
import { getWallet } from "./cashu";

// Simple mnemonic generator using color/animal combinations.
const COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "black",
  "white",
  "gray",
  "brown",
  "pink",
  "cyan",
  "magenta",
  "lime",
  "navy",
  "teal",
];

const ANIMALS = [
  "ant",
  "bear",
  "cat",
  "dog",
  "eel",
  "fox",
  "goat",
  "hen",
  "ibis",
  "jay",
  "koala",
  "lion",
  "mole",
  "newt",
  "owl",
  "pig",
];

function wordFromByte(b: number) {
  const color = COLORS[b >> 4];
  const animal = ANIMALS[b & 15];
  return color + animal;
}

export function getWalletMnemonic(): string {
  try {
    const existing = localStorage.getItem("ecash_wallet_seed");
    if (existing) return existing;
  } catch {}
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const words = Array.from(bytes).map(wordFromByte);
  const mnemonic = words.join(" ");
  try {
    localStorage.setItem("ecash_wallet_seed", mnemonic);
  } catch {}
  return mnemonic;
}

export default function Wallet() {
  const wallet = getWallet();
  const [balance, setBalance] = useState(0);
  const [sendAmount, setSendAmount] = useState("");
  const [sendToken, setSendToken] = useState("");
  const [receiveToken, setReceiveToken] = useState("");

  // Ensure seed exists
  useEffect(() => {
    getWalletMnemonic();
    setBalance(wallet.balance);
  }, [wallet]);

  const handleSend = () => {
    const amt = parseInt(sendAmount, 10);
    if (!amt) return;
    const token = wallet.send(amt);
    if (token) {
      setSendToken(token);
      setBalance(wallet.balance);
    }
  };

  const handleReceive = () => {
    try {
      wallet.receive(receiveToken);
      setReceiveToken("");
      setBalance(wallet.balance);
    } catch {}
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-medium">Ecash Wallet</h2>
      <div>Balance: {balance} sats</div>

      <div className="space-y-3">
        <div>
          <div className="mb-2 font-medium">Send</div>
          <div className="flex gap-2 mb-2">
            <input
              className="px-3 py-2 rounded-xl bg-neutral-900 w-24"
              value={sendAmount}
              onChange={(e) => setSendAmount(e.target.value)}
              placeholder="sats"
            />
            <button
              className="px-3 py-2 rounded-xl bg-neutral-800"
              onClick={handleSend}
            >
              Create token
            </button>
          </div>
          {sendToken && (
            <textarea
              className="w-full h-24 p-2 rounded-xl bg-neutral-900"
              readOnly
              value={sendToken}
            />
          )}
        </div>

        <div>
          <div className="mb-2 font-medium">Receive</div>
          <textarea
            className="w-full h-24 p-2 rounded-xl bg-neutral-900 mb-2"
            value={receiveToken}
            onChange={(e) => setReceiveToken(e.target.value)}
            placeholder="paste token"
          />
          <button
            className="px-3 py-2 rounded-xl bg-neutral-800"
            onClick={handleReceive}
          >
            Add token
          </button>
        </div>
      </div>
    </div>
  );
}

