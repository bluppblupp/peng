import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrency } from "@/contexts/CurrencyContext";

interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  category: string | null;
  bank_account_id: string;
  account_name: string | null;
}

export function TransactionList() {
  const { user } = useAuth();
  const { formatAmount } = useCurrency();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    (async () => {
      setLoading(true);
      const { data: txData, error: txError } = await supabase
        .from("transactions")
        .select("id, date, description, amount, category, bank_account_id")
        .eq("user_id", user.id)
        .order("date", { ascending: false });

      if (txError || !txData) {
        if (txError) console.error("Failed to load transactions", txError);
        setTransactions([]);
      } else {
        const accountIds = Array.from(
          new Set(txData.map((tx) => tx.bank_account_id))
        );
        const { data: accounts } = await supabase
          .from("bank_accounts")
          .select("id, name")
          .in("id", accountIds);
        const accountMap = new Map(
          (accounts ?? []).map((acc) => [acc.id, acc.name])
        );

        setTransactions(
          txData.map((tx) => ({
            ...tx,
            account_name: accountMap.get(tx.bank_account_id) ?? null,
          }))
        );
      }
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
                {tx.category && (
                  <Badge variant="secondary" className="text-xs">
                    {tx.category}
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
