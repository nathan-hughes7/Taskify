import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { finalizeEvent, getPublicKey, nip04, nip19 } from "nostr-tools";
import { Relay } from "nostr-tools/relay";
import { parseConnectionString } from "nostr-tools/nip47";

const REQUEST_KIND = 23194;
const RESPONSE_KIND = 23195;

export type NwcConnectionDetails = {
  connectionString: string;
  relay: string;
  walletPubkey: string;
  clientPubkey: string;
};

type NwcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string };
};

function decodeKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Missing key value");
  }
  if (trimmed.startsWith("npub") || trimmed.startsWith("nsec")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "npub" && typeof decoded.data === "string") {
      return { hex: decoded.data, bytes: hexToBytes(decoded.data) };
    }
    if (decoded.type === "nsec" && decoded.data instanceof Uint8Array) {
      return { hex: bytesToHex(decoded.data), bytes: decoded.data };
    }
    if (typeof decoded.data === "string") {
      return { hex: decoded.data, bytes: hexToBytes(decoded.data) };
    }
    if (decoded.data instanceof Uint8Array) {
      return { hex: bytesToHex(decoded.data), bytes: decoded.data };
    }
    throw new Error("Unsupported key format");
  }
  const normalized = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("Key must be hex encoded");
  }
  return { hex: normalized.toLowerCase(), bytes: hexToBytes(normalized) };
}

function buildConnection(connectionString: string) {
  const parsed = parseConnectionString(connectionString.trim());
  const walletKey = decodeKey(parsed.pubkey);
  const secretKey = decodeKey(parsed.secret);
  const relay = parsed.relay;
  if (!relay) {
    throw new Error("Connection string missing relay");
  }
  return {
    connectionString: connectionString.trim(),
    walletPubkey: walletKey.hex,
    secret: secretKey.bytes,
    relay,
  };
}

export class NwcClient {
  readonly connectionString: string;
  readonly relayUrl: string;
  readonly walletPubkey: string;
  readonly clientPubkey: string;
  private readonly secretKey: Uint8Array;
  private relay: Relay | null = null;
  private connectPromise: Promise<Relay> | null = null;
  requestTimeout = 15000;

  constructor(connectionString: string) {
    if (!connectionString.trim()) {
      throw new Error("Connection string required");
    }
    const data = buildConnection(connectionString);
    this.connectionString = data.connectionString;
    this.relayUrl = data.relay;
    this.walletPubkey = data.walletPubkey;
    this.secretKey = data.secret;
    this.clientPubkey = getPublicKey(this.secretKey);
  }

  close() {
    if (this.relay) {
      try {
        this.relay.close();
      } catch {
        // ignore
      }
    }
    this.relay = null;
    this.connectPromise = null;
  }

  private async ensureRelay(): Promise<Relay> {
    if (this.relay && this.relay.connected) {
      return this.relay;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    const attempt = Relay.connect(this.relayUrl);
    this.connectPromise = attempt;
    try {
      const relay = await attempt;
      relay.onclose = () => {
        if (this.relay === relay) {
          this.relay = null;
          this.connectPromise = null;
        }
      };
      this.relay = relay;
      return relay;
    } catch (err) {
      this.connectPromise = null;
      this.relay = null;
      throw err;
    }
  }

  private buildEvent(method: string, params: Record<string, unknown>) {
    const payload = { method, params };
    const encrypted = nip04.encrypt(this.secretKey, this.walletPubkey, JSON.stringify(payload));
    const event = finalizeEvent(
      {
        kind: REQUEST_KIND,
        created_at: Math.floor(Date.now() / 1000),
        content: encrypted,
        tags: [["p", this.walletPubkey]],
      },
      this.secretKey,
    );
    return event;
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<NwcResponse> {
    const relay = await this.ensureRelay();
    const event = this.buildEvent(method, params);
    return new Promise<NwcResponse>((resolve, reject) => {
      let settled = false;
      const cleanup = (error?: Error, data?: NwcResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        try {
          sub.close();
        } catch {
          // ignore
        }
        if (error) {
          reject(error);
        } else {
          resolve(data || {});
        }
      };

      const sub = relay.subscribe(
        [{ kinds: [RESPONSE_KIND], "#e": [event.id] }],
        {
          onevent: (evt) => {
            if (evt.pubkey !== this.walletPubkey) return;
            const pTag = evt.tags.find((t) => t[0] === "p");
            if (pTag && pTag[1] !== this.clientPubkey) return;
            try {
              const decrypted = nip04.decrypt(this.secretKey, evt.pubkey, evt.content);
              const parsed = JSON.parse(decrypted) as NwcResponse;
              cleanup(undefined, parsed);
            } catch (e) {
              const err = e instanceof Error ? e : new Error(String(e));
              cleanup(err);
            }
          },
          onclose: (reason) => {
            if (settled) return;
            cleanup(new Error(reason || "NWC subscription closed"));
          },
        },
      );

      const timeoutHandle = setTimeout(() => {
        cleanup(new Error("NWC request timed out"));
      }, this.requestTimeout);

      relay.publish(event).catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        cleanup(error);
      });
    });
  }

  async payInvoice(invoice: string) {
    if (!invoice.trim()) throw new Error("Invoice required");
    const response = await this.sendRequest("pay_invoice", { invoice: invoice.trim() });
    if (response.error) {
      throw new Error(response.error.message || "NWC payment failed");
    }
    return response.result;
  }

  async makeInvoice(amountSat: number, memo?: string): Promise<string> {
    const sats = Math.max(0, Math.floor(amountSat));
    if (!sats) throw new Error("Amount must be greater than zero");
    const amountMsat = String(sats * 1000);
    const params: Record<string, unknown> = { amount: amountMsat };
    if (memo) {
      params.description = memo;
      params.memo = memo;
    }
    const response = await this.sendRequest("make_invoice", params);
    if (response.error) {
      throw new Error(response.error.message || "Failed to create invoice via NWC");
    }
    const result = response.result as { invoice?: string } | undefined;
    if (!result?.invoice) {
      throw new Error("NWC invoice response missing invoice");
    }
    return result.invoice;
  }

  get details(): NwcConnectionDetails {
    return {
      connectionString: this.connectionString,
      relay: this.relayUrl,
      walletPubkey: this.walletPubkey,
      clientPubkey: this.clientPubkey,
    };
  }
}
