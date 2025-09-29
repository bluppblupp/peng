// supabase/functions/_shared/gc_categorize.ts

export type CategorizeInput = {
  description?: string;
  counterparty?: string;
  amount?: number;
  currency?: string;
  transactionId?: string; // <— OPTIONAL: useful for exact overrides
};

export type UserOverride = {
  matchType:
    | "transaction_id"
    | "counterparty_exact"
    | "counterparty_contains"
    | "description_contains"
    | "regex"
    | "amount_equals"
    | "amount_between"
    | "starts_with"
    | "ends_with";
  pattern?: string;
  amountMin?: number | null;
  amountMax?: number | null;
  currency?: string | null;
  category: string;
  priority: number;     // lower = stronger
  createdAt?: string;   // for deterministic tie-breaks
};

export type CategorizeOptions = {
  // If the user set a manual category on this specific transaction, it wins.
  manualCategory?: string | null;
  // User’s reusable rules for this user, pre-fetched by the caller.
  userOverrides?: UserOverride[];
};

export type CategorizeOutput = { category: string };

export function categorize(
  input: CategorizeInput,
  opts: CategorizeOptions = {}
): CategorizeOutput {
  // 0) Manual per-transaction override wins outright
  if (opts.manualCategory && opts.manualCategory.trim()) {
    return { category: opts.manualCategory.trim() };
  }

  const desc = (input.description ?? "").toLowerCase();
  const cp = (input.counterparty ?? "").toLowerCase();
  const text = `${desc} ${cp}`.trim();
  const amt = input.amount ?? null;
  const cur = input.currency?.toUpperCase() ?? null;

  // 1) User reusable rules (deterministic order: priority ASC, then createdAt ASC)
  if (opts.userOverrides?.length) {
    const sorted = [...opts.userOverrides].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    });

    for (const r of sorted) {
      if (r.currency && cur && r.currency.toUpperCase() !== cur) continue;

      const pat = (r.pattern ?? "").toLowerCase();

      const matches = (() => {
        switch (r.matchType) {
          case "transaction_id":
            return !!input.transactionId && pat === input.transactionId.toLowerCase();
          case "counterparty_exact":
            return !!cp && cp === pat;
          case "counterparty_contains":
            return !!cp && cp.includes(pat);
          case "description_contains":
            return !!desc && desc.includes(pat);
          case "starts_with":
            return !!text && text.startsWith(pat);
          case "ends_with":
            return !!text && text.endsWith(pat);
          case "regex":
            try {
              const re = new RegExp(r.pattern ?? "", "i");
              return re.test(text);
            } catch {
              return false; // invalid regex—ignore
            }
          case "amount_equals":
            return amt !== null && r.amountMin !== null && amt === r.amountMin;
          case "amount_between": {
            if (amt === null) return false;
            const lo = r.amountMin ?? Number.NEGATIVE_INFINITY;
            const hi = r.amountMax ?? Number.POSITIVE_INFINITY;
            return amt >= lo && amt <= hi;
          }
          default:
            return false;
        }
      })();

      if (matches) {
        return { category: r.category };
      }
    }
  }

  // 2) Fall back to your existing automatic rules
  // (unchanged from your current implementation, pasted here)
  const rules: Array<{ cat: string; patterns: Array<{ re: RegExp; weight: number }> }> = [
    { cat: "salary", patterns: [
      { re: /\b(lön|lon|salary|payroll|wage|löner|utbetalning)\b/i, weight: 6 },
    ]},
    { cat: "groceries", patterns: [
      { re: /\b(ica|coop|wil{1,2}ys|hemköp|lidl)\b/i, weight: 6 },
      { re: /\b(grocery|supermarket|matbutik)\b/i, weight: 3 },
    ]},
    { cat: "dining", patterns: [
      { re: /\b(restaurang|restaurant|café|cafe|bar|pub|coffee|espresso|starbucks)\b/i, weight: 5 },
    ]},
    { cat: "shopping", patterns: [
      { re: /\b(amazon|zalando|clas ?ohlson|elgiganten|ikea|apotea)\b/i, weight: 5 },
      { re: /\b(shopping|retail|butik)\b/i, weight: 2 },
    ]},
    { cat: "utilities", patterns: [
      { re: /\b(vattenfall|ellevio|eon|fortum)\b/i, weight: 6 },
      { re: /\b(telia|tele2|\b3\b|tre|comhem|bredband|fiber)\b/i, weight: 5 },
      { re: /\b(electric|water|gas|el|energi|broadband)\b/i, weight: 3 },
    ]},
    { cat: "rent", patterns: [{ re: /\b(rent|hyra|landlord|bostad)\b/i, weight: 6 }]},
    { cat: "transport", patterns: [
      { re: /\b(sl|sj|arlanda express|ul|skånetrafiken)\b/i, weight: 6 },
      { re: /\b(uber|bolt|taxi)\b/i, weight: 5 },
      { re: /\b(train|bus|metro|subway|pendeltåg|buss)\b/i, weight: 3 },
    ]},
    { cat: "travel", patterns: [
      { re: /\b(hotel|ryanair|sas|norwegian|airbnb|booking\.com)\b/i, weight: 5 },
      { re: /\b(flight|flyg|resa|travel)\b/i, weight: 3 },
    ]},
    { cat: "health", patterns: [
      { re: /\b(apotek|pharmacy|doctor|dentist|sjukhus|vårdcentral)\b/i, weight: 5 },
    ]},
    { cat: "insurance", patterns: [
      { re: /\b(försäkring|forsakring|länsförsäkringar|folksam|if|moderna)\b/i, weight: 6 },
    ]},
    { cat: "subscription", patterns: [
      { re: /\b(spotify|netflix|viaplay|disney\+|hbo|max|tidal|icloud|onedrive|github|patreon)\b/i, weight: 5 },
      { re: /\b(subscription|prenumeration)\b/i, weight: 2 },
    ]},
    { cat: "tax", patterns: [{ re: /\b(skatteverket|skatt|moms|vat)\b/i, weight: 6 }]},
    { cat: "fees", patterns: [{ re: /\b(fee|avgift|charge|bankgiro|plusgiro)\b/i, weight: 4 }]},
    { cat: "refund", patterns: [{ re: /\b(refund|återbetal|chargeback|return)\b/i, weight: 5 }]},
    { cat: "interest", patterns: [{ re: /\b(interest|ränta|ranta)\b/i, weight: 5 }]},
    { cat: "p2p", patterns: [
      { re: /\b(swish|revolut|wise|paypal|venmo|swishbetalning)\b/i, weight: 4 },
      { re: /\b(p2p|friends|splitwise)\b/i, weight: 2 },
    ]},
  ];

  const scores = new Map<string, number>();
  for (const r of rules) {
    let s = 0;
    for (const { re, weight } of r.patterns) if (re.test(text)) s += weight;
    if (s > 0) scores.set(r.cat, (scores.get(r.cat) ?? 0) + s);
  }

  if (scores.size === 0) return { category: "uncategorized" };

  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  return { category: ranked[0][0] };
}
