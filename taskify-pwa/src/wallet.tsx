import { useEffect, useState } from "react";

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
  const [showSend, setShowSend] = useState(false);
  const [showReceive, setShowReceive] = useState(false);

  // Ensure seed exists
  useEffect(() => {
    getWalletMnemonic();
  }, []);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-medium">Ecash Wallet</h2>
      <div>Balance: 0 sats</div>
      <div className="flex gap-4">
        <div>
          <button
            className="px-3 py-2 rounded-xl bg-neutral-800"
            onClick={() => setShowSend((s) => !s)}
          >
            Send
          </button>
          {showSend && (
            <div className="mt-2 flex gap-2">
              <button className="px-3 py-2 rounded-xl bg-neutral-800">
                Ecash
              </button>
              <button className="px-3 py-2 rounded-xl bg-neutral-800">
                Lightning
              </button>
            </div>
          )}
        </div>
        <div>
          <button
            className="px-3 py-2 rounded-xl bg-neutral-800"
            onClick={() => setShowReceive((s) => !s)}
          >
            Receive
          </button>
          {showReceive && (
            <div className="mt-2 flex gap-2">
              <button className="px-3 py-2 rounded-xl bg-neutral-800">
                Ecash
              </button>
              <button className="px-3 py-2 rounded-xl bg-neutral-800">
                Lightning
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

