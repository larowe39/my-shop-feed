// lib/supabase.ts
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://yinqxqoaeguojakesrrb.supabase.co";
const SUPABASE_ANON_KEY = "sb_secret_U3D7rurVRlDu6Qq5MFMdSw_yswVZfC3";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
