import express from "express";

const app = express();
app.use(express.json({ limit: "256kb" }));

// ---------- CONFIG (merchant-owned backend) ----------
const RECEIPTLESS_INGEST_URL =
  "https://bkfhpmypgerbyrafijwv.supabase.co/functions/v1/receipt-ingest";

/**
 * Store terminal keys ONLY on backend
 * key format: `${store_id}:${terminal_code}`
 */
const TERMINAL_KEYS = {
  "c3fde414-fdf9-4c50-aaea-004a10fe50ec:TEST-001":
    process.env.TERMINAL_KEY_TEST_001 ?? "",
};

function getTerminalKey(store_id, terminal_code) {
  const key = TERMINAL_KEYS[`${store_id}:${terminal_code}`];
  return typeof key === "string" ? key.trim() : "";
}

app.post("/pos/checkout-success", async (req, res) => {
  try {
    const payload = req.body ?? {};

    const store_id = String(payload.store_id || "").trim();
    const terminal_code = String(payload.terminal_code || "").trim();

    if (!store_id || !terminal_code) {
      return res.status(400).json({
        error: "Missing store_id or terminal_code",
        fallback: "PRINT_RECEIPT",
      });
    }

    const terminalKey = getTerminalKey(store_id, terminal_code);
    if (!terminalKey) {
      return res.status(401).json({
        error: "Unknown terminal",
        fallback: "PRINT_RECEIPT",
      });
    }

    const resp = await fetch(RECEIPTLESS_INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-terminal-key": terminalKey,
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => null);

    if (!resp.ok) {
      return res.status(502).json({
        error: "Receiptless unavailable",
        details: data?.error ?? data?.message ?? "Unknown error",
        fallback: "PRINT_RECEIPT",
      });
    }

    return res.status(200).json({
      token_id: data.token_id,
      public_url: data.public_url,
      qr_url: data.qr_url,
      preview_url: data.preview_url ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      error: "Merchant backend error",
      details: message,
      fallback: "PRINT_RECEIPT",
    });
  }
});

const PORT = process.env.PORT ?? 8080;
app.listen(PORT, () => {
  console.log(`Merchant backend listening on :${PORT}`);
});
