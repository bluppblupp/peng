import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrency } from "@/contexts/CurrencyContext";

type TxRow = {
  id: string;
  date: string | null;
  value_date: string | null;
  description: string | null;
  counterpart_name: string | null;
  amount: number;
  currency: string | null;
  status: "booked" | "pending" | null;
  bank_account_id: string;
};

type AccountRow = { id: string; name: string | null };

type UiTx = {
  id: string;
  date: string; // ISO
  description: string;
  amount: number;
  bank_account_id: string;
  account_name: string | null;
  badge: string | null; // status or counterpart
};

export function TransactionList() {
  const { user } = useAuth();
  const { formatAmount } = useCurrency();
  const [transactions, setTransactions] = useState<UiTx[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    (async () => {
      setLoading(true);

      // 1) Fetch transactions with explicit return type
      const txQuery = supabase
        .from("transactions")
        .select(
          [
            "id",
            "date",
            "value_date",
            "description",
            "counterpart_name",
            "amount",
            "currency",
            "status",
            "bank_account_id",
          ].join(",")
        )
        .eq("user_id", user.id)
        .order("date", { ascending: false });

      const { data: txData, error: txError } = await txQuery.returns<TxRow[]>();

      if (txError || !txData) {
        if (txError) console.error("Failed to load transactions", txError);
        setTransactions([]);
        setLoading(false);
        return;
      }

      // 2) Load account names for labels (typed)
      const accountIds = Array.from(new Set(txData.map((tx) => tx.bank_account_id)));
      let accountMap = new Map<string, string | null>();
      if (accountIds.length > 0) {
        const accQuery = supabase
          .from("bank_accounts")
          .select("id, name")
          .in("id", accountIds);

        const { data: accounts, error: accErr } = await accQuery.returns<AccountRow[]>();
        if (accErr) console.error("Failed to load accounts", accErr);
        accountMap = new Map((accounts ?? []).map((a) => [a.id, a.name]));
      }

      // 3) Map DB rows → UI rows
      const ui: UiTx[] = txData.map((tx) => {
        const dateIso =
          (tx.date && new Date(tx.date).toISOString()) ||
          (tx.value_date && new Date(tx.value_date).toISOString()) ||
          new Date().toISOString();

        const desc =
          (tx.description && tx.description.trim()) ||
          (tx.counterpart_name && tx.counterpart_name.trim()) ||
          "Transaction";

        const badge =
          (tx.status && tx.status.toUpperCase()) ||
          tx.counterpart_name ||
          null;

        return {
          id: tx.id,
          date: dateIso,
          description: desc,
          amount: typeof tx.amount === "number" ? tx.amount : Number(tx.amount ?? 0),
          bank_account_id: tx.bank_account_id,
          account_name: accountMap.get(tx.bank_account_id) ?? null,
          badge,
        };
      });

      setTransactions(ui);
      setLoading(false);
    })();
  }, [user]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Transactions</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading transactions…</span>
        </CardContent>
      </Card>
    );
  }

  if (transactions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No transactions found.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transactions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {transactions.map((tx) => (
            <div
              key={tx.id}
              className="flex items-center justify-between p-4 rounded-lg border bg-card"
            >
              <div>
                <p className="font-medium">{tx.description}</p>
                <p className="text-sm text-muted-foreground">
                  {new Date(tx.date).toLocaleDateString()} • {tx.account_name || "Account"}
                </p>
              </div>
              <div className="flex items-center space-x-3">
                {tx.badge && (
                  <Badge variant="secondary" className="text-xs">
                    {tx.badge}
                  </Badge>
                )}
                <span
                  className={`font-semibold ${
                    tx.amount > 0 ? "text-income" : "text-expense"
                  }`}
                >
                  {tx.amount > 0 ? "+" : ""}
                  {formatAmount(tx.amount)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
