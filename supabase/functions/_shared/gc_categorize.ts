// supabase/functions/_shared/gc_categorize.ts

export type CategorizeInput = {
  description?: string;
  counterparty?: string;
  amount?: number;
  currency?: string;
};

export type CategorizeOutput = {
  category: string;
};

/**
 * Deterministic, dependency-free categorizer for server use.
 * Keep it side-effect free (no window/process/etc.).
 */
export function categorize(input: CategorizeInput): CategorizeOutput {
  const desc = (input.description ?? "").toLowerCase();
  const cp = (input.counterparty ?? "").toLowerCase();
  const text = `${desc} ${cp}`.trim();

  // Weighted rules (vendor-first so they beat generic categories on ties)
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
    // Keep P2P last so vendor categories beat it on ties
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
