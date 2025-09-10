import { useState } from "react";

export default function Wallet() {
  const [seed] = useState(() => {
    try {
      const existing = localStorage.getItem("ecash_wallet_seed");
      if (existing) return existing;
    } catch {}
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const hex = Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem("ecash_wallet_seed", hex); } catch {}
    return hex;
  });
  const [revealed, setRevealed] = useState(false);

  const backup = () => {
    navigator.clipboard?.writeText(seed);
    alert("Seed phrase copied to clipboard");
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-medium">Ecash Wallet</h2>
      <div>Balance: 0 sats</div>
      <div>
        <button
          className="px-3 py-2 rounded-xl bg-neutral-800"
          onClick={backup}
        >
          Backup seed phrase
        </button>
        <button
          className="ml-2 px-3 py-2 rounded-xl bg-neutral-800"
          onClick={() => setRevealed(r => !r)}
        >
          {revealed ? "Hide" : "Show"}
        </button>
        {revealed && (
          <div className="mt-2 text-xs break-all">{seed}</div>
        )}
      </div>
    </div>
  );
}
