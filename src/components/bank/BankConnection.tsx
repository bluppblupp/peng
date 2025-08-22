import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Loader2, Plus } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { supabase } from "@/integrations/supabase/client"
const SUPABASE_URL = "https://cwbldfqsmcaqpdwiodrl.supabase.co";

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

export function BankConnection() {
  const { toast } = useToast()
  const [country, setCountry] = useState<string>("SE")
  const [banks, setBanks] = useState<Institution[]>([])
  const [selectedBank, setSelectedBank] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  

  // Load banks for the selected country
  useEffect(() => {
    ;(async () => {
      let text = ""
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (!session) {
          console.error("No auth session available")
          throw new Error("Unauthorized")
        }
       // BankConnection.tsx

const functionsUrl = `${SUPABASE_URL}/functions/v1`;

const res = await fetch(
  `${functionsUrl}/gc_institutions?country=${country}`,
  { headers: { Authorization: `Bearer ${session?.access_token}` } }
);

        
        text = await res.text()
        if (!res.ok) {
          console.error("Failed gc_institutions:", text)
          throw new Error(text)
        }
        const contentType = res.headers.get("content-type") ?? ""
        if (!contentType.includes("application/json")) {
          console.error(
            "Invalid content type from gc_institutions:",
            contentType,
            text,
          )
          throw new Error(`Invalid content type: ${contentType}`)
        }
        let list: Institution[];
        try {
          list = JSON.parse(text);
        } catch {
          console.error("gc_institutions returned non‑JSON:", text);
          throw new Error(`Invalid JSON: ${text.slice(0, 100)}`);
        }
        if (!Array.isArray(list)) {
          console.error("Unexpected institutions payload:", text)
          throw new Error("Invalid institutions payload")
        }
        setBanks(list)
        setSelectedBank(list[0]?.id ?? null)
      } catch (err) {
        console.error("Failed loading banks:", err, text)
        setBanks([])
        setSelectedBank(null)
        toast({
          title: "Could not load banks",
          description: "Please try another country or refresh.",
          variant: "destructive",
        })
      }
    })()
  }, [country, toast])

  // Start GoCardless flow
  const handleConnect = async () => {
    if (!selectedBank) {
      toast({ title: "Pick a bank", description: "Choose a bank to continue." })
      return
    }
    setLoading(true)
    try {
      const redirectUrl = `${location.origin}/banks/callback`
      const { data, error } = await supabase.functions.invoke("gc_create_requisition", {
        body: { institution_id: selectedBank, redirect_url: redirectUrl, bank_name: "Bank" },
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
      setLoading(false)
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
            disabled={banks.length === 0}
          >
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>

          <Button onClick={handleConnect} disabled={loading || !selectedBank}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            {loading ? "Connecting..." : "Connect"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
