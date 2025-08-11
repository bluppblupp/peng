import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useCurrency } from "@/contexts/CurrencyContext";

const sampleTransactions = [
  {
    id: "1",
    date: "2024-01-20",
    description: "Grocery Store",
    amount: -85.50,
    category: "Food & Dining",
    account: "Checking",
    categoryColor: "bg-orange-500",
    currency: "USD",
    type: "debit" as const
  },
  {
    id: "2",
    date: "2024-01-19",
    description: "Salary Deposit",
    amount: 3500.00,
    category: "Income",
    account: "Checking",
    categoryColor: "bg-income",
    currency: "USD",
    type: "credit" as const
  },
  {
    id: "3",
    date: "2024-01-18",
    description: "Netflix Subscription",
    amount: -15.99,
    category: "Entertainment",
    account: "Credit Card",
    categoryColor: "bg-primary",
    currency: "USD",
    type: "debit" as const
  }
];

export const SampleTransactionList = () => {
  const { formatAmount } = useCurrency();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sample Transactions</CardTitle>
        <p className="text-sm text-muted-foreground">
          Here's what your transactions will look like once you connect your bank
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {sampleTransactions.map((transaction) => (
            <div 
              key={transaction.id} 
              className="flex items-center justify-between p-4 rounded-lg border bg-card/50 opacity-60"
            >
              <div className="flex items-center space-x-3">
                <div className={`w-3 h-3 rounded-full ${transaction.categoryColor}`} />
                <div>
                  <p className="font-medium">{transaction.description}</p>
                  <p className="text-sm text-muted-foreground">
                    {new Date(transaction.date).toLocaleDateString()} • {transaction.account}
                  </p>
                </div>
              </div>
              
              <div className="flex items-center space-x-3">
                <Badge variant="secondary" className="text-xs">
                  {transaction.category}
                </Badge>
                <span 
                  className={`font-semibold ${
                    transaction.amount > 0 ? 'text-income' : 'text-expense'
                  }`}
                >
                  {transaction.amount > 0 ? '+' : ''}{formatAmount(transaction.amount)}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 text-center text-xs text-muted-foreground">
          Sample data - connect your bank to see real transactions
        </div>
      </CardContent>
    </Card>
  );
};