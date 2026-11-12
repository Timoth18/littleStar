import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const missing = Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SUPABASE_SERVICE_KEY,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

const serverAuthOptions = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
};

// Service-role client — bypasses RLS, used for trusted server operations.
// Never sign a user in on this client: it would swap its credentials.
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: serverAuthOptions,
});

// User-scoped client — respects RLS, used for user-authenticated requests
export const supabaseUser = (token) =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: serverAuthOptions,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

// Throwaway anon client for sign-in and token refresh
export const supabaseAuth = () =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: serverAuthOptions });
