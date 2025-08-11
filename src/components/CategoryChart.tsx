import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/contexts/CurrencyContext";

interface CategoryData {
  name: string;
  value: number;
  color: string;
}

interface MonthlyData {
  month: string;
  income: number;
  expenses: number;
}

const categoryColors: Record<string, string> = {
  'Food & Dining': '#f97316',
  'Transportation': '#eab308',
  'Entertainment': '#3b82f6',
  'Shopping': '#8b5cf6',
  'Utilities': '#06b6d4',
  'Healthcare': '#10b981',
  'Education': '#f59e0b',
  'Travel': '#ec4899',
  'Insurance': '#ef4444',
  'Other': '#6b7280'
};

export const CategoryChart = () => {
  const [categoryData, setCategoryData] = useState<CategoryData[]>([]);
  const [monthlyData, setMonthlyData] = useState<MonthlyData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { formatAmount } = useCurrency();

  useEffect(() => {
    loadChartData();
  }, []);

  const loadChartData = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Get current month's transactions for category chart
      const currentDate = new Date();
      const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

      const { data: currentMonthTransactions } = await supabase
        .from('transactions')
        .select('category, amount')
        .eq('user_id', user.id)
        .gte('date', startOfMonth.toISOString().split('T')[0])
        .lte('date', endOfMonth.toISOString().split('T')[0]);

      // Process category data
      if (currentMonthTransactions) {
        const expensesByCategory = currentMonthTransactions
          .filter(t => Number(t.amount) < 0)
          .reduce((acc, transaction) => {
            const category = transaction.category;
            const amount = Math.abs(Number(transaction.amount));
            acc[category] = (acc[category] || 0) + amount;
            return acc;
          }, {} as Record<string, number>);

        const categoryChartData = Object.entries(expensesByCategory)
          .map(([name, value]) => ({
            name,
            value: Math.round(value),
            color: categoryColors[name] || categoryColors.Other
          }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 6); // Top 6 categories

        setCategoryData(categoryChartData);
      }

      // Get last 4 months data for trend chart
      const monthlyTrendData: MonthlyData[] = [];
      
      for (let i = 3; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
        const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
        
        const { data: monthTransactions } = await supabase
          .from('transactions')
          .select('amount')
          .eq('user_id', user.id)
          .gte('date', monthStart.toISOString().split('T')[0])
          .lte('date', monthEnd.toISOString().split('T')[0]);

        let income = 0;
        let expenses = 0;

        monthTransactions?.forEach(transaction => {
          const amount = Number(transaction.amount);
          if (amount > 0) {
            income += amount;
          } else {
            expenses += Math.abs(amount);
          }
        });

        monthlyTrendData.push({
          month: date.toLocaleDateString('en-US', { month: 'short' }),
          income: Math.round(income),
          expenses: Math.round(expenses)
        });
      }

      setMonthlyData(monthlyTrendData);
    } catch (error) {
      console.error('Error loading chart data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardContent className="flex items-center justify-center h-80">
            <p className="text-muted-foreground">Loading chart data...</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-center h-80">
            <p className="text-muted-foreground">Loading chart data...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (categoryData.length === 0 && monthlyData.length === 0) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Spending by Category</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center h-80">
              <div className="text-center">
                <p className="text-muted-foreground mb-2">No spending data available</p>
                <p className="text-sm text-muted-foreground">Connect a bank account and make some transactions to see your spending patterns</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Income vs Expenses</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center h-80">
              <div className="text-center">
                <p className="text-muted-foreground mb-2">No transaction data available</p>
                <p className="text-sm text-muted-foreground">Your income and expense trends will appear here once you have transaction data</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Spending by Category - Pie Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Spending by Category</CardTitle>
        </CardHeader>
        <CardContent>
          {categoryData.length > 0 ? (
            <>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={categoryData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={120}
                      dataKey="value"
                      strokeWidth={2}
                      stroke="hsl(var(--border))"
                    >
                      {categoryData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value) => [formatAmount(Number(value)), 'Amount']}
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '6px'
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              
              {/* Legend */}
              <div className="grid grid-cols-2 gap-2 mt-4">
                {categoryData.map((item, index) => (
                  <div key={index} className="flex items-center space-x-2">
                    <div 
                      className="w-3 h-3 rounded-full" 
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-sm text-muted-foreground">{item.name}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-80">
              <p className="text-muted-foreground">No category data available</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Income vs Expenses Trend */}
      <Card>
        <CardHeader>
          <CardTitle>Income vs Expenses</CardTitle>
        </CardHeader>
        <CardContent>
          {monthlyData.length > 0 ? (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis 
                    dataKey="month" 
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: 'hsl(var(--muted-foreground))' }}
                  />
                  <YAxis 
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(value) => formatAmount(value)}
                  />
                  <Tooltip 
                    formatter={(value, name) => [formatAmount(Number(value)), name === 'income' ? 'Income' : 'Expenses']}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '6px'
                    }}
                  />
                  <Bar dataKey="income" fill="hsl(var(--income))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="expenses" fill="hsl(var(--expense))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-center h-80">
              <p className="text-muted-foreground">No trend data available</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};