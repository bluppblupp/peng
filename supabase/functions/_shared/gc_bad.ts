// supabase/functions/_shared/gc_bad.ts
import { getNumber, getString, isRecord } from "./gc.ts";

/** Upstream BAD (Bank Account Data) shapes we touch */
export type BankAccountDataTx = {
  transactionId?: unknown;
  internalTransactionId?: unknown;
  entryReference?: unknown;

  bookingDate?: unknown; // "YYYY-MM-DD"
  valueDate?: unknown;

  transactionAmount?: unknown; // { amount, currency }

  creditorName?: unknown;
  debtorName?: unknown;

  remittanceInformationUnstructured?: unknown;
  remittanceInformationStructured?: unknown;

  // card-specific blobs appear in some banks/data
  cardTransaction?: unknown; // { merchantName?, ... }
  additionalInformation?: unknown; // string-ish in some banks
};

export type BankAccountDataTxPage = {
  transactions?: { booked?: unknown; pending?: unknown };
  next?: unknown;
};

export type NormalizedTx = {
  transaction_id: string;
  description_raw: string;      // not yet pretty-cleaned
  counterparty: string;
  amount: number;               // possibly positive before sign-fix
  currency: string | null;
  date: string;                 // YYYY-MM-DD
};

/** First non-empty string from candidates */
function firstStr(...cands: Array<unknown>): string | null {
  for (const c of cands) {
    if (typeof c === "string") {
      const s = c.trim();
      if (s) return s;
    }
  }
  return null;
}

/** Prefer bookingDate, else valueDate, else today */
function pickDate(tx: BankAccountDataTx): string {
  const d = firstStr(tx.bookingDate, tx.valueDate);
  if (d) return d.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/** Try to extract merchant-ish description */
function pickRawDescription(tx: BankAccountDataTx): string {
  // Card sub-object merchant name (if present)
  const cardObj = isRecord(tx.cardTransaction) ? tx.cardTransaction : null;
  const cardMerchant = cardObj ? getString(cardObj, "merchantName") : null;

  const remUn = typeof tx.remittanceInformationUnstructured === "string"
    ? tx.remittanceInformationUnstructured : null;
  const remSt = typeof tx.remittanceInformationStructured === "string"
    ? tx.remittanceInformationStructured : null;

  const cp = firstStr(tx.creditorName, tx.debtorName);

  // Some banks stick a sentence in "additionalInformation"
  const addInfo = typeof tx.additionalInformation === "string"
    ? tx.additionalInformation : null;

  return (
    firstStr(cardMerchant, remUn, remSt, cp, addInfo) ??
    "Transaction"
  );
}

/** Gentle cleaner for display text (don’t over-trim; Swedish chars ok) */
export function cleanDescription(s: string): string {
  let d = s;

  // remove common noise tokens at start
  d = d.replace(/^\s*(KORTK[ÖO]P|VISA ?PURCHASE|MC(?:B)? ?K[ÖO]P|CARD ?PURCHASE|AUTOGIRO|ÖVERFÖRING|BETALNING)\b[:\- ]*/i, "");
  // collapse separators and whitespace
  d = d.replace(/[|_*#;]+/g, " ").replace(/\s{2,}/g, " ").trim();

  // extremely short/empty fallback
  if (!d || d.length < 2) return "Transaction";
  return d;
}

/** Hash fallback for missing transaction id (stable per account + key fields) */
async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Normalize one upstream transaction into our working shape (pre sign-fix) */
export async function toNormalizedTx(
  tx: BankAccountDataTx,
  providerAccountId: string
): Promise<NormalizedTx> {
  const txId  = typeof tx.transactionId === "string" ? tx.transactionId : null;
  const itxId = typeof tx.internalTransactionId === "string" ? tx.internalTransactionId : null;
  const refId = typeof tx.entryReference === "string" ? tx.entryReference : null;

  let transaction_id = (txId || itxId || refId || "").trim();

  const amtObj = isRecord(tx.transactionAmount) ? tx.transactionAmount : null;
  const amountNum = amtObj ? getNumber(amtObj, "amount") : null;
  const currency  = amtObj ? getString(amtObj, "currency") : null;

  const description_raw = pickRawDescription(tx);
  const counterparty =
    firstStr(tx.creditorName, tx.debtorName) ?? "";

  const date = pickDate(tx);

  if (!transaction_id) {
    const hint = [
      date,
      amountNum !== null ? String(amountNum) : "",
      currency ?? "",
      description_raw,
    ].join("|");
    transaction_id = await sha256Hex(`${providerAccountId}|${hint}`);
  }

  return {
    transaction_id,
    description_raw,
    counterparty,
    amount: (amountNum !== null && Number.isFinite(amountNum)) ? amountNum : 0,
    currency,
    date,
  };
}
