import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Header } from '@/components/Header'
import { BudgetOverview } from '@/components/BudgetOverview'
import { TransactionList } from '@/components/bank/TransactionList'
import { CategoryChart } from '@/components/CategoryChart'
import { useAuth } from '@/contexts/AuthContext'
import { CurrencyProvider } from '@/contexts/CurrencyContext'

const Dashboard = () => {
  const { user, loading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !user) {
      navigate('/')
    }
  }, [user, loading, navigate])

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (!user) {
    return null
  }

  return (
    <CurrencyProvider>
      <div className="min-h-screen bg-background">
        <Header />
        
        <main className="container mx-auto px-4 py-8 space-y-8">
          <div className="text-center space-y-2 mb-8">
            <h2 className="text-3xl font-bold">Welcome back!</h2>
            <p className="text-muted-foreground">Here's your financial overview</p>
          </div>

          <BudgetOverview />
          <CategoryChart />
          <TransactionList />
        </main>
      </div>
    </CurrencyProvider>
  )
}

export default Dashboard
