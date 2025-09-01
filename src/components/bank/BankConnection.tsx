// src/components/BankConnection.tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Loader2, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface Institution {
  id: string;
  name: string;
}

const COUNTRIES = [
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

// --- Hook using supabase.functions.invoke (POST { country }) ---
const useBanks = (country: string) => {
  const [banks, setBanks] = useState<Institution[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;

    const loadBanks = async () => {
      if (!country) return;

      setLoading(true);
      setBanks([]);
      setError(null);

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) {
          throw new Error("Authentication failed. Please log in again.");
        }

        const { data, error } = await supabase.functions.invoke<Institution[]>(
          "gc_institutions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { country },
          }
        );

        if (error) {
          throw new Error(error.message || "Server error");
        }
        if (!Array.isArray(data)) {
          throw new Error("Invalid response from server");
        }

        if (!cancelled) setBanks(data);
      } catch (e: unknown) {
        const msg =
          e instanceof Error ? e.message : typeof e === "string" ? e : "An unknown error occurred.";
        if (!cancelled) setError(msg);
        console.error("Could not load banks:", e);
        toast({
          title: "Could not load banks",
          description: msg,
          variant: "destructive",
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadBanks();
    return () => {
      cancelled = true;
    };
  }, [country, toast]);

  return { banks, loading, error };
};

/** Type guard to read Response from Supabase function errors */
function isResponseLike(x: unknown): x is Response {
  return typeof Response !== "undefined" && x instanceof Response;
}

export function BankConnection() {
  const { toast } = useToast();
  const [country, setCountry] = useState<string>("SE");
  const { banks, loading: banksLoading, error: banksError } = useBanks(country);
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);

  useEffect(() => {
    if (banks.length > 0) {
      setSelectedBank(banks[0].id);
    } else {
      setSelectedBank(null);
    }
  }, [banks]);

  const handleConnect = async () => {
    if (!selectedBank) {
      toast({ title: "Pick a bank", description: "Choose a bank to continue." });
      return;
    }
    setConnectLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Authentication failed. Please log in again.");

      const redirectUrl = `${location.origin}/banks/callback`;
      const bank = banks.find((b) => b.id === selectedBank);

      const { data, error } = await supabase.functions.invoke("gc_create_requisition", {
        // Let SDK post JSON and attach JWT+apikey
        body: {
          institution_id: selectedBank,
          redirect_url: redirectUrl,
          bank_name: bank?.name || "Bank",
        },
      });

      if (error) {
        // Try to extract the function's JSON to show {code, correlationId, details}
        const ctx = (error as { context?: unknown }).context;
        if (ctx && isResponseLike(ctx)) {
          try {
            const json = await ctx.clone().json();
            console.error("gc_create_requisition failed", { message: error.message, json });
            const code = typeof json?.code === "string" ? json.code : "";
            const cid = typeof json?.correlationId === "string" ? json.correlationId : "";
            const upstream = json?.details?.bodySnippet ? ` · ${json.details.bodySnippet}` : "";
            throw new Error(`${code || error.message}${cid ? ` (${cid})` : ""}${upstream}`);
          } catch {
            // fall back to generic message
          }
        }
        throw new Error(error.message);
      }

      if (!data?.link) throw new Error("Did not receive GoCardless link");
      window.location.href = data.link;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Please try again.";
      console.error("Create requisition failed:", e);
      toast({
        title: "Unable to start connection",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setConnectLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a bank</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm">Country</label>
          <select
            className="border rounded p-2"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>

          <label className="text-sm">Bank</label>
          <select
            className="border rounded p-2 min-w-[220px]"
            value={selectedBank ?? ""}
            onChange={(e) => setSelectedBank(e.target.value)}
            disabled={banks.length === 0 || banksLoading}
          >
            {banksLoading && <option>Loading banks...</option>}
            {!banksLoading && banks.length === 0 && (
              <option>{banksError ? "Error loading banks" : "No banks found"}</option>
            )}
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>

          <Button onClick={handleConnect} disabled={connectLoading || !selectedBank}>
            {connectLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            {connectLoading ? "Connecting..." : "Connect"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
