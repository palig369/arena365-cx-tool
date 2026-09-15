import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

// Service-role client: this backend runs server-side only and talks to Supabase
// with the service key, bypassing RLS. Never expose this key to a client.
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});
