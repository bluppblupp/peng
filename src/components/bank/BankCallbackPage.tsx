import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type CompleteAccountMeta = {
  id: string;
  name: string;
  currency: string | null;
  iban: string | null;
  type: string | null;
  row_id?: string;
};

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
      return null;
    }
  }
  return null;
}

function readCallbackParams() {
  const p = new URLSearchParams(window.location.search);
  // requisition id is commonly in "requisition_id" (sometimes "r")
  const requisitionId = p.get("requisition_id") ?? p.get("r") ?? null;
  // reference (your UUID you sent when creating the requisition) is often "reference" or "ref"
  const reference = p.get("reference") ?? p.get("ref") ?? null;
  return { requisitionId, reference };
}

export function BankCallbackPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [{ requisitionId, reference }] = useState(readCallbackParams);
  const [status, setStatus] = useState<"idle" | "completing" | "retrying" | "selecting" | "syncing" | "done" | "error">("idle");
  const [message, setMessage] = useState<string>("");
  const [retried, setRetried] = useState(false);

  useEffect(() => {
    (async () => {
      if (!requisitionId && !reference) {
        setStatus("error");
        setMessage("Missing requisition information.");
        return;
      }

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Your session expired. Please sign in and try again.");

        // 1) Try to complete
        setStatus("completing");
        setMessage("Finalizing connection…");

        const completeRes = await supabase.functions.invoke<{ accounts?: CompleteAccountMeta[] }>("gc_complete", {
          body: { requisition_id: requisitionId ?? undefined, reference: reference ?? undefined },
        });

        if (completeRes.error) {
          const json = await parseFunctionError(completeRes.error);

          // accept both the correct codes and the earlier misspelled ones
          const NOT_LINKED =
            json?.code === "REQUISITION_NOT_LINKED" || json?.code === "REQUISTION_NOT_LINKED";
          const EXPIRED =
            json?.code === "REQUISITION_EXPIRED" || json?.code === "REQUISTION_EXPIRED";

          if (!retried && (NOT_LINKED || EXPIRED)) {
            const institutionId = typeof json?.details?.institution_id === "string" ? (json!.details!.institution_id as string) : null;
            const bankName = typeof json?.details?.bank_name === "string" ? (json!.details!.bank_name as string) : "Bank";
            if (institutionId) {
              // 1a) Create a new requisition and redirect
              setRetried(true);
              setStatus("retrying");
              setMessage("Your BankID session expired — creating a new secure session…");

              const redirectUrl = `${location.origin}/banks/callback`;

              const createRes = await supabase.functions.invoke<{ link?: string }>("gc_create_requisition", {
                body: {
                  institution_id: institutionId,
                  redirect_url: redirectUrl,
                  bank_name: bankName,
                },
              });

              if (createRes.error) {
                const createJson = await parseFunctionError(createRes.error);
                const code = createJson?.code ? ` (${createJson.code}${createJson.correlationId ? ` · ${createJson.correlationId}` : ""})` : "";
                throw new Error((createJson?.error || createRes.error.message) + code);
              }

              if (!createRes.data?.link) {
                throw new Error("Could not start a new session with the bank.");
              }

              window.location.href = createRes.data.link;
              return;
            }
          }

          // Not retryable → surface message
          const code = json?.code ? ` (${json.code}${json?.correlationId ? ` · ${json.correlationId}` : ""})` : "";
          throw new Error((json?.error || completeRes.error.message) + code);
        }

        const metas = completeRes.data?.accounts ?? [];
        if (!metas.length) {
          setStatus("error");
          setMessage("No accounts were returned by the bank.");
          return;
        }

        // Prefer server-returned ids
        let accountIds = metas.map((m) => m.row_id).filter((x): x is string => !!x);
        if (!accountIds.length) {
          const cbRes = await supabase
            .from("connected_banks")
            .select("id")
            .eq("link_id", requisitionId ?? reference ?? "")
            .single();

          if (cbRes.error || !cbRes.data?.id) throw new Error("Could not find connected bank record.");

          const acctRes = await supabase
            .from("bank_accounts")
            .select("id")
            .eq("connected_bank_id", cbRes.data.id);

          if (acctRes.error) throw new Error(acctRes.error.message);
          accountIds = (acctRes.data ?? []).map((a) => a.id);
        }

        if (!accountIds.length) {
          setStatus("error");
          setMessage("No accounts found to select.");
          return;
        }

        // 2) Select all
        setStatus("selecting");
        setMessage("Selecting accounts…");
        const selRes = await supabase.from("bank_accounts").update({ is_selected: true }).in("id", accountIds);
        if (selRes.error) throw new Error(selRes.error.message);

        // 3) Sync with small concurrency
        setStatus("syncing");
        setMessage("Syncing transactions…");
        const concurrency = 3;
        for (let i = 0; i < accountIds.length; i += concurrency) {
          const batch = accountIds.slice(i, i + concurrency);
          const results = await Promise.allSettled(
            batch.map((id) => supabase.functions.invoke<unknown>("gc_sync", { body: { bank_account_id: id } }))
          );
          for (const res of results) {
            if (res.status === "rejected") {
              const reason = res.reason instanceof Error ? res.reason : new Error(String(res.reason));
              throw reason;
            }
            if (res.status === "fulfilled" && res.value.error) {
              const json = await parseFunctionError(res.value.error);
              const code = json?.code ? ` (${json.code}${json?.correlationId ? ` · ${json.correlationId}` : ""})` : "";
              throw new Error((json?.error || res.value.error.message) + code);
            }
          }
        }

        // Done
        setStatus("done");
        setMessage("All set! Redirecting…");
        toast({ title: "Connected", description: "Accounts synced successfully." });
        window.history.replaceState({}, document.title, window.location.pathname);
        setTimeout(() => navigate("/transactions", { replace: true }), 350);
      } catch (e: unknown) {
        console.error(e);
        setStatus("error");
        const msg = e instanceof Error ? e.message : String(e);
        setMessage(msg);
        toast({
          title: "Connection failed",
          description: msg || "Please try again.",
          variant: "destructive",
        });
      }
    })();
  }, [requisitionId, reference, navigate, toast, retried]);

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
  );
}
