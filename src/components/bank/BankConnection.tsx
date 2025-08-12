import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Loader2, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useGoCardless } from "@/hooks/useGoCardless";
import { useAuth } from "@/contexts/AuthContext";

// A small, sensible list. Add/remove based on your target regions.
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

interface Props {
  onAccountConnected: (accountId: string) => void;
}

export const BankConnection: React.FC<Props> = ({ onAccountConnected }) => {
  const { getBanks, createBankConnection, getRequisitionStatus, getAccountDetails } = useGoCardless();
  const { toast } = useToast();
  const { user } = useAuth();

  const [country, setCountry] = useState<string>("SE");
  const [banks, setBanks] = useState<{ id: string; name: string }[]>([]);
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Prevent finalize effect from running twice in React 18 dev (StrictMode)
  const finalizeRanRef = useRef(false);

  // Load available banks for selected country
  useEffect(() => {
    (async () => {
      try {
        const list = await getBanks(country);
        const simplified = (list || []).map((b) => ({ id: b.id, name: b.name }));
        setBanks(simplified);
        setSelectedBank(simplified[0]?.id ?? null);
      } catch (err) {
        console.error("Failed loading banks:", err);
        setBanks([]);
        setSelectedBank(null);
      }
    })();
  }, [getBanks, country]);

  // Finalize on redirect: look for ?requisition_id or ?ref in the URL, then insert into connected_banks
  useEffect(() => {
    (async () => {
      if (!user) return;

      const url = new URL(window.location.href);
      const requisitionId =
        url.searchParams.get("requisition_id") || url.searchParams.get("ref");
      if (!requisitionId) return;

      if (finalizeRanRef.current) return;
      finalizeRanRef.current = true;

      try {
        const status: any = await getRequisitionStatus(requisitionId);

        const institutionId =
          status?.institution_id ?? status?.institutionId ?? status?.institution?.id;
        if (!institutionId) {
          console.warn("Missing institutionId in requisition status", status);
        }

        const accounts: string[] =
          status?.accounts ?? status?.account_ids ?? status?.accountIds ?? [];

        if (!accounts.length) {
          toast({
            title: "No accounts returned",
            description: "The bank did not return any account IDs to connect.",
            variant: "destructive",
          });
          return;
        }

        for (const accountId of accounts) {
          // Optional: fetch details for a friendly bank name
          let bankName = "Bank";
          try {
            const details = await getAccountDetails(accountId);
            bankName = (details as any)?.name || bankName;
          } catch {
            // ignore; keep default
          }

          // Avoid duplicates
          const { data: exists } = await supabase
            .from("connected_banks")
            .select("id")
            .eq("user_id", user.id)
            .eq("account_id", accountId)
            .limit(1);

          if (!exists || exists.length === 0) {
            const { error: insertError } = await supabase.from("connected_banks").insert({
              user_id: user.id,
              bank_name: bankName,
              account_id: accountId,
              institution_id: institutionId,
              is_active: true,
            });
            if (insertError) {
              console.error("Insert connected_banks error:", insertError);
              continue;
            }
          }

          onAccountConnected(accountId);
        }

        toast({ title: "Bank connected", description: "Your bank account has been linked." });
      } catch (err: any) {
        console.error("Finalize connection failed:", err);
        toast({
          title: "Unable to finalize connection",
          description: err?.message || "Please try again.",
          variant: "destructive",
        });
      } finally {
        // Clear the query so the effect won't run again
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname + window.location.hash
        );
      }
    })();
  }, [user, getRequisitionStatus, getAccountDetails, onAccountConnected, toast]);

  // Start the connection flow (same-tab navigation so we get the requisition_id back here)
  const handleConnect = async () => {
    if (!selectedBank || !user) {
      toast({ title: "Missing data", description: "You must be logged in and pick a bank." });
      return;
    }

    setLoading(true);
    try {
      const res: any = await createBankConnection(selectedBank);
      const redirectUrl = res?.redirectUrl || res?.redirect || res?.link || res?.url;
      if (redirectUrl) {
        window.location.href = redirectUrl; // same tab so finalize effect can read the query params
      } else {
        toast({
          title: "Open the bank link",
          description: "Follow the instructions to complete the connection.",
        });
      }
    } catch (err: any) {
      console.error("Bank connection error:", err);
      toast({
        title: "Failed to start connection",
        description: err?.message || "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a bank</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3">
          {/* Country selector */}
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

          {/* Institution selector */}
          <label className="text-sm">Bank</label>
          <select
            className="border rounded p-2 min-w-[220px]"
            value={selectedBank ?? ""}
            onChange={(e) => setSelectedBank(e.target.value)}
            disabled={banks.length === 0}
          >
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>

          <Button onClick={handleConnect} disabled={loading || !selectedBank}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
            {loading ? "Connecting..." : "Connect"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
