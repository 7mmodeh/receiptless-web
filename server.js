import express, { json } from "express";

const app = express();
app.use(json({ limit: "256kb" }));

// ---------- CONFIG (merchant-owned backend) ----------
const RECEIPTLESS_INGEST_URL =
  "https://bkfhpmypgerbyrafijwv.supabase.co/functions/v1/receipt-ingest";

// Store terminal keys securely on the merchant backend only.
// Map (store_id + terminal_code) -> terminal key
const TERMINAL_KEYS = {
  "c3fde414-fdf9-4c50-aaea-004a10fe50ec:TEST-001":
    process.env.TERMINAL_KEY_TEST_001 || "",
};

function keyFor(store_id, terminal_code) {
  const k = TERMINAL_KEYS[`${store_id}:${terminal_code}`];
  return typeof k === "string" ? k.trim() : "";
}

// POS sends receipt data here after payment succeeds
app.post("/pos/checkout-success", async (req, res) => {
  try {
    const body = req.body || {};

    // Minimal validation (merchant may add more)
    const store_id = String(body.store_id || "").trim();
    const terminal_code = String(body.terminal_code || "").trim();
    if (!store_id || !terminal_code) {
      return res.status(400).json({ error: "Missing store_id or terminal_code" });
    }

    const terminalKey = keyFor(store_id, terminal_code);
    if (!terminalKey) {
      return res.status(401).json({ error: "Unknown terminal or missing terminal key" });
    }

    // Forward to Receiptless receipt-ingest
    const resp = await fetch(RECEIPTLESS_INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-terminal-key": terminalKey,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json().catch(() => null);

    if (!resp.ok) {
      const msg =
        (data && (data.error || data.message)) ||
        `receipt-ingest failed (${resp.status})`;

      // IMPORTANT: your POS fallback is print on any error
      return res.status(502).json({
        error: "Receiptless unavailable",
        details: String(msg),
        fallback: "PRINT_RECEIPT",
      });
    }

    // Success: return token/public_url to POS
    // POS will display QR and optionally still print a short stub
    return res.status(200).json({
      token_id: data.token_id,
      public_url: data.public_url,
      qr_url: data.qr_url,
      preview_url: data.preview_url,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: "Backend error", details: msg, fallback: "PRINT_RECEIPT" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Merchant backend listening on :${port}`));
