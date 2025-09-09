import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrency } from "@/contexts/CurrencyContext";

type TxRow = {
  id: string;
  date: string;                 // stored as date in DB; supabase returns ISO-ish string
  description: string | null;
  amount: number;
  category: string;             // NOT NULL in your schema; defaults to "uncategorized"
  bank_account_id: string;
};

type AccountRow = { id: string; name: string | null };

type UiTx = {
  id: string;
  date: string;                 // ISO (safe to pass to Date)
  description: string;
  amount: number;
  bank_account_id: string;
  account_name: string | null;
  category: string;
};

export function TransactionList() {
  const { user } = useAuth();
  const { formatAmount } = useCurrency();

  const [transactions, setTransactions] = useState<UiTx[]>([]);
  const [accountsById, setAccountsById] = useState<Map<string, string | null>>(new Map());
  const [hasAnyBank, setHasAnyBank] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) {
      setTransactions([]);
      setAccountsById(new Map());
      setHasAnyBank(false);
      setLoading(false);
      return;
    }

    setLoading(true);

    // 1) Check if user has any connected banks (controls the empty-state message)
    const { data: banks } = await supabase
      .from("connected_banks")
      .select("id")
      .eq("user_id", user.id)
      .limit(1);

    setHasAnyBank((banks?.length ?? 0) > 0);

    // 2) Fetch transactions (compact selection — no missing columns)
    const txQuery = supabase
      .from("transactions")
      .select("id, date, description, amount, category, bank_account_id")
      .eq("user_id", user.id)
      .order("date", { ascending: false });

    const { data: txData, error: txError } = await txQuery.returns<TxRow[]>();

    if (txError || !txData) {
      if (txError) console.error("Failed to load transactions", txError);
      setTransactions([]);
      setAccountsById(new Map());
      setLoading(false);
      return;
    }

    // 3) Load account names for labels (typed)
    const accountIds = Array.from(new Set(txData.map((tx) => tx.bank_account_id)));
    let accMap = new Map<string, string | null>();
    if (accountIds.length > 0) {
      const accQuery = supabase
        .from("bank_accounts")
        .select("id, name")
        .in("id", accountIds);

      const { data: accounts, error: accErr } = await accQuery.returns<AccountRow[]>();
      if (accErr) console.error("Failed to load accounts", accErr);
      accMap = new Map((accounts ?? []).map((a) => [a.id, a.name]));
    }

    // 4) Map DB rows → UI rows (compact)
    const ui: UiTx[] = txData.map((tx) => ({
      id: tx.id,
      date: tx.date ? new Date(tx.date).toISOString() : new Date().toISOString(),
      description: (tx.description ?? "").trim() || "Transaction",
      amount: typeof tx.amount === "number" ? tx.amount : Number(tx.amount ?? 0),
      bank_account_id: tx.bank_account_id,
      account_name: accMap.get(tx.bank_account_id) ?? null,
      category: (tx.category ?? "").trim() || "uncategorized",
    }));

    setTransactions(ui);
    setAccountsById(accMap);
    setLoading(false);
  }, [user]);

  // initial + on auth change
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    load();
  }, [load]);

  // refetch when sync completes (ConnectedBanksCard dispatches peng:tx:updated)
  useEffect(() => {
    const handler = () => { /* eslint-disable-next-line @typescript-eslint/no-floating-promises */ load(); };
    window.addEventListener("peng:tx:updated", handler as EventListener);
    return () => window.removeEventListener("peng:tx:updated", handler as EventListener);
  }, [load]);

  const content = useMemo(() => {
    if (loading) {
      return (
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading transactions…
        </div>
      );
    }

    if (transactions.length === 0) {
      return (
        <div className="text-sm text-muted-foreground">
          {hasAnyBank
            ? "No transactions found yet. Try syncing your accounts."
            : "Connect a bank to see transactions."}
        </div>
      );
    }

    return (
      <div className="divide-y rounded-md border">
        {transactions.map((tx) => (
          <div key={tx.id} className="flex items-center justify-between px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{tx.description}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>{new Date(tx.date).toLocaleDateString()}</span>
                <span>•</span>
                <span className="truncate">{tx.account_name || "Account"}</span>
                {tx.category && tx.category !== "uncategorized" && (
                  <>
                    <span>•</span>
                    <Badge variant="secondary" className="h-5 text-[10px]">
                      {tx.category}
                    </Badge>
                  </>
                )}
              </div>
            </div>
            <div
              className={`ml-3 shrink-0 text-sm font-semibold ${
                tx.amount > 0 ? "text-emerald-600" : "text-rose-600"
              }`}
            >
              {tx.amount > 0 ? "+" : ""}
              {formatAmount(tx.amount)}
            </div>
          </div>
        ))}
      </div>
    );
  }, [loading, transactions, hasAnyBank, formatAmount]);

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-base">Transactions</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">{content}</CardContent>
    </Card>
  );
}
