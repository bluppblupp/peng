// src/components/banks/ConnectedBanksCard.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { BankConnection } from "@/components/bank/BankConnection";
import { useToast } from "@/hooks/use-toast";

/** ---- Types ---- */
type BankRow = {
  id: string;
  bank_name: string | null;
  provider: string | null;
  status: string | null;
};

type AccountRow = {
  id: string;
  connected_bank_id: string;
  name: string | null;
  currency: string | null;
  is_selected: boolean | null;
  last_sync_at: string | null;
  next_allowed_sync_at: string | null;
  last_sync_status: string | null;
};

type InvokeOk =
  | { ok: true; noop: true; reason: "fresh" | "cooldown"; last_sync_at?: string; next_allowed_sync_at?: string; wait_seconds?: number }
  | { ok: true; noop: false; bank_account_id: string; fetched: number; upserted: number; next_allowed_sync_at?: string };

type InvokeErr = {
  error?: string;
  code?: string;
  correlationId?: string;
  details?: Record<string, unknown>;
};

type FunctionError = { message: string; context?: Response };

/** LocalStorage handoff key from BankCallbackPage */
const PENDING_KEY = "peng:pendingSync";

/** Fire a cross-page event so TransactionList (and charts) can refetch */
function dispatchTxUpdated(accountIds: string[]) {
  try {
    window.dispatchEvent(new CustomEvent("peng:tx:updated", { detail: { at: Date.now(), accountIds } }));
  } catch {
    /* noop */
  }
}

function isResponse(x: unknown): x is Response {
  return typeof Response !== "undefined" && x instanceof Response;
}

async function parseFunctionError(err: FunctionError): Promise<InvokeErr | null> {
  if (err.context && isResponse(err.context)) {
    try {
      const json = (await err.context.clone().json()) as unknown;
      if (json && typeof json === "object") return json as InvokeErr;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function fmtAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtWait(iso: string | null): string | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const sec = Math.ceil(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.ceil(min / 60);
  return `${h}h`;
}

export function ConnectedBanksCard() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [banks, setBanks] = useState<BankRow[]>([]);
  const [accountsByBank, setAccountsByBank] = useState<Map<string, AccountRow[]>>(new Map());
  const [showConnect, setShowConnect] = useState(false);

  // sync state (global progress bar)
  const [syncing, setSyncing] = useState(false);
  const [syncDone, setSyncDone] = useState(0);
  const [syncTotal, setSyncTotal] = useState(0);

  const hasBanks = useMemo(() => banks.length > 0, [banks]);

  // Load banks + accounts
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) {
        setBanks([]);
        setAccountsByBank(new Map());
        setLoading(false);
        return;
      }
      setLoading(true);

      const { data: bankRows, error: bankErr } = await supabase
        .from("connected_banks")
        .select("id, bank_name, provider, status")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (bankErr || !bankRows) {
        if (bankErr) console.error("load banks failed", bankErr);
        if (!cancelled) {
          setBanks([]);
          setAccountsByBank(new Map());
          setLoading(false);
        }
        return;
      }

      const bankIds = bankRows.map((b) => b.id);
      const accMap = new Map<string, AccountRow[]>();

      if (bankIds.length > 0) {
        const { data: accRows, error: accErr } = await supabase
          .from("bank_accounts")
          .select("id, connected_bank_id, name, currency, is_selected, last_sync_at, next_allowed_sync_at, last_sync_status")
          .in("connected_bank_id", bankIds)
          .returns<AccountRow[]>();

        if (accErr) {
          console.error("load accounts failed", accErr);
        } else {
          for (const row of accRows ?? []) {
            const arr = accMap.get(row.connected_bank_id) ?? [];
            arr.push(row);
            accMap.set(row.connected_bank_id, arr);
          }
        }
      }

      if (!cancelled) {
        setBanks(bankRows);
        setAccountsByBank(accMap);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  // Auto-sync if BankCallbackPage dropped accountIds into localStorage
  useEffect(() => {
    if (!user) return;
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { accountIds?: string[] };
      const accountIds = Array.isArray(parsed?.accountIds)
        ? parsed.accountIds.filter((x): x is string => typeof x === "string")
        : [];
      if (accountIds.length) {
        localStorage.removeItem(PENDING_KEY);
        (async () => {
          toast({ title: "Syncing", description: "Fetching your latest transactions…" });
          await syncAccountsSequential(accountIds);
          toast({ title: "Sync complete", description: "Your transactions are up to date." });
        })();
      }
    } catch {
      localStorage.removeItem(PENDING_KEY);
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Call gc_sync for a single account id; throws on error */
  async function invokeSync(bankAccountId: string): Promise<InvokeOk> {
    const res = await supabase.functions.invoke<InvokeOk>("gc_sync", { body: { bank_account_id: bankAccountId } });
    if (res.error) {
      // Surface real edge payload
      const parsed = await parseFunctionError(res.error as unknown as FunctionError);
      const code = parsed?.code ? ` (${parsed.code}${parsed?.correlationId ? ` · ${parsed.correlationId}` : ""})` : "";
      const msg = parsed?.error || res.error.message || "Edge function failed";
      throw new Error(msg + code);
    }
    return res.data as InvokeOk;
  }

  /** Run gc_sync sequentially with simple progress */
  async function syncAccountsSequential(accountIds: string[]) {
    if (!user || accountIds.length === 0) return;

    setSyncing(true);
    setSyncDone(0);
    setSyncTotal(accountIds.length);

    for (const id of accountIds) {
      try {
        const out = await invokeSync(id);
        if ("noop" in out && out.noop === true) {
          // Fresh or cooldown; just continue
        }
      } catch (e) {
        console.error("[sync] failed", id, e);
        toast({ title: "Sync failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      } finally {
        setSyncDone((d) => d + 1);
        // brief gap to keep UI readable
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 120));
      }
    }

    setSyncing(false);
    dispatchTxUpdated(accountIds);

    // Refresh lists (banks + accounts)
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      if (!user) return;
      const { data: bankRows } = await supabase
        .from("connected_banks")
        .select("id, bank_name, provider, status")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (bankRows) {
        const bankIds = bankRows.map((b) => b.id);
        const { data: accRows } = await supabase
          .from("bank_accounts")
          .select("id, connected_bank_id, name, currency, is_selected, last_sync_at, next_allowed_sync_at, last_sync_status")
          .in("connected_bank_id", bankIds)
          .returns<AccountRow[]>();
        const accMap = new Map<string, AccountRow[]>();
        for (const row of accRows ?? []) {
          const arr = accMap.get(row.connected_bank_id) ?? [];
          arr.push(row);
          accMap.set(row.connected_bank_id, arr);
        }
        setBanks(bankRows);
        setAccountsByBank(accMap);
      }
    })();
  }

  async function syncAllNow() {
    const all = Array.from(accountsByBank.values()).flat().map((a) => a.id);
    if (all.length === 0) {
      toast({ title: "Nothing to sync", description: "No accounts found." });
      return;
    }
    toast({ title: "Syncing", description: "This may take a moment…" });
    await syncAccountsSequential(all);
    toast({ title: "Sync complete", description: "Your transactions are up to date." });
  }

  async function syncBankNow(bankId: string) {
    const ids = (accountsByBank.get(bankId) ?? []).map((a) => a.id);
    if (ids.length === 0) {
      toast({ title: "Nothing to sync", description: "No accounts found." });
      return;
    }
    toast({ title: "Syncing", description: "Fetching latest transactions…" });
    await syncAccountsSequential(ids);
    toast({ title: "Sync complete", description: "Updated accounts for this bank." });
  }

  return (
    <Card>
      {/* Header: only show big title when there are banks */}
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          {hasBanks ? (
            <>
              <CardTitle className="text-base">Connected banks</CardTitle>
              <div className="flex items-center gap-2">
                {syncing ? (
                  <div className="flex items-center text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    Syncing {syncDone}/{syncTotal}
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" onClick={syncAllNow}>
                    <RefreshCw className="h-4 w-4 mr-1" />
                    Sync all
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => setShowConnect((v) => !v)}>
                  <Plus className="h-4 w-4 mr-1" />
                  {showConnect ? "Cancel" : "Add bank"}
                </Button>
              </div>
            </>
          ) : (
            <CardTitle className="text-base">Get started</CardTitle>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : !hasBanks ? (
          // First-time connect box
          <div className="rounded-lg p-4 bg-muted/40">
            <div className="mb-3">
              <div className="font-medium text-sm">Connect a bank to get started</div>
              <div className="text-xs text-muted-foreground">
                Connect securely and we’ll pull your accounts and transactions.
              </div>
            </div>
            <div className="max-w-[520px]">
              <BankConnection />
            </div>
          </div>
        ) : (
          <>
            {/* List banks */}
            <div className="space-y-2">
              {banks.map((b) => {
                const accs = accountsByBank.get(b.id) ?? [];
                return (
                  <div key={b.id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-sm">
                        {b.bank_name || "Bank"}{" "}
                        <span className="text-muted-foreground">({b.provider || "gocardless"})</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={b.status === "active" ? "default" : "secondary"}
                          className="text-[10px] h-5"
                        >
                          {b.status || "unknown"}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => void syncBankNow(b.id)}
                          disabled={syncing}
                        >
                          <RefreshCw className="h-3.5 w-3.5 mr-1" />
                          Sync
                        </Button>
                      </div>
                    </div>

                    {accs.length > 0 && (
                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {accs.map((a) => {
                          const ago = fmtAgo(a.last_sync_at);
                          const wait = fmtWait(a.next_allowed_sync_at);
                          return (
                            <div
                              key={a.id}
                              className="flex items-center justify-between text-[12px] px-2 py-1 rounded bg-muted/40"
                            >
                              <div className="min-w-0">
                                <span className="truncate">{a.name || "Account"}</span>
                                <span className="text-muted-foreground">
                                  {" "}
                                  {a.currency ? `· ${a.currency}` : ""}
                                </span>
                              </div>
                              <div className="text-muted-foreground">
                                {wait ? (
                                  <span title={a.next_allowed_sync_at || ""}>cooldown {wait}</span>
                                ) : ago ? (
                                  <span title={a.last_sync_at || ""}>synced {ago}</span>
                                ) : (
                                  <span>—</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {showConnect && (
              <div className="rounded-lg p-3 bg-muted/40">
                <div className="mb-2 font-medium text-sm">Add another bank</div>
                <div className="max-w-[520px]">
                  <BankConnection />
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
