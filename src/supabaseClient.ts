import { createClient } from '@supabase/supabase-js';

const supabaseUrl = "https://bldsenlwhknswhpqizzg.supabase.co"; // ← replace!
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsZHNlbmx3aGtuc3docHFpenpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDc4MjE5NDcsImV4cCI6MjA2MzM5Nzk0N30.sh6FWF0R2UP5vzzySP4VV9MeGQsbkFR-H-XrkCijkwM"; // ← replace!
export const supabase = createClient(supabaseUrl, supabaseKey);