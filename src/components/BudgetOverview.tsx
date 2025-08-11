import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useCurrency } from "@/contexts/CurrencyContext";
import { TrendingUp, TrendingDown, Wallet, Target } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface BudgetData {
  category: string;
  spent: number;
  budget: number;
}

export const BudgetOverview = () => {
  const [budgetData, setBudgetData] = useState<BudgetData[]>([]);
  const [totalIncome, setTotalIncome] = useState(0);
  const [totalExpenses, setTotalExpenses] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const { formatAmount } = useCurrency();
  
  const savings = totalIncome - totalExpenses;

  useEffect(() => {
    loadBudgetData();
  }, []);

  const loadBudgetData = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Get current month date range
      const currentDate = new Date();
      const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

      // Get budgets and spending for current month
      const [{ data: budgets }, { data: transactions }] = await Promise.all([
        supabase
          .from('budgets')
          .select('*')
          .eq('user_id', user.id),
        supabase
          .from('transactions')
          .select('category, amount')
          .eq('user_id', user.id)
          .gte('date', startOfMonth.toISOString().split('T')[0])
          .lte('date', endOfMonth.toISOString().split('T')[0])
      ]);

      // Calculate total income and expenses
      let income = 0;
      let expenses = 0;

      transactions?.forEach(transaction => {
        const amount = Number(transaction.amount);
        if (amount > 0) {
          income += amount;
        } else {
          expenses += Math.abs(amount);
        }
      });

      setTotalIncome(income);
      setTotalExpenses(expenses);

      // Calculate spending by category
      const spentByCategory = transactions?.reduce((acc, transaction) => {
        const amount = Number(transaction.amount);
        if (amount < 0) { // Only count expenses
          const category = transaction.category;
          acc[category] = (acc[category] || 0) + Math.abs(amount);
        }
        return acc;
      }, {} as Record<string, number>) || {};

      // Combine budgets with actual spending
      const budgetWithSpending = budgets?.map(budget => ({
        category: budget.category,
        spent: spentByCategory[budget.category] || 0,
        budget: Number(budget.monthly_limit)
      })) || [];

      setBudgetData(budgetWithSpending);
    } catch (error) {
      console.error('Error loading budget data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="bg-gradient-to-br from-card to-card/50">
              <CardContent className="p-6">
                <div className="flex items-center justify-center h-16">
                  <p className="text-sm text-muted-foreground">Loading...</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Financial Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-gradient-to-br from-card to-card/50">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Balance</p>
                <p className="text-2xl font-bold text-foreground">{formatAmount(savings)}</p>
              </div>
              <Wallet className="h-8 w-8 text-primary" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-income/10 to-income/5">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Monthly Income</p>
                <p className="text-2xl font-bold text-income">{formatAmount(totalIncome)}</p>
              </div>
              <TrendingUp className="h-8 w-8 text-income" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-expense/10 to-expense/5">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Monthly Expenses</p>
                <p className="text-2xl font-bold text-expense">{formatAmount(totalExpenses)}</p>
              </div>
              <TrendingDown className="h-8 w-8 text-expense" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-success/10 to-success/5">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Savings</p>
                <p className="text-2xl font-bold text-success">{formatAmount(savings)}</p>
              </div>
              <Target className="h-8 w-8 text-success" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Budget Progress */}
      {budgetData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Budget Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {budgetData.map((item, index) => {
              const percentage = (item.spent / item.budget) * 100;
              const isOverBudget = percentage > 100;
              
              return (
                <div key={index} className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-medium">{item.category}</span>
                     <span className={`font-semibold ${isOverBudget ? 'text-expense' : 'text-muted-foreground'}`}>
                        {formatAmount(item.spent)} / {formatAmount(item.budget)}
                      </span>
                  </div>
                  <Progress 
                    value={Math.min(percentage, 100)} 
                    className="h-2"
                  />
                  {isOverBudget && (
                    <p className="text-sm text-expense">Over budget by {formatAmount(item.spent - item.budget)}</p>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
};