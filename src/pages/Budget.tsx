import { useState, useEffect } from "react";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Edit, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/contexts/CurrencyContext";

interface Budget {
  id: string;
  category: string;
  monthly_limit: number;
  spent?: number;
}

const categories = [
  "Food & Dining",
  "Transportation", 
  "Entertainment",
  "Shopping",
  "Utilities",
  "Healthcare",
  "Education",
  "Travel",
  "Insurance",
  "Other"
];

const Budget = () => {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const [newBudget, setNewBudget] = useState({ category: "", monthly_limit: "" });
  const { formatAmount } = useCurrency();
  const { toast } = useToast();

  useEffect(() => {
    loadBudgets();
  }, []);

  const loadBudgets = async () => {
    try {
      const { data: budgetsData, error: budgetsError } = await supabase
        .from('budgets')
        .select('*')
        .order('category');

      if (budgetsError) throw budgetsError;

      // Get current month's spending for each category
      const currentDate = new Date();
      const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

      const { data: transactionsData, error: transactionsError } = await supabase
        .from('transactions')
        .select('category, amount')
        .gte('date', startOfMonth.toISOString().split('T')[0])
        .lte('date', endOfMonth.toISOString().split('T')[0]);

      if (transactionsError) throw transactionsError;

      // Calculate spent amounts by category
      const spentByCategory = transactionsData?.reduce((acc, transaction) => {
        const category = transaction.category;
        const amount = Math.abs(Number(transaction.amount));
        acc[category] = (acc[category] || 0) + amount;
        return acc;
      }, {} as Record<string, number>) || {};

      const budgetsWithSpending = budgetsData?.map(budget => ({
        ...budget,
        spent: spentByCategory[budget.category] || 0
      })) || [];

      setBudgets(budgetsWithSpending);
    } catch (error) {
      console.error('Error loading budgets:', error);
      toast({
        title: "Error",
        description: "Failed to load budgets",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveBudget = async () => {
    if (!newBudget.category || !newBudget.monthly_limit) {
      toast({
        title: "Error",
        description: "Please fill in all fields",
        variant: "destructive",
      });
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const budgetData = {
        user_id: user.id,
        category: newBudget.category,
        monthly_limit: parseFloat(newBudget.monthly_limit)
      };

      if (editingBudget) {
        const { error } = await supabase
          .from('budgets')
          .update(budgetData)
          .eq('id', editingBudget.id);

        if (error) throw error;
        
        toast({
          title: "Success",
          description: "Budget updated successfully",
        });
      } else {
        const { error } = await supabase
          .from('budgets')
          .insert(budgetData);

        if (error) throw error;
        
        toast({
          title: "Success",
          description: "Budget created successfully",
        });
      }

      setIsDialogOpen(false);
      setEditingBudget(null);
      setNewBudget({ category: "", monthly_limit: "" });
      loadBudgets();
    } catch (error) {
      console.error('Error saving budget:', error);
      toast({
        title: "Error",
        description: "Failed to save budget",
        variant: "destructive",
      });
    }
  };

  const handleDeleteBudget = async (budgetId: string) => {
    try {
      const { error } = await supabase
        .from('budgets')
        .delete()
        .eq('id', budgetId);

      if (error) throw error;
      
      toast({
        title: "Success",
        description: "Budget deleted successfully",
      });
      
      loadBudgets();
    } catch (error) {
      console.error('Error deleting budget:', error);
      toast({
        title: "Error",
        description: "Failed to delete budget",
        variant: "destructive",
      });
    }
  };

  const openEditDialog = (budget: Budget) => {
    setEditingBudget(budget);
    setNewBudget({ 
      category: budget.category, 
      monthly_limit: budget.monthly_limit.toString() 
    });
    setIsDialogOpen(true);
  };

  const openCreateDialog = () => {
    setEditingBudget(null);
    setNewBudget({ category: "", monthly_limit: "" });
    setIsDialogOpen(true);
  };

  const getProgressPercentage = (spent: number, limit: number) => {
    return Math.min((spent / limit) * 100, 100);
  };

  const getProgressVariant = (percentage: number) => {
    if (percentage >= 100) return "destructive";
    if (percentage >= 80) return "warning";
    return "default";
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="container mx-auto px-4 py-8">
          <div className="flex justify-center items-center h-64">
            <p className="text-muted-foreground">Loading budgets...</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="container mx-auto px-4 py-8 space-y-8">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold">Budget Management</h1>
            <p className="text-muted-foreground mt-2">Set spending limits and track your progress</p>
          </div>
          
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openCreateDialog}>
                <Plus className="w-4 h-4 mr-2" />
                Add Budget
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {editingBudget ? "Edit Budget" : "Create New Budget"}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="category">Category</Label>
                  <Select 
                    value={newBudget.category} 
                    onValueChange={(value) => setNewBudget({ ...newBudget, category: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((category) => (
                        <SelectItem key={category} value={category}>
                          {category}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                
                <div>
                  <Label htmlFor="limit">Monthly Limit</Label>
                  <Input
                    id="limit"
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={newBudget.monthly_limit}
                    onChange={(e) => setNewBudget({ ...newBudget, monthly_limit: e.target.value })}
                  />
                </div>
                
                <Button onClick={handleSaveBudget} className="w-full">
                  {editingBudget ? "Update Budget" : "Create Budget"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {budgets.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <h3 className="text-lg font-semibold mb-2">No budgets set</h3>
              <p className="text-muted-foreground mb-4">
                Create your first budget to start tracking your spending
              </p>
              <Button onClick={openCreateDialog}>
                <Plus className="w-4 h-4 mr-2" />
                Create Budget
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {budgets.map((budget) => {
              const spent = budget.spent || 0;
              const percentage = getProgressPercentage(spent, budget.monthly_limit);
              const remaining = Math.max(budget.monthly_limit - spent, 0);
              
              return (
                <Card key={budget.id}>
                  <CardHeader className="pb-2">
                    <div className="flex justify-between items-start">
                      <CardTitle className="text-lg">{budget.category}</CardTitle>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditDialog(budget)}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteBudget(budget.id)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  
                  <CardContent className="space-y-4">
                    <div className="flex justify-between text-sm">
                      <span>Spent: {formatAmount(spent)}</span>
                      <span>Budget: {formatAmount(budget.monthly_limit)}</span>
                    </div>
                    
                    <Progress 
                      value={percentage} 
                      className="h-2"
                    />
                    
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">
                        {percentage >= 100 ? (
                          <span className="text-destructive font-medium">
                            Over budget by {formatAmount(spent - budget.monthly_limit)}
                          </span>
                        ) : (
                          <span>
                            {formatAmount(remaining)} remaining
                          </span>
                        )}
                      </span>
                      <span className="text-sm font-medium">
                        {percentage.toFixed(0)}%
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default Budget;