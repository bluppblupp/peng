import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Loader2, Plus } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { supabase } from "@/integrations/supabase/client"

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
  const [banks, setBanks] = useState<{ id: string; name: string }[]>([])
  const [selectedBank, setSelectedBank] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Load banks for the selected country
  useEffect(() => {
    ;(async () => {
      try {
        const session = (await supabase.auth.getSession()).data.session
        const res = await fetch(`/functions/v1/gc_institutions?country=${country}`, {
          headers: { Authorization: `Bearer ${session?.access_token}` },
        })
        if (!res.ok) throw new Error(await res.text())
        const list = await res.json()
        const simplified = (list || []).map((b: any) => ({ id: b.id, name: b.name }))
        setBanks(simplified)
        setSelectedBank(simplified[0]?.id ?? null)
      } catch (err) {
        console.error("Failed loading banks:", err)
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
    } catch (err: any) {
      console.error("Create requisition failed:", err)
      toast({
        title: "Unable to start connection",
        description: err?.message || "Please try again.",
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
