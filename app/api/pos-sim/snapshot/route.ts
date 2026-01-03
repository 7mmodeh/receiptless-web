import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function bad(status: number, error: string, details?: unknown) {
  return NextResponse.json(
    { ok: false, error, ...(details ? { details } : {}) },
    { status }
  );
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const session_id = url.searchParams.get("session_id");
    if (!session_id) return bad(400, "Missing session_id");

    const supabaseUrl =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl) return bad(500, "Missing SUPABASE_URL");
    if (!serviceRoleKey) return bad(500, "Missing SUPABASE_SERVICE_ROLE_KEY");

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabase
      .from("pos_sim_snapshots")
      .select("snapshot, updated_at")
      .eq("session_id", session_id)
      .single();

    if (error) return bad(404, "Snapshot not found for session_id", error.message);

    return NextResponse.json(
      { ok: true, snapshot: data.snapshot, updated_at: data.updated_at },
      { status: 200 }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return bad(500, "Unhandled error", msg);
  }
}
