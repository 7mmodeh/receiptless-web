import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function bad(status: number, error: string, details?: unknown) {
  return NextResponse.json({ ok: false, error, ...(details ? { details } : {}) }, { status });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { session_id?: string; snapshot?: unknown } | null;
  if (!body?.session_id) return bad(400, "Missing session_id");
  if (!body?.snapshot) return bad(400, "Missing snapshot");

  const { error } = await supabase
    .from("pos_sim_snapshots")
    .upsert({ session_id: body.session_id, snapshot: body.snapshot, updated_at: new Date().toISOString() });

  if (error) return bad(500, "Upsert failed", error.message);

  return NextResponse.json({ ok: true }, { status: 200 });
}
