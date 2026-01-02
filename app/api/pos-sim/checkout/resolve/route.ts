import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type Outcome = "success" | "fail" | "cancelled";

export async function POST(req: Request) {
  const body = await req.json();
  const {
    session_id,
    outcome,
    payment_reference,
    failure_code,
    failure_message,
  }: {
    session_id: string;
    outcome: Outcome;
    payment_reference?: string;
    failure_code?: string;
    failure_message?: string;
  } = body;

  if (!session_id || !outcome) {
    return NextResponse.json({ ok: false, error: "Missing session_id or outcome" }, { status: 400 });
  }

  // Fetch current status to avoid illegal transitions
  const { data: sess, error: sessErr } = await supabase
    .from("pos_sim_sessions")
    .select("status, payment_status")
    .eq("session_id", session_id)
    .single();

  if (sessErr) {
    return NextResponse.json({ ok: false, error: sessErr.message }, { status: 500 });
  }

  if (sess?.status !== "payment_pending") {
    return NextResponse.json(
      { ok: false, error: `Cannot resolve payment from status=${sess?.status}` },
      { status: 409 }
    );
  }

  if (outcome === "success") {
    const ref = payment_reference || `SIM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const { error: updErr } = await supabase
      .from("pos_sim_sessions")
      .update({
        payment_status: "payment_succeeded",
        payment_reference: ref,
        paid_at: new Date().toISOString(),
        status: "payment_succeeded",
        payment_failure_code: null,
        payment_failure_message: null,
      })
      .eq("session_id", session_id);

    if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });

    await supabase.from("pos_sim_events").insert({
      session_id,
      event_type: "PAYMENT_SUCCESS",
      payload: { payment_reference: ref },
    });

    return NextResponse.json({
      ok: true,
      status: "payment_succeeded",
      payment_reference: ref,
      next: { action: "issue_receipt", endpoint: "/api/pos-sim/issue-receipt" },
    });
  }

  if (outcome === "fail") {
    const code = failure_code || "declined";
    const msg = failure_message || "Payment declined";

    const { error: updErr } = await supabase
      .from("pos_sim_sessions")
      .update({
        payment_status: "payment_failed",
        payment_failure_code: code,
        payment_failure_message: msg,
        status: "payment_failed",
      })
      .eq("session_id", session_id);

    if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });

    await supabase.from("pos_sim_events").insert({
      session_id,
      event_type: "PAYMENT_FAILED",
      payload: { failure_code: code, failure_message: msg },
    });

    return NextResponse.json({ ok: true, status: "payment_failed", failure_code: code, failure_message: msg });
  }

  // cancelled
  const { error: updErr } = await supabase
    .from("pos_sim_sessions")
    .update({
      payment_status: "payment_cancelled",
      status: "payment_cancelled",
    })
    .eq("session_id", session_id);

  if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });

  await supabase.from("pos_sim_events").insert({
    session_id,
    event_type: "PAYMENT_CANCELLED",
    payload: {},
  });

  return NextResponse.json({ ok: true, status: "payment_cancelled" });
}
