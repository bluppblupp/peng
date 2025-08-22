import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { supabase } from "@/integrations/supabase/client"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

function getRequisitionId(): string | null {
  const p = new URLSearchParams(window.location.search)
  return p.get("r") || p.get("requisition_id") || p.get("ref")
}

export function BankCallbackPage() {
  const { toast } = useToast()
  const navigate = useNavigate()
  const [status, setStatus] = useState<"idle" | "completing" | "selecting" | "syncing" | "done" | "error">("idle")
  const [message, setMessage] = useState<string>("")
  const requisitionId = getRequisitionId()

  useEffect(() => {
    ;(async () => {
      if (!requisitionId) {
        setStatus("error")
        setMessage("Missing requisition id.")
        return
      }

      try {
        setStatus("completing")
        setMessage("Finalizing connection…")
        const { data: completeData, error: completeErr } = await supabase.functions.invoke("gc_complete", {
          body: { requisition_id: requisitionId },
        })
        if (completeErr) throw completeErr

        const { data: cb, error: cbErr } = await supabase
          .from("connected_banks")
          .select("id")
          .eq("link_id", requisitionId)
          .single()
        if (cbErr || !cb?.id) throw new Error("Could not find connected bank record.")

        const { data: accounts, error: acctErr } = await supabase
          .from("bank_accounts")
          .select("id, name, currency")
          .eq("connected_bank_id", cb.id)
        if (acctErr) throw acctErr

        if (!accounts || accounts.length === 0) {
          setStatus("error")
          setMessage("No accounts were returned by the bank.")
          return
        }

        setStatus("selecting")
        setMessage("Selecting accounts…")
        const ids = accounts.map((a) => a.id)
        const { error: selErr } = await supabase
          .from("bank_accounts")
          .update({ is_selected: true })
          .in("id", ids)
        if (selErr) throw selErr

        setStatus("syncing")
        setMessage("Syncing transactions…")
        for (const id of ids) {
          const { error: syncErr } = await supabase.functions.invoke("gc_sync", {
            body: { bank_account_id: id },
          })
          if (syncErr) throw syncErr
        }

        setStatus("done")
        setMessage("All set! Redirecting…")
        toast({ title: "Connected", description: "Accounts synced successfully." })

        window.history.replaceState({}, document.title, window.location.pathname)
        setTimeout(() => navigate("/transactions", { replace: true }), 350)
      } catch (err: unknown) {
        console.error(err)
        setStatus("error")
        const msg = err instanceof Error ? err.message : String(err)
        setMessage(msg)
        toast({
          title: "Connection failed",
          description: msg || "Please try again.",
          variant: "destructive",
        })
      }
    })()
  }, [requisitionId, navigate, toast])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connecting your bank…</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        {status !== "error" ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">{message || "Working…"}</span>
          </>
        ) : (
          <span className="text-sm text-red-600">{message}</span>
        )}
      </CardContent>
    </Card>
  )
}
