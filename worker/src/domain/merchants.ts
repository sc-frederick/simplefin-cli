/** Payment wrappers and processors that prefix the real merchant name. */
const PREFIXES =
  /^(?:APLPAY|APPLE PAY|GOOGLE \*|GOOGLE|PAYPAL \*|PAYPAL|PP\*|SQ \*|SQ\*|TST\* ?|TST\*|SP \*|SP |DD \*|DOORDASH\*|IC\* ?|PY \*|CKO\*|BT\*|FS \*|WPY\*|POS |ACH |DEBIT |RECURRING |PURCHASE )\s*/iu;

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(
    " ",
  ),
);

/** Money moving between the user's own accounts or paying off a card, not spending. */
const TRANSFER =
  /ONLINE TRANSFER|TRANSFER (TO|FROM)|AUTOPAY|AUTO PAY|PAYMENT[ -]*THANK YOU|MOBILE PAYMENT|ONLINE PAYMENT|PAYMENT RECEIVED|AMERICAN EXPRESS (CREDIT|TRA)|CREDIT CARD PAYMENT|EPAYMENT|EPAY /iu;

/** Card-present (tap to pay) purchases are almost never subscriptions. */
const CARD_PRESENT = /^(APLPAY|APPLE PAY)\b/iu;

const TRIMMED_PUNCTUATION = /^[.,;:*]+|[.,;:*]+$/gu;
const DOMAIN_PATH = /(\.COM|\.NET|\.IO|\.AI|\.CO)\/.*$/u;

/**
 * Reduce a raw bank description to a stable merchant name, e.g.
 * "PAYPAL *AUTODESK 4029357733 CA" becomes "AUTODESK" and
 * "AplPay CHICK-FIL-A #JACKSONVILLE FL" becomes "CHICK-FIL-A".
 */
export function merchantKey(description: string): string {
  let text = description.toUpperCase().trim();

  for (let pass = 0; pass < 3; pass += 1) {
    const stripped = text.replace(PREFIXES, "");

    if (stripped === text) break;

    text = stripped;
  }

  const tokens: Array<string> = [];

  for (const raw of text.split(/\s+/u)) {
    const token = raw.replace(TRIMMED_PUNCTUATION, "");
    const digits = token.replace(/\D/gu, "").length;

    // Phone numbers, store numbers and reference ids vary between charges.
    if (token === "" || token.startsWith("#") || digits >= 3) continue;

    tokens.push(token);
  }

  while (tokens.length > 1 && US_STATES.has(tokens.at(-1) ?? "")) tokens.pop();

  // Domains like APPLE.COM/BILL keep only the domain.
  const named = tokens.slice(0, 3).map((token) => token.replace(DOMAIN_PATH, "$1"));
  const key = named.length > 0 ? named.join(" ") : description.toUpperCase().trim();

  return key === "" ? "UNKNOWN" : key;
}

/** True for transfers between the user's accounts and card payments, which are not spending. */
export function isTransfer(description: string, payee: string | null): boolean {
  return TRANSFER.test(description) || (payee !== null && TRANSFER.test(payee));
}

/** True for tap-to-pay purchases made in person. */
export function isCardPresent(description: string): boolean {
  return CARD_PRESENT.test(description);
}
