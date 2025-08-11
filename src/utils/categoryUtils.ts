// Utility functions for transaction categorization
export const categorizeTransaction = (description: string): string => {
  const desc = description.toLowerCase();
  
  // Food & Dining
  if (desc.includes('restaurant') || desc.includes('mcdonalds') || desc.includes('kfc') || 
      desc.includes('pizza') || desc.includes('cafe') || desc.includes('starbucks') ||
      desc.includes('subway') || desc.includes('burger') || desc.includes('food') ||
      desc.includes('grocery') || desc.includes('supermarket') || desc.includes('tesco') ||
      desc.includes('sainsbury') || desc.includes('asda') || desc.includes('morrisons')) {
    return 'Food & Dining';
  }
  
  // Transportation
  if (desc.includes('fuel') || desc.includes('petrol') || desc.includes('diesel') ||
      desc.includes('shell') || desc.includes('bp') || desc.includes('esso') ||
      desc.includes('taxi') || desc.includes('uber') || desc.includes('train') ||
      desc.includes('bus') || desc.includes('transport') || desc.includes('parking') ||
      desc.includes('tfl') || desc.includes('oyster')) {
    return 'Transportation';
  }
  
  // Entertainment
  if (desc.includes('cinema') || desc.includes('netflix') || desc.includes('spotify') ||
      desc.includes('amazon prime') || desc.includes('disney') || desc.includes('game') ||
      desc.includes('steam') || desc.includes('xbox') || desc.includes('playstation') ||
      desc.includes('movie') || desc.includes('theatre') || desc.includes('concert')) {
    return 'Entertainment';
  }
  
  // Shopping
  if (desc.includes('amazon') || desc.includes('ebay') || desc.includes('argos') ||
      desc.includes('john lewis') || desc.includes('marks spencer') || desc.includes('next') ||
      desc.includes('h&m') || desc.includes('zara') || desc.includes('shop') ||
      desc.includes('retail') || desc.includes('clothing') || desc.includes('fashion')) {
    return 'Shopping';
  }
  
  // Utilities
  if (desc.includes('electric') || desc.includes('gas') || desc.includes('water') ||
      desc.includes('british gas') || desc.includes('eon') || desc.includes('bulb') ||
      desc.includes('octopus') || desc.includes('thames water') || desc.includes('bt') ||
      desc.includes('virgin') || desc.includes('sky') || desc.includes('vodafone') ||
      desc.includes('ee') || desc.includes('o2') || desc.includes('three')) {
    return 'Utilities';
  }
  
  // Healthcare
  if (desc.includes('pharmacy') || desc.includes('boots') || desc.includes('hospital') ||
      desc.includes('doctor') || desc.includes('dentist') || desc.includes('medical') ||
      desc.includes('health') || desc.includes('prescription') || desc.includes('nhs')) {
    return 'Healthcare';
  }
  
  return 'Other';
};

export const getCategoryColor = (category: string): string => {
  const colorMap: Record<string, string> = {
    'Food & Dining': 'bg-orange-100 text-orange-800',
    'Transportation': 'bg-yellow-100 text-yellow-800',
    'Entertainment': 'bg-blue-100 text-blue-800',
    'Shopping': 'bg-purple-100 text-purple-800',
    'Utilities': 'bg-cyan-100 text-cyan-800',
    'Healthcare': 'bg-green-100 text-green-800',
    'Education': 'bg-indigo-100 text-indigo-800',
    'Travel': 'bg-pink-100 text-pink-800',
    'Insurance': 'bg-red-100 text-red-800',
    'Other': 'bg-gray-100 text-gray-800'
  };
  
  return colorMap[category] || colorMap['Other'];
};