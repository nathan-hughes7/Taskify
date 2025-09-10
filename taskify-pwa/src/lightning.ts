// Minimal Lightning helpers for demo wallet.
// These functions simulate creating and paying Lightning invoices.

/** Create a fake Lightning invoice for the specified amount. */
export async function createInvoice(amount: number): Promise<string> {
  if (amount <= 0) throw new Error('amount must be positive');
  const rand = Math.random().toString(36).slice(2);
  // Simplified bolt11: lnbc{amount}n{random}
  return `lnbc${amount}n${rand}`;
}

/** Decode amount from our simplified invoice format. */
export function decodeInvoice(invoice: string): number {
  const m = invoice.match(/^lnbc(\d+)n/);
  if (!m) throw new Error('invalid invoice');
  return parseInt(m[1], 10);
}

/** Pay a fake Lightning invoice. */
export async function payInvoice(invoice: string): Promise<void> {
  // Validate format then simulate a short delay.
  decodeInvoice(invoice);
  await new Promise((resolve) => setTimeout(resolve, 50));
}
