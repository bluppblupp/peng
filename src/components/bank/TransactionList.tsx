import { useEffect, useState, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, Filter, Search, RefreshCw, Loader2 } from "lucide-react";
import { useCurrency } from "@/contexts/CurrencyContext";
import { useGoCardless, type Transaction } from "@/hooks/useGoCardless";
import { BankConnection } from "@/components/bank/BankConnection";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { categorizeTransaction, getCategoryColor } from "@/utils/categoryUtils";
import { useAuth } from "@/contexts/AuthContext";

const PAGE_SIZE = 20;

export const TransactionList: React.FC = () => {
  const { formatAmount } = useCurrency();
  const { getTransactions, loading: gcLoading, error: gcError } = useGoCardless();
  const { toast } = useToast();
  const { user } = useAuth();

  const [accounts, setAccounts] = useState<{ account_id: string; bank_name?: string }[]>([]);
  const [connectedAccountId, setConnectedAccountId] = useState<string | null>(null);

  // transactions are read from Supabase (better UX), shaped to Transaction view
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);
  const [isLoadingTransactions, setIsLoadingTransactions] = useState(false);

  // pagination
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // UI features
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // local cache of fetched ids to avoid upserting duplicates client-side
  const fetchedIdsRef = useRef<Set<string>>(new Set());

  // Realtime subscription ref
  const subscriptionRef = useRef<any>(null);

  const loadAccounts = useCallback(async () => {
    setIsLoadingAccounts(true);
    try {
      if (!user) {
        setAccounts([]);
        return;
      }

      const { data, error } = await supabase
        .from("connected_banks")
        .select("account_id, bank_name")
        .eq("user_id", user.id)
        .eq("is_active", true);

      if (error) {
        console.error("Error loading accounts:", error);
        toast({
          title: "Failed to load accounts",
          description: error.message || "Could not fetch connected banks",
          variant: "destructive",
        });
        return;
      }

      if (data) {
        setAccounts(data);
        if (!connectedAccountId && data.length > 0) {
          setConnectedAccountId(data[0].account_id);
        }
      }
    } finally {
      setIsLoadingAccounts(false);
    }
  }, [user, connectedAccountId, toast]);

  // Load initial accounts
  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  // Supabase-first fetch for a given page
  const fetchFromSupabase = useCallback(
    async (pageNum = 0, replace = pageNum === 0) => {
      if (!connectedAccountId) return;
      setIsLoadingTransactions(true);
      try {
        const from = pageNum * PAGE_SIZE;
        const to = (pageNum + 1) * PAGE_SIZE - 1;

        const { data, error } = await supabase
          .from("transactions")
          .select("*")
          .eq("bank_account_id", connectedAccountId)
          .order("date", { ascending: false })
          .range(from, to);

        if (error) throw error;

        const mapped: Transaction[] = (data || []).map((r: any) => ({
          id: r.transaction_id,
          amount: r.amount,
          currency: "SEK", // if you persist currency add it to DB and map here
          date: r.date,
          description: r.description,
          category: r.category,
          type: r.amount >= 0 ? "credit" : "debit",
          account: r.bank_account_id,
        }));

        // update fetchedIds cache
        fetchedIdsRef.current = new Set([
          ...Array.from(fetchedIdsRef.current),
          ...mapped.map((t) => t.id),
        ]);

        setTransactions((prev) => (replace ? mapped : [...prev, ...mapped]));
        setHasMore((data || []).length === PAGE_SIZE);
        setPage(pageNum);
      } catch (err: any) {
        console.error("Error fetching from Supabase:", err);
        toast({
          title: "Failed to load transactions",
          description: err.message || "Error loading transactions from DB",
          variant: "destructive",
        });
      } finally {
        setIsLoadingTransactions(false);
      }
    },
    [connectedAccountId, toast]
  );

  // Refresh from GoCardless -> upsert -> reload first page
  const refreshFromGoCardless = useCallback(async () => {
    if (!connectedAccountId || !user) return;
    setIsLoadingTransactions(true);
    try {
      const dateTo = new Date().toISOString().split("T")[0];
      const dateFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const remoteTxs = await getTransactions(connectedAccountId, dateFrom, dateTo);

      // filter out already-known (by transaction id)
      const newTxs = remoteTxs.filter((tx) => !fetchedIdsRef.current.has(tx.id));
      if (newTxs.length === 0) {
        toast({ title: "No new transactions", description: "No new transactions to sync" });
        setLastUpdated(new Date().toLocaleTimeString());
        return;
      }

      // Prepare DB rows and upsert
      const toInsert = newTxs.map((tx) => ({
        user_id: user.id,
        bank_account_id: connectedAccountId,
        transaction_id: tx.id,
        description: tx.description,
        amount: tx.amount,
        category: tx.category || categorizeTransaction(tx.description),
        date: tx.date,
      }));

      const { error } = await supabase
        .from("transactions")
        .upsert(toInsert, { onConflict: "user_id,bank_account_id,transaction_id" })

      if (error) throw error;

      // update local state (prepend newest)
      setTransactions((prev) => {
        // sort newTxs by date desc and prepend
        const ordered = newTxs.sort((a, b) => b.date.localeCompare(a.date));
        // avoid duplicates just in case
        const ids = new Set(prev.map((p) => p.id));
        const filtered = ordered.filter((t) => !ids.has(t.id));
        return [...filtered, ...prev];
      });

      // update fetched ids
      newTxs.forEach((t) => fetchedIdsRef.current.add(t.id));

      setLastUpdated(new Date().toLocaleTimeString());
      toast({
        title: "Transactions synced",
        description: `Saved ${newTxs.length} new transactions`,
      });

      // Reset to page 0 so the user sees newest
      await fetchFromSupabase(0, true);
    } catch (err: any) {
      console.error("Error syncing from GoCardless:", err);
      toast({
        title: "Sync failed",
        description: err.message || "Could not fetch transactions from bank",
        variant: "destructive",
      });
    } finally {
      setIsLoadingTransactions(false);
    }
  }, [connectedAccountId, fetchFromSupabase, getTransactions, toast, user]);

  // When selected account changes -> load first page from DB
  useEffect(() => {
    if (!connectedAccountId) return;
    fetchedIdsRef.current = new Set(); // reset cached ids
    fetchFromSupabase(0, true);
  }, [connectedAccountId, fetchFromSupabase]);

  // Auto-refresh (if enabled)
  useEffect(() => {
    if (!autoRefresh || !connectedAccountId) return;
    const id = setInterval(() => {
      void refreshFromGoCardless();
    }, 120000); // 2 minutes
    return () => clearInterval(id);
  }, [autoRefresh, connectedAccountId, refreshFromGoCardless]);

  // Realtime subscription for new transactions inserted into DB for current account
  useEffect(() => {
    if (!connectedAccountId) return;

    // remove previous channel
    if (subscriptionRef.current) {
      supabase.removeChannel(subscriptionRef.current);
      subscriptionRef.current = null;
    }

    const channel = supabase
      .channel(`transactions:${connectedAccountId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "transactions",
          filter: `bank_account_id=eq.${connectedAccountId}`,
        },
        (payload) => {
          const newRow = payload.new as any;
          const tx: Transaction = {
            id: newRow.transaction_id,
            amount: newRow.amount,
            currency: "SEK",
            date: newRow.date,
            description: newRow.description,
            category: newRow.category,
            type: newRow.amount >= 0 ? "credit" : "debit",
            account: newRow.bank_account_id,
          };

          // prepend to list if it's not already present
          setTransactions((prev) => {
            if (prev.find((p) => p.id === tx.id)) return prev;
            fetchedIdsRef.current.add(tx.id);
            return [tx, ...prev];
          });
        }
      )
      .subscribe();

    subscriptionRef.current = channel;
    return () => {
      if (subscriptionRef.current) supabase.removeChannel(subscriptionRef.current);
      subscriptionRef.current = null;
    };
  }, [connectedAccountId]);

  // Load accounts on mount only (and when user changes)
  useEffect(() => {
    if (!user) return;
    void loadAccounts();
  }, [user, loadAccounts]);

  // Called when BankConnection reports a new account
  const handleAccountConnected = async (accountId: string) => {
    // re-fetch accounts list (so the selector shows the new account)
    await loadAccounts();
    setConnectedAccountId(accountId);
    // fetch and sync immediately
    await refreshFromGoCardless();
  };

  // Manual "Load More" pagination
  const loadMore = async () => {
    if (!connectedAccountId) return;
    await fetchFromSupabase(page + 1, false);
  };

  // Search / filter local
  const filteredTransactions = transactions.filter((t) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      t.description.toLowerCase().includes(s) ||
      (t.category || "").toLowerCase().includes(s) ||
      (t.merchant || "").toLowerCase().includes(s)
    );
  });

  return (
    <div className="space-y-6">
      <BankConnection onAccountConnected={handleAccountConnected} />

      {isLoadingAccounts ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          <span>Loading your bank accounts...</span>
        </div>
      ) : (
        accounts.length > 0 && (
          <div className="flex items-center gap-3">
            <label htmlFor="account" className="text-sm font-medium">Account:</label>
            <select
              id="account"
              className="border rounded-md p-2 bg-background"
              value={connectedAccountId || ""}
              onChange={(e) => setConnectedAccountId(e.target.value)}
            >
              {accounts.map((acc) => (
                <option key={acc.account_id} value={acc.account_id}>
                  {acc.bank_name || acc.account_id}
                </option>
              ))}
            </select>

            <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
              <span>Auto refresh</span>
              <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
              {lastUpdated && <span className="ml-4">Last updated: {lastUpdated}</span>}
            </div>
          </div>
        )
      )}

      {connectedAccountId ? (
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>Recent Transactions</CardTitle>
              <div className="flex space-x-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search transactions..."
                    className="pl-10 w-64"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>

                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void refreshFromGoCardless()}
                  disabled={isLoadingTransactions || gcLoading}
                >
                  {(isLoadingTransactions || gcLoading) ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>

                <Button variant="outline" size="icon">
                  <Filter className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {isLoadingTransactions ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                <span>Loading transactions...</span>
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  {filteredTransactions.map((transaction) => (
                    <div
                      key={transaction.id}
                      className="flex items-center justify-between p-4 rounded-lg border bg-card/50 hover:bg-card/80 transition-colors"
                    >
                      <div className="flex items-center space-x-3">
                        <div className={`w-3 h-3 rounded-full ${getCategoryColor(transaction.category || '')}`} />
                        <div>
                          <p className="font-medium">{transaction.description}</p>
                          <p className="text-sm text-muted-foreground">
                            {new Date(transaction.date).toLocaleDateString()} • {transaction.account || 'Bank Account'}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center space-x-3">
                        <Badge variant="secondary" className="text-xs">
                          {transaction.category || categorizeTransaction(transaction.description)}
                        </Badge>
                        <span className={`font-semibold ${transaction.amount > 0 ? 'text-income' : 'text-expense'}`}>
                          {transaction.amount > 0 ? '+' : ''}{formatAmount(transaction.amount)}
                        </span>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                {hasMore && (
                  <div className="mt-6 text-center">
                    <Button variant="outline" onClick={loadMore} disabled={isLoadingTransactions}>
                      {isLoadingTransactions ? "Loading..." : "Load more"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>No Transactions Yet</CardTitle>
            <p className="text-sm text-muted-foreground">
              Connect your bank account above to see your real transactions
            </p>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8 text-muted-foreground">
              <p>Your transactions will appear here once you connect a bank account.</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
