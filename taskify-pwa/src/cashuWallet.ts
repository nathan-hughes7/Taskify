import { CashuWallet, CashuMint } from "cashu-ts";

/**
 * Simple wrapper around the cashu-ts wallet providing
 * ecash and lightning functionality for the Taskify app.
 */
export class EcashLightningWallet {
  private wallet: CashuWallet;

  constructor(private mintUrl: string) {
    const mint = new CashuMint(mintUrl);
    this.wallet = new CashuWallet(mint);
  }

  /** Return total wallet balance in sats. */
  async balance(): Promise<number> {
    const proofs = await this.wallet.getWalletProofs();
    return proofs.reduce((sum, p) => sum + p.amount, 0);
  }

  /**
   * Receive ecash token string and store proofs in the wallet.
   * Returns the amount received in sats.
   */
  async receiveToken(token: string): Promise<number> {
    const { proofs } = await this.wallet.receive(token);
    return proofs.reduce((sum, p) => sum + p.amount, 0);
  }

  /**
   * Send an ecash token for the requested amount. The caller is
   * responsible for delivering the token to the recipient.
   */
  async sendToken(amount: number): Promise<string> {
    const { token } = await this.wallet.send(amount);
    return token;
  }

  /**
   * Mint new ecash using a paid Lightning invoice.
   */
  async mintViaInvoice(amount: number, invoice: string): Promise<void> {
    await this.wallet.mint(amount, invoice);
  }

  /**
   * Pay a Lightning invoice using funds from the wallet.
   */
  async payInvoice(invoice: string): Promise<void> {
    await this.wallet.payLightningInvoice(invoice);
  }
}
