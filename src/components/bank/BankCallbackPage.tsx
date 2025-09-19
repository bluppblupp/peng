// src/pages/Banks/BankCallbackPage.tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/** Types returned by gc_complete */
type CompleteAccountMeta = {
  id: string;
  name: string;
  currency: string | null;
  iban: string | null;
  type: string | null;
  row_id?: string; // DB id of bank_accounts row (if server returns it)
};

type CompleteResult = { accounts?: CompleteAccountMeta[] };

type FunctionErrorJson = {
  error?: string;
  code?: string;
  correlationId?: string;
  details?: Record<string, unknown>;
};

function isResponseLike(x: unknown): x is Response {
  return typeof Response !== "undefined" && x instanceof Response;
}

async function parseFunctionError(err: { message: string; context?: unknown }): Promise<FunctionErrorJson | null> {
  if (err.context && isResponseLike(err.context)) {
    try {
      const json = (await err.context.clone().json()) as unknown;
      if (json && typeof json === "object") return json as FunctionErrorJson;
    } catch {
      // ignore parse failure
    }
  }
  return null;
}

function readCallbackParams() {
  const p = new URLSearchParams(window.location.search);
  // Requisition id (GoCardless/Nordigen) – commonly returned as ?ref
  const requisitionId =
    p.get("requisition_id") || p.get("ref") || p.get("r") || p.get("id") || null;
  // Optional client-set reference (only if you also pass one when creating)
  const reference = p.get("reference") || null;
  return { requisitionId, reference };
}

export function BankCallbackPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [{ requisitionId, reference }] = useState(readCallbackParams);
  const [status, setStatus] = useState<"idle" | "finalizing" | "selecting" | "redirect" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    (async () => {
      if (!requisitionId) {
        setStatus("error");
        setMessage("Missing requisition id in callback URL.");
        return;
      }

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Your session expired. Please sign in and try again.");

        // 1) Finalize the connection on the server
        setStatus("finalizing");
        setMessage("Finalizing connection…");

        const res = await supabase.functions.invoke<CompleteResult>("gc_complete", {
          body: { requisition_id: requisitionId, reference: reference ?? undefined },
        });

        if (res.error) {
          const json = await parseFunctionError(res.error);
          const code = json?.code ? ` (${json.code}${json?.correlationId ? ` · ${json.correlationId}` : ""})` : "";
          throw new Error((json?.error || res.error.message) + code);
        }

        const completeData = res.data ?? null;

        const metas = completeData?.accounts ?? [];
        // 2) Mark accounts selected (best effort) and prep auto-sync
        setStatus("selecting");
        setMessage("Preparing your accounts…");

        let accountIds = metas.map((m) => m.row_id).filter((x): x is string => !!x);

        if (!accountIds.length) {
          // fallback: find connected_banks row via requisitionId or reference, then load accounts
          const linkKey = requisitionId ?? reference ?? "";
          if (linkKey) {
            const cbRes = await supabase
              .from("connected_banks")
              .select("id")
              .eq("link_id", linkKey)
              .single();

            if (!cbRes.error && cbRes.data?.id) {
              const acctRes = await supabase
                .from("bank_accounts")
                .select("id")
                .eq("connected_bank_id", cbRes.data.id);

              if (!acctRes.error && Array.isArray(acctRes.data)) {
                accountIds = acctRes.data.map((a) => a.id);
              }
            }
          }
        }

        if (accountIds.length > 0) {
          // mark selected so the dashboard shows them immediately
          await supabase.from("bank_accounts").update({ is_selected: true }).in("id", accountIds);
          // drop a hint for the dashboard to auto-sync
          localStorage.setItem("peng:pendingSync", JSON.stringify({ accountIds, ts: Date.now() }));
        }

        // 3) Redirect early to the dashboard; the dashboard card can auto-sync
        setStatus("redirect");
        setMessage("Connected! Redirecting to your dashboard…");
        toast({ title: "Bank connected", description: "We’ll sync your transactions in the background." });

        // Clean URL (remove query) before navigating
        window.history.replaceState({}, document.title, window.location.pathname);
        setTimeout(() => navigate("/", { replace: true }), 300);
      } catch (e: unknown) {
        console.error(e);
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        setMessage(msg);
        toast({
          title: "Connection failed",
          description: msg || "Please try again.",
          variant: "destructive",
        });
      }
    })();
  }, [requisitionId, reference, navigate, toast]);

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-base">Connecting your bank…</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-2 text-sm py-2">
        {status !== "error" ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{message || "Working…"}</span>
          </>
        ) : (
          <span className="text-red-600">{message}</span>
        )}
      </CardContent>
    </Card>
  );
}
