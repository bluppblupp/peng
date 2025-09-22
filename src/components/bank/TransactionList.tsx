import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrency } from "@/contexts/CurrencyContext";

type TxRow = {
  id: string;
  date: string;                      // ISO-ish string from PostgREST
  description: string | null;
  amount: number | string;           // numeric columns can arrive as string
  category: string;
  bank_account_id: string;
  merchant_name: string | null;
  bank_accounts: { name: string | null } | null; // embedded relation
};

type UiTx = {
  id: string;
  date: string;                      // ISO (safe for Date)
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
  const [hasAnyBank, setHasAnyBank] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // If user not ready, show empty state without throwing type errors
    if (!user) {
      setTransactions([]);
      setHasAnyBank(false);
      setLoading(false);
      return;
    }

    setLoading(true);

    // 1) Do we have at least one connected bank? (for empty-state message)
    const { data: banks } = await supabase
      .from("connected_banks")
      .select("id")
      .eq("user_id", user.id)
      .limit(1);

    setHasAnyBank((banks?.length ?? 0) > 0);

    // 2) Fetch transactions and embed the account name — no accMap needed
    const { data: txData, error: txError } = await supabase
      .from("transactions")
      .select(
        "id, date, description, amount, category, bank_account_id, merchant_name, bank_accounts(name)"
      )
      .eq("user_id", user.id)
      .order("date", { ascending: false })
      .returns<TxRow[]>();

    if (txError || !txData) {
      if (txError) console.error("Failed to load transactions", txError);
      setTransactions([]);
      setLoading(false);
      return;
    }

    // 3) Map DB rows → UI rows
    const ui: UiTx[] = txData.map((tx) => {
      const amt =
        typeof tx.amount === "number" ? tx.amount : Number.parseFloat(String(tx.amount ?? 0));

      return {
        id: tx.id,
        date: tx.date ? new Date(tx.date).toISOString() : new Date().toISOString(),
        description: (tx.merchant_name ?? tx.description ?? "").trim() || "Transaction",
        amount: Number.isFinite(amt) ? amt : 0,
        bank_account_id: tx.bank_account_id,
        account_name: tx.bank_accounts?.name ?? null,
        category: (tx.category ?? "").trim() || "Uncategorized",
      };
    });

    setTransactions(ui);
    setLoading(false);
  }, [user]);

  // initial + on auth change
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    load();
  }, [load]);

  // refetch when sync completes (your ConnectedBanksCard should dispatch this)
  useEffect(() => {
    const handler = () => {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      load();
    };
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
                {tx.category && tx.category !== "Uncategorized" && (
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
