// src/dev/exposeSupabase.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { supabase } from '@/integrations/supabase/client';

declare global {
  interface Window {
    supabase: SupabaseClient<Database>;
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
  }
}

// Dev-only: expose the client (and optionally env values) to the console.
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  window.supabase = supabase;

  // Optional: only if you want to call Edge Functions via raw fetch from DevTools.
  // These are typical Vite env names—if you don't have them, it's fine to leave undefined.
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (url) window.SUPABASE_URL = url;
  if (key) window.SUPABASE_ANON_KEY = key;
}

export {}; // make this a module
