import React from "react";

export function ActionSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode; }) {
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-panel__header">
          {title && <div className="font-semibold text-sm uppercase tracking-wide text-secondary">{title}</div>}
          <button className="ghost-button button-sm pressable ml-auto" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
