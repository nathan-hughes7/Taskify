import React from "react";

export function ActionSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode; }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="max-h-[80%] w-full rounded-t-2xl bg-neutral-900 p-4 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          {title && <div className="font-semibold">{title}</div>}
          <button className="ml-auto px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

