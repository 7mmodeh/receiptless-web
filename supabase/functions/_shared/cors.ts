// supabase/functions/_shared/cors.ts

/// <reference lib="dom" />

/**
 * NOTE:
 * - This file is Deno-compatible (Supabase Edge Functions)
 * - No `any`
 * - No implicit `any`
 * - No TS config changes required
 */

export type CorsConfig = {
  allowHeaders: string;
  allowMethods: string;
  allowCredentials?: boolean;
};

type CorsOk = {
  ok: true;
  headers: Record<string, string>;
  origin: string | null;
};

type CorsErr = {
  ok: false;
  status: number;
  body: { ok: false; error: string; origin: string | null };
  headers: Record<string, string>;
};

type CorsResult = CorsOk | CorsErr;

function normalize(value: string): string {
  return value.trim();
}

function parseAllowedOrigins(): string[] {
  // Deno.env exists at runtime in Supabase Edge;
  // TS needs no special typing if lib.dom is enabled.
  const raw = (globalThis as unknown as { Deno?: { env: { get(k: string): string | undefined } } })
    .Deno?.env.get("ALLOWED_ORIGINS") ?? "";

  return raw
    .split(",")
    .map((v: string) => normalize(v))
    .filter((v: string) => v.length > 0);
}

function isOriginAllowed(origin: string, allowlist: string[]): boolean {
  return allowlist.includes(origin);
}

export function getOrigin(req: Request): string | null {
  const o = req.headers.get("origin");
  return o && o.trim().length > 0 ? o.trim() : null;
}

/**
 * RL-040 CORS hardening
 */
export function buildCorsHeaders(
  req: Request,
  cfg: CorsConfig
): CorsResult {
  const origin = getOrigin(req);
  const allowlist = parseAllowedOrigins();

  const baseHeaders: Record<string, string> = {
    "Vary": "Origin",
    "Access-Control-Allow-Headers": cfg.allowHeaders,
    "Access-Control-Allow-Methods": cfg.allowMethods,
  };

  // Server-to-server / POS (no Origin header)
  if (origin === null) {
    return {
      ok: true,
      origin: null,
      headers: {
        ...baseHeaders,
        "Access-Control-Allow-Origin": "*",
      },
    };
  }

  // Browser request: must be allow-listed
  if (!isOriginAllowed(origin, allowlist)) {
    return {
      ok: false,
      status: 403,
      body: {
        ok: false,
        error: "cors_forbidden",
        origin,
      },
      headers: {
        ...baseHeaders,
        "Access-Control-Allow-Origin": "null",
      },
    };
  }

  const headers: Record<string, string> = {
    ...baseHeaders,
    "Access-Control-Allow-Origin": origin,
  };

  if (cfg.allowCredentials !== false) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return {
    ok: true,
    origin,
    headers,
  };
}
