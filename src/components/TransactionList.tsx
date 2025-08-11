import { useEffect, useState, useCallback } from 'react'
import { useGoCardless } from '@/hooks/useGoCardless'
import { supabase } from '@/integrations/supabase/client'
import { useAuth } from '@/contexts/AuthContext'
import { Transaction } from '@/hooks/useGoCardless'
import type { TablesInsert } from '@/integrations/supabase/types'

export const TransactionList = () => {
  const { user } = useAuth()
  const { getTransactions, loading, error } = useGoCardless()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [fetchedIds, setFetchedIds] = useState<Set<string>>(new Set())

  const fetchAndStoreTransactions = useCallback(
    async (accountId: string, dateFrom?: string, dateTo?: string) => {
      try {
        const newTransactions = await getTransactions(accountId, dateFrom, dateTo)
        // Filter out already fetched ones
        const uniqueTransactions = newTransactions.filter(tx => !fetchedIds.has(tx.id))
        
        if (uniqueTransactions.length === 0) return

        // Transform transactions to match database schema
        const dbTransactions: TablesInsert<'transactions'>[] = uniqueTransactions.map(tx => ({
          transaction_id: tx.id,
          bank_account_id: accountId,
          user_id: user?.id || '',
          amount: tx.amount,
          date: tx.date,
          description: tx.description,
          category: tx.category || 'uncategorized', // Required field, provide default
        }))

        // Store in DB
        const { error: dbError } = await supabase
          .from('transactions')
          .upsert(dbTransactions, {
            onConflict: 'transaction_id'
          })
        
        if (dbError) throw dbError

        // Update state + cache
        setTransactions(prev => [...prev, ...uniqueTransactions])
        setFetchedIds(prev => {
          const updated = new Set(prev)
          uniqueTransactions.forEach(tx => updated.add(tx.id))
          return updated
        })
      } catch (err) {
        console.error('Failed to fetch/store transactions', err)
      }
    },
    [getTransactions, fetchedIds, user?.id]
  )

  // Auto-fetch when account is connected
  useEffect(() => {
    const loadInitial = async () => {
      if (!user) return
      
      const { data: accounts, error: accountsError } = await supabase
        .from('connected_banks')
        .select('account_id')
        .eq('user_id', user.id)
        .eq('is_active', true)
      
      if (accountsError) {
        console.error('Error fetching accounts:', accountsError)
        return
      }
      
      if (accounts) {
        for (const acc of accounts) {
          await fetchAndStoreTransactions(acc.account_id)
        }
      }
    }
    
    loadInitial()
  }, [user, fetchAndStoreTransactions])

  if (loading) return <p>Loading transactions...</p>
  if (error) return <p className="text-red-500">Error: {error}</p>

  return (
    <div className="bg-card shadow rounded-lg p-4">
      <h3 className="text-lg font-semibold mb-4">Transactions</h3>
      {transactions.length === 0 ? (
        <p className="text-muted-foreground">No transactions yet</p>
      ) : (
        <ul className="divide-y divide-border">
          {transactions
            .sort((a, b) => b.date.localeCompare(a.date))
            .map(tx => (
              <li key={tx.id} className="py-2 flex justify-between">
                <span>{tx.description}</span>
                <span
                  className={
                    tx.type === 'credit'
                      ? 'text-green-600 font-medium'
                      : 'text-red-600 font-medium'
                  }
                >
                  {tx.amount.toFixed(2)} {tx.currency}
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}