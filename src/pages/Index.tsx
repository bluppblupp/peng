import { Header } from "@/components/Header";
import { BudgetOverview } from "@/components/BudgetOverview";
import { SampleTransactionList } from "@/components/SampleTransactionList";
import { CategoryChart } from "@/components/CategoryChart";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="container mx-auto px-4 py-8 space-y-8">
        {/* Welcome Section */}
        <div className="text-center space-y-2 mb-8">
          <h2 className="text-3xl font-bold">Welcome back, John!</h2>
          <p className="text-muted-foreground">Here's your financial overview for January 2024</p>
        </div>

        {/* Budget Overview */}
        <BudgetOverview />

        {/* Charts Section */}
        <CategoryChart />

        {/* Sample Transactions */}
        <SampleTransactionList />
        
        {/* Bank Integration Notice */}
        <div className="mt-12 p-6 rounded-lg border border-warning/20 bg-warning/5">
          <h3 className="font-semibold text-warning mb-2">🔒 Ready for Real Banking Integration</h3>
          <p className="text-sm text-muted-foreground">
            This app is designed to integrate with GoCardless API for automatic transaction fetching and Bank ID/Freja ID for secure authentication. 
            Backend integration with Supabase is required to implement these features securely.
          </p>
        </div>
      </main>
    </div>
  );
};

export default Index;
