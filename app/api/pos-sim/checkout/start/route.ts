import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // server-only
);

export async function POST(req: Request) {
  const body = await req.json();
  const { session_id, amount_cents, currency = "EUR", payment_method = "card" } = body;

  if (!session_id || !amount_cents) {
    return NextResponse.json({ ok: false, error: "Missing session_id or amount_cents" }, { status: 400 });
  }

  // 1) Update session
  const { error: updErr } = await supabase
    .from("pos_sim_sessions")
    .update({
      checkout_amount_cents: amount_cents,
      checkout_currency: currency,
      payment_status: "payment_pending",
      payment_failure_code: null,
      payment_failure_message: null,
      payment_reference: null,
      paid_at: null,
      status: "payment_pending",
    })
    .eq("session_id", session_id);

  if (updErr) {
    return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
  }

  // 2) Write timeline events
  await supabase.from("pos_sim_events").insert([
    { session_id, event_type: "CHECKOUT_STARTED", payload: { amount_cents, currency, payment_method } },
    { session_id, event_type: "PAYMENT_PENDING", payload: { provider: "simulator" } },
  ]);

  return NextResponse.json({ ok: true, session_id, status: "payment_pending" });
}
