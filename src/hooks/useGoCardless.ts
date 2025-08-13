import { useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface Bank {
  id: string;
  name: string;
  bic: string;
  logo: string;
  countries: string[];
}

export interface Account {
  id: string;
  iban: string;
  name: string;
  currency: string;
  balances: {
    current: number;
    available: number;
  };
}

export interface Transaction {
  id: string;
  amount: number;
  currency: string;
  date: string;
  description: string;
  category?: string;
  merchant?: string;
  type: "debit" | "credit";
  account?: string 
}

export const useGoCardless = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callGoCardlessAPI = useCallback(async (action: string, params: any = {}) => {
    setLoading(true);
    setError(null);

    try {
      const { data, error } = await supabase.functions.invoke("gocardless", {
        body: { action, ...params },
      });

      if (error) throw error;
      return data;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const getBanks = useCallback(async (country = "GB"): Promise<Bank[]> => {
    const data = await callGoCardlessAPI("getInstitutions", { country });
    return Array.isArray(data) ? data : [];
  }, [callGoCardlessAPI]);

  const createBankConnection = useCallback(
    async (institutionId: string, redirectUrl: string) => {
      return await callGoCardlessAPI('createRequisition', {
        institutionId,
        redirectUrl, // pass through from the caller
      })
    },
    [callGoCardlessAPI]
  )

  const getRequisitionStatus = useCallback(async (requisitionId: string) => {
    return await callGoCardlessAPI("getRequisition", { requisitionId });
  }, [callGoCardlessAPI]);

  const getAccountDetails = useCallback(async (accountId: string) => {
    return await callGoCardlessAPI("getAccountDetails", { accountId });
  }, [callGoCardlessAPI]);

  const getAccountBalances = useCallback(async (accountId: string) => {
    const data = await callGoCardlessAPI("getAccountBalances", { accountId });
    return data.balances || [];
  }, [callGoCardlessAPI]);

  const getTransactions = useCallback(
    async (accountId: string, dateFrom?: string, dateTo?: string): Promise<Transaction[]> => {
      const data = await callGoCardlessAPI("getTransactions", {
        accountId,
        dateFrom,
        dateTo,
      });

      return (data.transactions?.booked || []).map((tx: any) => ({
        id: tx.transactionId || tx.internalTransactionId,
        amount: parseFloat(tx.transactionAmount.amount),
        currency: tx.transactionAmount.currency,
        date: tx.bookingDate || tx.valueDate,
        description:
          tx.remittanceInformationUnstructured ||
          tx.additionalInformation ||
          "Unknown",
        type:
          parseFloat(tx.transactionAmount.amount) >= 0 ? "credit" : "debit",
        merchant: tx.creditorName || tx.debtorName,
        account: accountId,
      }));
    },
    [callGoCardlessAPI]
  );

const connectBank = useCallback(async () => {
  const banks = await getBanks("GB");
  if (!banks.length) throw new Error("No banks found");

  const selectedBank = banks[0]; // (still just a demo pick)
  const redirectUrl = `${window.location.origin}${window.location.pathname}`;

  // now pass both params
  const res: any = await createBankConnection(selectedBank.id, redirectUrl);

  // FYI: your edge function returns { id, link, redirect, status }
  // It does NOT return accountId here — that comes AFTER the user completes the flow.
  // So just return what you actually have:
  return { requisitionId: res.id, link: res.link, institutionName: selectedBank.name };
}, [getBanks, createBankConnection]);

  return {
    loading,
    error,
    getBanks,
    createBankConnection,
    getRequisitionStatus,
    getAccountDetails,
    getAccountBalances,
    getTransactions,
    connectBank,
  };
};
