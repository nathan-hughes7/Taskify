declare module "cashu-ts" {
  export class CashuMint {
    constructor(url: string);
  }

  export class CashuWallet {
    constructor(mint: CashuMint);
    getWalletProofs(): Promise<Array<{ amount: number }>>;
    receive(token: string): Promise<{ proofs: Array<{ amount: number }> }>;
    send(amount: number): Promise<{ token: string }>;
    mint(amount: number, invoice: string): Promise<void>;
    payLightningInvoice(invoice: string): Promise<void>;
  }
}
