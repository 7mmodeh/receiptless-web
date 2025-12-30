// app/r/[tokenId]/page.tsx
export const dynamic = "force-dynamic";

type PreviewItem = {
  line_no: number;
  sku: string | null;
  name: string;
  qty: number;
  unit_price: number;
  line_total: number;
  vat_rate: number | null;
  vat_amount: number | null;
};

type TokenPreviewResponse = {
  token: {
    token_id: string;
    status: "active" | "consumed";
    consumed_at: string | null;
  };
  receipt: {
    issued_at: string;
    retailer_id: string;
    store_id: string;
    currency: string;
    subtotal: number;
    vat_total: number;
    total: number;
    items: PreviewItem[];
  };
};

async function fetchPreview(tokenId: string): Promise<TokenPreviewResponse> {
  const base = process.env.NEXT_PUBLIC_FUNCTIONS_BASE_URL;
  if (!base) throw new Error("Missing NEXT_PUBLIC_FUNCTIONS_BASE_URL");

  const url = `${base}/token-preview?token_id=${encodeURIComponent(tokenId)}`;
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json();

  if (!res.ok) {
    const msg = json?.error || `Preview failed (${res.status})`;
    throw new Error(msg);
  }

  return json as TokenPreviewResponse;
}

export default async function ReceiptPage({
  params,
}: {
  params: { tokenId: string };
}) {
  const tokenId = String(params.tokenId || "").trim();

  let data: TokenPreviewResponse;
  try {
    data = await fetchPreview(tokenId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";

    return (
      <main
        style={{
          padding: 24,
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 800 }}>Receiptless</h1>
        <p style={{ marginTop: 12, fontWeight: 700 }}>
          Could not load receipt.
        </p>
        <p style={{ marginTop: 6, color: "#555" }}>{message}</p>
      </main>
    );
  }

  const { token, receipt } = data;
  const deepLink = `receiptless://r/${tokenId}`;

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 720,
        margin: "0 auto",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0 }}>
          Receiptless
        </h1>
        <a
          href={deepLink}
          style={{
            display: "inline-block",
            padding: "10px 14px",
            borderRadius: 12,
            background: "#111",
            color: "white",
            textDecoration: "none",
            fontWeight: 800,
          }}
        >
          Open in app
        </a>
      </header>

      <section
        style={{
          marginTop: 16,
          border: "1px solid #ddd",
          borderRadius: 14,
          padding: 14,
        }}
      >
        <div style={{ fontSize: 12, color: "#666", fontWeight: 700 }}>
          Token Status
        </div>
        <div style={{ fontSize: 16, fontWeight: 800 }}>{token.status}</div>

        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            color: "#666",
            fontWeight: 700,
          }}
        >
          Issued At
        </div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          {new Date(receipt.issued_at).toLocaleString()}
        </div>

        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            color: "#666",
            fontWeight: 700,
          }}
        >
          Total
        </div>
        <div style={{ fontSize: 28, fontWeight: 900 }}>
          {receipt.currency} {Number(receipt.total).toFixed(2)}
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: "#666", fontWeight: 700 }}>
              Subtotal
            </div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>
              {receipt.currency} {Number(receipt.subtotal).toFixed(2)}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: "#666", fontWeight: 700 }}>
              VAT
            </div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>
              {receipt.currency} {Number(receipt.vat_total).toFixed(2)}
            </div>
          </div>
        </div>

        {token.consumed_at ? (
          <>
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: "#666",
                fontWeight: 700,
              }}
            >
              Consumed At
            </div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>
              {new Date(token.consumed_at).toLocaleString()}
            </div>
          </>
        ) : null}
      </section>

      <h2 style={{ marginTop: 18, fontSize: 16, fontWeight: 900 }}>Items</h2>
      <section
        style={{ border: "1px solid #ddd", borderRadius: 14, padding: 12 }}
      >
        {receipt.items.map((it) => (
          <div
            key={it.line_no}
            style={{
              display: "flex",
              gap: 12,
              padding: "10px 0",
              borderBottom: "1px solid #eee",
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 900 }}>{it.name}</div>
              <div style={{ color: "#666", fontSize: 12, marginTop: 4 }}>
                Qty {Number(it.qty)} · {receipt.currency}{" "}
                {Number(it.unit_price).toFixed(2)}
                {it.sku ? ` · ${it.sku}` : ""}
              </div>
            </div>
            <div style={{ fontWeight: 900 }}>
              {receipt.currency} {Number(it.line_total).toFixed(2)}
            </div>
          </div>
        ))}
      </section>

      <p style={{ marginTop: 16, fontSize: 12, color: "#666" }}>
        Token ID: {token.token_id}
      </p>
    </main>
  );
}
