import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// 프런트엔드에는 공개(publishable) 키만 둔다. 비밀키·서비스 키는 이 저장소 어디에도 두지 않는다.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// 로그인 세션은 브라우저(localStorage)에만 두고 서버 쪽 저장·서비스 워커 캐시에는 넣지 않는다.
export const supabase: SupabaseClient | null =
  url && key ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;

export const supabaseConfigured = supabase !== null;
