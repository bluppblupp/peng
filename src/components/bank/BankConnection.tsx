// src/components/bank/BankConnection.tsx
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type Institution = { id: string; name: string };

const COUNTRIES: Array<{ code: string; label: string }> = [
  { code: "SE", label: "Sweden" },
  { code: "NO", label: "Norway" },
  { code: "DK", label: "Denmark" },
  { code: "FI", label: "Finland" },
  { code: "GB", label: "United Kingdom" },
  { code: "DE", label: "Germany" },
  { code: "NL", label: "Netherlands" },
  { code: "FR", label: "France" },
  { code: "ES", label: "Spain" },
  { code: "IT", label: "Italy" },
  { code: "IE", label: "Ireland" },
  { code: "PL", label: "Poland" },
];

type Props = {
  /** compact = tight inline layout (no card/borders) */
  mode?: "full" | "compact";
};

type FunctionErrorJson = {
  error?: string;
  code?: string;
  correlationId?: string;
  details?: Record<string, unknown>;
};

function isResponse(x: unknown): x is Response {
  return typeof Response !== "undefined" && x instanceof Response;
}

/** Parse Supabase FunctionsHttpError to our server's JSON payload */
async function parseFunctionError(err: unknown): Promise<FunctionErrorJson | null> {
  const maybe = err as { context?: unknown } | null;
  if (maybe?.context && isResponse(maybe.context)) {
    try {
      const json = (await maybe.context.clone().json()) as unknown;
      if (json && typeof json === "object") return json as FunctionErrorJson;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function BankConnection({ mode = "compact" }: Props) {
  const { toast } = useToast();
  const [country, setCountry] = useState<string>("SE");
  const [banks, setBanks] = useState<Institution[]>([]);
  const [loadingBanks, setLoadingBanks] = useState(false);
  const [selectedBank, setSelectedBank] = useState<string>("");
  const [connectLoading, setConnectLoading] = useState(false);

  // load banks for country
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingBanks(true);
      setBanks([]);
      setSelectedBank("");

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Please sign in and try again.");

        const res = await supabase.functions.invoke<Institution[]>("gc_institutions", {
          body: { country },
        });

        if (res.error) throw res.error;

        const list = Array.isArray(res.data) ? res.data : [];
        if (!cancelled) {
          setBanks(list);
          setSelectedBank(list[0]?.id ?? "");
        }
      } catch (e: unknown) {
        console.error("load banks failed", e);
        if (!cancelled) {
          toast({
            title: "Could not load banks",
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoadingBanks(false);
      }
    })();
    return () => { cancelled = true; };
  }, [country, toast]);

  const containerCls = useMemo(
    () =>
      mode === "compact"
        ? "flex flex-wrap items-end gap-3"
        : "grid grid-cols-1 sm:grid-cols-[minmax(0,180px)_minmax(0,280px)_auto] gap-3 items-end",
    [mode]
  );

  const labelCls = "block text-xs font-medium text-muted-foreground mb-1 text-left";
  const countryWidth = "w-full sm:w-[160px]";
  const bankWidth = "w-full sm:w-[280px]";

  async function handleConnect() {
    if (!selectedBank) {
      toast({ title: "Pick a bank", description: "Choose a bank to continue." });
      return;
    }
    setConnectLoading(true);
    try {
      const redirectUrl = `${location.origin}/banks/callback`; // must be whitelisted in GoCardless/Nordigen
      const bank = banks.find((b) => b.id === selectedBank);
      const res = await supabase.functions.invoke<{ link?: string }>("gc_create_requisition", {
        body: { institution_id: selectedBank, redirect_url: redirectUrl, bank_name: bank?.name ?? "Bank", country, },
      });
      if (res.error) throw res.error;
      if (!res.data?.link) throw new Error("Did not receive GoCardless link.");
      window.location.href = res.data.link;
    } catch (e: unknown) {
      const parsed = await parseFunctionError(e);
      const code = parsed?.code ?? "";
      const cid = parsed?.correlationId ? ` · ${parsed.correlationId}` : "";

      if (code === "UPSTREAM_INSTITUTION_DOWN") {
        const summary = (parsed?.details?.summary as string | undefined) ?? "This bank is temporarily unavailable.";
        toast({
          title: "Bank unavailable",
          description: `${summary} Please try again later or choose another bank.`,
          variant: "destructive",
        });
      } else if (code === "DB_UPSERT_FAILED") {
        toast({
          title: "Database error",
          description: `Could not save connection on the server${cid}. Check the unique index & RLS on 'connected_banks'.`,
          variant: "destructive",
        });
      } else if (code === "CONFIG_MISSING") {
        toast({
          title: "Server misconfigured",
          description: `Missing env vars on the function${cid}.`,
          variant: "destructive",
        });
      } else if (code) {
        toast({
          title: "Unable to start connection",
          description: `${parsed?.error ?? "Function failed"} (${code}${cid})`,
          variant: "destructive",
        });
      } else {
        console.error("Create requisition failed:", e);
        toast({
          title: "Unable to start connection",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
      }
    } finally {
      setConnectLoading(false);
    }
  }

  return (
    <div className={containerCls}>
      <div className={countryWidth}>
        <label className={labelCls}>Country</label>
        <select
          className="w-full border rounded px-2 py-2 text-sm"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        >
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className={bankWidth}>
        <label className={labelCls}>Bank</label>
        <select
          className="w-full border rounded px-2 py-2 text-sm"
          value={selectedBank}
          onChange={(e) => setSelectedBank(e.target.value)}
          disabled={loadingBanks || banks.length === 0}
        >
          {loadingBanks && <option>Loading banks…</option>}
          {!loadingBanks && banks.length === 0 && <option>No banks found</option>}
          {banks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex">
        <Button onClick={handleConnect} disabled={connectLoading || !selectedBank} size="sm" className="px-3">
          {connectLoading ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Plus className="h-4 w-4 mr-2" />
          )}
          {connectLoading ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </div>
  );
}
