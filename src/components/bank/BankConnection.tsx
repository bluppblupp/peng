import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Loader2, Plus } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { supabase } from "@/integrations/supabase/client"

// This constant is used to manually build the function URL.
const SUPABASE_URL = "https://cwbldfqsmcaqpdwiodrl.supabase.co";

// The Supabase URL should be managed via environment variables
// Example: const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL;

interface Institution {
  id: string
  name: string
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
]

// Custom hook to handle fetching bank institutions
const useBanks = (country: string) => {
  const [banks, setBanks] = useState<Institution[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const loadBanks = async () => {
      if (!country) return;

      setLoading(true);
      setBanks([]);
      setError(null);

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          throw new Error("Authentication failed. Please log in again.");
        }
        
        const functionUrl = `${SUPABASE_URL}/functions/v1/gc_institutions`;
        const response = await fetch(`${functionUrl}?country=${country}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${session.access_token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.details || `Server error: ${response.status}`);
        }

        const data: Institution[] = await response.json();
        if (!Array.isArray(data)) {
            throw new Error("Invalid response from server");
        }
        
        setBanks(data);

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "An unknown error occurred.";
        setError(errorMessage);
        console.error("Failed loading banks:", err);
        toast({
          title: "Could not load banks",
          description: errorMessage,
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    };

    loadBanks();
  }, [country, toast]);

  return { banks, loading, error };
};


export function BankConnection() {
  const { toast } = useToast()
  const [country, setCountry] = useState<string>("SE")
  const { banks, loading: banksLoading, error: banksError } = useBanks(country);
  const [selectedBank, setSelectedBank] = useState<string | null>(null)
  const [connectLoading, setConnectLoading] = useState(false)

  // Update selected bank when the list of banks changes
  useEffect(() => {
    if (banks.length > 0) {
      setSelectedBank(banks[0].id);
    } else {
      setSelectedBank(null);
    }
  }, [banks]);


  // Start GoCardless flow
  const handleConnect = async () => {
    if (!selectedBank) {
      toast({ title: "Pick a bank", description: "Choose a bank to continue." })
      return
    }
    setConnectLoading(true)
    try {
      const redirectUrl = `${location.origin}/banks/callback`
      const bank = banks.find(b => b.id === selectedBank);
      const { data, error } = await supabase.functions.invoke("gc_create_requisition", {
        body: { institution_id: selectedBank, redirect_url: redirectUrl, bank_name: bank?.name || "Bank" },
      })
      if (error) throw error
      if (!data?.link) throw new Error("Did not receive GoCardless link")
      window.location.href = data.link
    } catch (err: unknown) {
      console.error("Create requisition failed:", err)
      toast({
        title: "Unable to start connection",
        description: (err as Error)?.message || "Please try again.",
        variant: "destructive",
      })
    } finally {
      setConnectLoading(false)
    }
  }

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
            {!banksLoading && banks.length === 0 && <option>{banksError ? "Error loading banks" : "No banks found"}</option>}
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
  )
}
