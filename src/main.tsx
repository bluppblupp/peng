import { createRoot } from 'react-dom/client'
import { CurrencyProvider } from './contexts/CurrencyContext'
import App from './App.tsx'
import './index.css'

createRoot(document.getElementById("root")!).render(
  <CurrencyProvider>
    <App />
  </CurrencyProvider>
);
