import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Loader2, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

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
  onAccountConnected: (bankAccountId: string) => void; // you can call this after fetching bank_accounts if you want
}

export const BankConnection: React.FC<Props> = ({ onAccountConnected }) => {
  // Only need getBanks & createBankConnection here
  const { getBanks, createBankConnection } = useGoCardless();
  const { toast } = useToast();
  const { user } = useAuth();

  const [country, setCountry] = useState<string>("SE");
  const [banks, setBanks] = useState<{ id: string; name: string }[]>([]);
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  // ✅ Finalize on redirect using server function (gc_complete).
  // This upserts into public.bank_accounts (NOT connected_banks).
  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(location.search);
      const requisitionId =
        params.get("r") ||
        params.get("requisition_id") ||
        params.get("ref");
      if (!requisitionId || !user) return;

      try {
        setLoading(true);
        const { data, error } = await supabase.functions.invoke("gc_complete", {
          body: { requisition_id: requisitionId },
          // If you want to be explicit, you can also include the Authorization header,
          // but supabase-js will add it if the client is authed.
        });
        if (error) throw error;

        // You could optionally:
        // 1) navigate to your "Choose Accounts" page, or
        // 2) read bank_accounts here and call onAccountConnected for the first account.
        toast({ title: "Bank connected", description: "Accounts discovered." });
      } catch (err: any) {
        console.error("Finalize connection failed:", err);
        toast({
          title: "Unable to finalize connection",
          description: err?.message || "Please try again.",
          variant: "destructive",
        });
      } finally {
        // Clear the query so it won’t run twice
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname + window.location.hash
        );
        setLoading(false);
      }
    })();
  }, [user, toast]);

  // Start GoCardless flow
  const handleConnect = async () => {
    if (!selectedBank || !user) {
      toast({ title: "Missing data", description: "You must be logged in and pick a bank." });
      return;
    }
    setLoading(true);
    try {
      const redirectUrl = `${location.origin}/banks/callback`;
      const res: any = await createBankConnection(selectedBank, redirectUrl); // pass redirect ✅
      if (!res?.link) throw new Error("Did not receive GoCardless link");
      window.location.href = res.link;
    } catch (err: any) {
      console.error("Create requisition failed:", err);
      toast({
        title: "Unable to start connection",
        description: err?.message || "Please try again.",
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
