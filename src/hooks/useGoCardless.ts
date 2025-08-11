import { useState, useCallback } from 'react'
import { supabase } from '@/integrations/supabase/client'

export interface Bank {
  id: string
  name: string
  bic: string
  logo: string
  countries: string[]
}

export interface Account {
  id: string
  iban: string
  name: string
  currency: string
  balances: {
    current: number
    available: number
  }
}

export interface Transaction {
  id: string
  amount: number
  currency: string
  date: string
  description: string
  category?: string
  merchant?: string
  type: 'debit' | 'credit'
  account?: string
}

interface GoCardlessTransaction {
  transactionId?: string
  internalTransactionId?: string
  transactionAmount: {
    amount: string
    currency: string
  }
  bookingDate?: string
  valueDate?: string
  remittanceInformationUnstructured?: string
  additionalInformation?: string
  creditorName?: string
  debtorName?: string
}

type GoCardlessActions =
  | 'getInstitutions'
  | 'createRequisition'
  | 'getRequisition'
  | 'getAccountDetails'
  | 'getAccountBalances'
  | 'getTransactions'

// Simple deterministic hash generator
const createTransactionId = (tx: GoCardlessTransaction) => {
  if (tx.transactionId) return tx.transactionId
  if (tx.internalTransactionId) return tx.internalTransactionId

  const baseString = `${tx.bookingDate || tx.valueDate || ''}|${tx.transactionAmount.amount}|${
    tx.remittanceInformationUnstructured || tx.additionalInformation || ''
  }`
  return btoa(unescape(encodeURIComponent(baseString))).replace(/=+$/, '')
}

export const useGoCardless = () => {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const callGoCardlessAPI = useCallback(
    async <T>(action: GoCardlessActions, params: Record<string, unknown> = {}): Promise<T> => {
      setLoading(true)
      setError(null)

      try {
        const { data, error } = await supabase.functions.invoke<T>('gocardless', {
          body: { action, ...params }
        })

        if (error) throw new Error(error.message || 'Unknown GoCardless API error')
        if (!data) throw new Error('No data returned from GoCardless API')

        return data
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred'
        setError(errorMessage)
        throw err
      } finally {
        setLoading(false)
      }
    },
    []
  )

  const getBanks = useCallback(
    async (country = 'SE'): Promise<Bank[]> => {
      const data = await callGoCardlessAPI<Bank[]>('getInstitutions', { country })
      return Array.isArray(data) ? data : []
    },
    [callGoCardlessAPI]
  )

  const createBankConnection = useCallback(
    async (institutionId: string) => {
      return await callGoCardlessAPI('createRequisition', {
        institutionId,
        redirectUrl: window.location.origin
      })
    },
    [callGoCardlessAPI]
  )

  const getRequisitionStatus = useCallback(
    async (requisitionId: string) => {
      return await callGoCardlessAPI('getRequisition', { requisitionId })
    },
    [callGoCardlessAPI]
  )

  const getAccountDetails = useCallback(
    async (accountId: string) => {
      return await callGoCardlessAPI<Account>('getAccountDetails', { accountId })
    },
    [callGoCardlessAPI]
  )

  const getAccountBalances = useCallback(
    async (accountId: string) => {
      const data = await callGoCardlessAPI<{ balances: Account['balances'][] }>(
        'getAccountBalances',
        { accountId }
      )
      return data.balances || []
    },
    [callGoCardlessAPI]
  )

  const getTransactions = useCallback(
    async (
      accountId: string,
      dateFrom?: string,
      dateTo?: string
    ): Promise<Transaction[]> => {
      const data = await callGoCardlessAPI<{
        transactions?: { booked?: GoCardlessTransaction[] }
      }>('getTransactions', {
        accountId,
        dateFrom,
        dateTo
      })

      return (data.transactions?.booked || []).map((tx) => ({
        id: createTransactionId(tx),
        amount: parseFloat(tx.transactionAmount.amount),
        currency: tx.transactionAmount.currency,
        date: (tx.bookingDate || tx.valueDate || new Date().toISOString()).split('T')[0],
        description:
          tx.remittanceInformationUnstructured ||
          tx.additionalInformation ||
          'Unknown',
        type: parseFloat(tx.transactionAmount.amount) >= 0 ? 'credit' : 'debit',
        merchant: tx.creditorName || tx.debtorName,
        account: accountId
      }))
    },
    [callGoCardlessAPI]
  )

  return {
    loading,
    error,
    getBanks,
    createBankConnection,
    getRequisitionStatus,
    getAccountDetails,
    getAccountBalances,
    getTransactions
  }
}
