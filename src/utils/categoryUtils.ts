// Utility functions for transaction categorization (SE + Nordics friendly)
// No anys; purely deterministic string rules; easy to extend.

export type Category =
  | "Income"
  | "Transfers"
  | "Fees & Charges"
  | "Groceries"
  | "Restaurants & Cafes"
  | "Transportation"
  | "Travel"
  | "Entertainment & Media"
  | "Shopping & Retail"
  | "Utilities & Telecom"
  | "Healthcare & Pharmacy"
  | "Housing & Rent"
  | "Education"
  | "Insurance"
  | "Other";

export type CategorizeOptions = {
  /** Amount in account currency (positive = inbound, negative = outbound). */
  amount?: number | null;
  /** Optional ISO currency (e.g., "SEK"). Not used in rules yet but left for future. */
  currency?: string | null;
  /** Optional Merchant Category Code if you have one (ISO 18245). */
  mcc?: string | number | null;
  /** Additional fields you might want to include in matching (counterpart name, note, etc.). */
  counterpartName?: string | null;
};

const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " "); // drop punctuation/symbols

function hasAny(haystack: string, needles: readonly string[]): boolean {
  // word-ish contains; we accept contains because bank memos vary a lot
  return needles.some((n) => haystack.includes(n));
}

/** Optional MCC → category hints (very partial; extend as you wish). */
const mccToCategory: Record<string, Category> = {
  // Groceries / supermarkets
  "5411": "Groceries",
  "5499": "Groceries",
  // Restaurants
  "5812": "Restaurants & Cafes",
  "5814": "Restaurants & Cafes",
  // Entertainment
  "7832": "Entertainment & Media", // cinemas
  // Fuel
  "5541": "Transportation",
  "5542": "Transportation",
  // Clothing / retail
  "5651": "Shopping & Retail",
  "5691": "Shopping & Retail",
  // Utilities/telecom
  "4812": "Utilities & Telecom",
  "4899": "Utilities & Telecom",
  // Healthcare
  "5912": "Healthcare & Pharmacy",
  // Hotels / travel
  "7011": "Travel",
  "4112": "Transportation", // Passenger railways
};

type Rule = {
  category: Category;
  /** Keywords to match (pre-normalized lowercase). */
  keywords: readonly string[];
  /** Optional gate to skip a rule (e.g., outbound only). */
  guard?: (ctx: { isIncome: boolean }) => boolean;
};

/** Language- / region-aware keyword sets. Expand any time. */
const RULES: readonly Rule[] = [
  // --- Transfers / P2P / Internal moves ---
  {
    category: "Transfers",
    keywords: [
      "swish", "sepa", "bankgiro", "plusgiro", "autogiro", "överföring", "overforing",
      "transfer", "p2p", "paypal", "revolut", "wise",
    ],
  },

  // --- Fees ---
  {
    category: "Fees & Charges",
    keywords: ["avgift", "fee", "charge", "courtage", "overtrasseringsavgift", "återbetalningsavgift"],
  },

  // --- Clear income indicators (inbound only) ---
  {
    category: "Income",
    keywords: ["lön", "lon", "salary", "payroll", "utbetalning", "ersättning", "skatteverket", "tax refund", "csn"],
    guard: ({ isIncome }) => isIncome,
  },

  // --- Groceries / supermarkets (SE + Nordics + intl) ---
  {
    category: "Groceries",
    keywords: [
      "ica", "coop", "willys", "hemköp", "hemkop", "lidl", "city gross", "mathem",
      "foodora market", "tesco", "sainsbury", "asda", "morrisons", "supermarket", "grocery",
    ],
  },

  // --- Restaurants & Cafes ---
  {
    category: "Restaurants & Cafes",
    keywords: [
      "restaurant", "restaurang", "krog", "cafe", "kafé", "kafe", "bar", "pub",
      "mcdonald", "burger", "kfc", "subway", "pizza", "sushi", "espresso house", "starbucks", "wolt", "foodora",
    ],
  },

  // --- Transport (local + travel-ish operators) ---
  {
    category: "Transportation",
    keywords: [
      "sl", "västtrafik", "vasttrafik", "skånetrafiken", "skanetrafiken", "sj", "oyster", "tfl", "ul", "länstrafik",
      "uber", "bolt", "taxi", "parking", "parkster", "easypark",
      "fuel", "petrol", "diesel", "circle k", "preem", "okq8", "st1", "shell", "esso", "bp",
    ],
  },

  // --- Travel (air / hotels / agencies) ---
  {
    category: "Travel",
    keywords: ["sas", "norwegian", "ryanair", "wizz", "booking.com", "airbnb", "hotel", "hotell", "flyg", "sj prio"],
  },

  // --- Entertainment & Media ---
  {
    category: "Entertainment & Media",
    keywords: [
      "netflix", "spotify", "viaplay", "c more", "disney", "hbo", "max", "cinema", "biograf",
      "steam", "playstation", "xbox", "game pass",
    ],
  },

  // --- Shopping & Retail ---
  {
    category: "Shopping & Retail",
    keywords: [
      "systembolaget",
      "amazon", "ebay", "zalando", "elgiganten", "media markt", "mediamarkt",
      "clas ohlson", "kjell & company", "kjell o company",
      "h&m", "hm", "zara", "lindex", "ginatricot", "uniqlo",
      "apotea", "apotek hjärtat", "apotek hjartat", "kronans apotek",
      "ikea", "jula", "bauhaus", "hornbach", "byggmax",
      "retail", "shop", "butik",
    ],
  },

  // --- Utilities & Telecom ---
  {
    category: "Utilities & Telecom",
    keywords: [
      "vattenfall", "e.on", "eon", "fortum", "göteborg energi", "goteborg energi",
      "tibber", "ellevio", "mimer", "bredband", "fiber", "el",
      "telenor", "telia", "tele2", "tre", "3", "comviq", "hallon", "vimla",
      "internet", "broadband", "electric", "gas", "water",
    ],
  },

  // --- Healthcare & Pharmacy ---
  {
    category: "Healthcare & Pharmacy",
    keywords: ["apotek", "apotea", "apoteket", "hjärtat", "hjartat", "kronans", "pharmacy", "läkare", "lakare", "hospital", "nhs", "dentist"],
  },

  // --- Housing & Rent ---
  {
    category: "Housing & Rent",
    keywords: ["hyra", "rent", "kallhyra", "bostadsbolag", "brf", "månadsavgift", "manadsavgift", "fastighet"],
  },

  // --- Education ---
  {
    category: "Education",
    keywords: ["kth", "chalmers", "lund univ", "uu", "liun", "miun", "folkuniversitet", "udemy", "coursera", "khan academy"],
  },

  // --- Insurance ---
  {
    category: "Insurance",
    keywords: ["folksam", "trygg hansa", "if skadeförsäkring", "if skadeforsakring", "ica försäkring", "ica forsakring", "länsförsäkringar", "lansforsakringar", "moderna"],
  },
] as const;

export function categorizeTransaction(
  description: string,
  opts: CategorizeOptions = {}
): Category {
  const base = normalize(description || "");
  const extra = normalize(
    [opts.counterpartName ?? "", String(opts.mcc ?? ""), String(opts.currency ?? "")]
      .filter(Boolean)
      .join(" ")
  );
  const text = (base + " " + extra).trim();

  const isIncome = typeof opts.amount === "number" ? opts.amount > 0 : false;

  // 1) MCC hint (if present)
  if (opts.mcc != null) {
    const mccStr = String(opts.mcc);
    if (mccToCategory[mccStr]) {
      // If amount positive and MCC is entertainment/shopping, still call it income? No → MCC wins for expenses.
      if (!isIncome || mccToCategory[mccStr] === "Income") return mccToCategory[mccStr];
    }
  }

  // 2) Rule pass (in order)
  for (const rule of RULES) {
    if (rule.guard && !rule.guard({ isIncome })) continue;
    if (hasAny(text, rule.keywords)) return rule.category;
  }

  // 3) Income fallback
  if (isIncome) return "Income";

  return "Other";
}

export function getCategoryColor(category: Category): string {
  const colorMap: Record<Category, string> = {
    Income: "bg-emerald-100 text-emerald-800",
    Transfers: "bg-slate-100 text-slate-800",
    "Fees & Charges": "bg-rose-100 text-rose-800",
    Groceries: "bg-lime-100 text-lime-800",
    "Restaurants & Cafes": "bg-orange-100 text-orange-800",
    Transportation: "bg-yellow-100 text-yellow-800",
    Travel: "bg-pink-100 text-pink-800",
    "Entertainment & Media": "bg-blue-100 text-blue-800",
    "Shopping & Retail": "bg-purple-100 text-purple-800",
    "Utilities & Telecom": "bg-cyan-100 text-cyan-800",
    "Healthcare & Pharmacy": "bg-green-100 text-green-800",
    "Housing & Rent": "bg-stone-100 text-stone-800",
    Education: "bg-indigo-100 text-indigo-800",
    Insurance: "bg-red-100 text-red-800",
    Other: "bg-gray-100 text-gray-800",
  };
  return colorMap[category] ?? colorMap.Other;
}
