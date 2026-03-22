import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const MT5_API_URL = "https://mt5.mtapi.io";
const MAX_RETRIES = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 7000;
const CONNECT_REQUEST_TIMEOUT_MS = 20000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function parseApiResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { result: text.trim() };
  }
}

function hasInvalidStopsError(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const payload = data as Record<string, unknown>;
  const code = String(payload.code || "").toUpperCase();
  const message = String(payload.message || "").toLowerCase();
  return code === "INVALID_STOPS" || message.includes("invalid stops");
}

// Map timeframe strings to MT5 integer values
function timeframeToInt(tf: string): number {
  const map: Record<string, number> = {
    "1m": 1, "2m": 2, "3m": 3, "4m": 4, "5m": 5,
    "6m": 6, "10m": 10, "12m": 12, "15m": 15, "20m": 20, "30m": 30,
    "1h": 60, "2h": 120, "3h": 180, "4h": 240, "6h": 360, "8h": 480, "12h": 720,
    "1d": 1440, "1w": 10080, "1mn": 43200,
  };
  return map[tf] || parseInt(tf) || 1;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        return response;
      }

      const errorText = await response.text();
      console.error(`Attempt ${attempt} failed with status ${response.status}: ${errorText}`);
    } catch (err) {
      clearTimeout(timeoutId);
      console.error(`Attempt ${attempt} error:`, err);
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }

  throw new Error("MT5 request failed after retries");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    // CONNECT
    if (action === "connect") {
      const { credentials } = body;
      const url = `${MT5_API_URL}/Connect?user=${encodeURIComponent(credentials.login)}&password=${encodeURIComponent(credentials.password)}&host=${encodeURIComponent(credentials.host)}&port=${credentials.port || 443}`;
      const response = await fetchWithRetry(url, { method: "GET" }, CONNECT_REQUEST_TIMEOUT_MS);
      const connectionId = await response.text();
      return new Response(JSON.stringify({ connectionId: connectionId.trim() }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACCOUNT INFO
    if (action === "accountInfo") {
      const { connectionId } = body;
      const response = await fetchWithRetry(
        `${MT5_API_URL}/AccountSummary?id=${encodeURIComponent(connectionId)}`,
        { method: "GET" },
        DEFAULT_REQUEST_TIMEOUT_MS
      );
      const data = await parseApiResponse(response);
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // SYMBOLS
    if (action === "symbols") {
      const { connectionId } = body;
      const response = await fetchWithRetry(
        `${MT5_API_URL}/SymbolList?id=${encodeURIComponent(connectionId)}`,
        { method: "GET" },
        DEFAULT_REQUEST_TIMEOUT_MS
      );
      const data = await parseApiResponse(response);
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // SUBSCRIBE
    if (action === "subscribe") {
      const { connectionId, symbol } = body;
      const response = await fetchWithRetry(
        `${MT5_API_URL}/Subscribe?id=${encodeURIComponent(connectionId)}&symbol=${encodeURIComponent(symbol)}`,
        { method: "GET" },
        DEFAULT_REQUEST_TIMEOUT_MS
      );
      const text = await response.text();
      return new Response(JSON.stringify({ result: text.trim() }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // TICK DATA
    if (action === "tick") {
      const { connectionId, symbol } = body;
      const response = await fetchWithRetry(
        `${MT5_API_URL}/GetQuote?id=${encodeURIComponent(connectionId)}&symbol=${encodeURIComponent(symbol)}`,
        { method: "GET" },
        DEFAULT_REQUEST_TIMEOUT_MS
      );
      const data = await parseApiResponse(response);
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // CANDLES / PRICE HISTORY
    if (action === "candles") {
      const { connectionId, symbol, timeframe } = body;
      const tfInt = timeframeToInt(timeframe || "1m");
      const url = `${MT5_API_URL}/PriceHistoryToday?id=${encodeURIComponent(connectionId)}&symbol=${encodeURIComponent(symbol)}&timeFrame=${tfInt}`;
      console.log("Fetching candles:", url);
      const response = await fetchWithRetry(url, { method: "GET" }, DEFAULT_REQUEST_TIMEOUT_MS);
      const data = await parseApiResponse(response);
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // TRADE
    if (action === "trade") {
      const { connectionId, symbol, type, volume, tp, sl } = body;
      const numericVolume = Number(volume);
      if (!Number.isFinite(numericVolume) || numericVolume <= 0) {
        return new Response(JSON.stringify({ error: "Invalid trade volume" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const operation = String(type).toLowerCase() === "sell" ? "Sell" : "Buy";
      const tpNum = Number(tp);
      const slNum = Number(sl);
      const hasStops = (Number.isFinite(tpNum) && tpNum > 0) || (Number.isFinite(slNum) && slNum > 0);

      const sendOrder = async (includeStops: boolean) => {
        let url = `${MT5_API_URL}/OrderSend?id=${encodeURIComponent(connectionId)}&symbol=${encodeURIComponent(symbol)}&operation=${encodeURIComponent(operation)}&volume=${encodeURIComponent(String(numericVolume))}`;
        if (includeStops && Number.isFinite(tpNum) && tpNum > 0) {
          url += `&takeProfit=${encodeURIComponent(String(tpNum))}`;
        }
        if (includeStops && Number.isFinite(slNum) && slNum > 0) {
          url += `&stopLoss=${encodeURIComponent(String(slNum))}`;
        }

        console.log("Trade URL:", url);
        const response = await fetchWithRetry(url, { method: "GET" }, DEFAULT_REQUEST_TIMEOUT_MS);
        return parseApiResponse(response);
      };

      let data = await sendOrder(hasStops);

      // Fallback: some brokers reject TP/SL format on market orders; retry without stops.
      if (hasStops && hasInvalidStopsError(data)) {
        const retryData = await sendOrder(false);
        if (retryData && typeof retryData === "object") {
          data = { ...(retryData as Record<string, unknown>), retriedWithoutStops: true };
        } else {
          data = { result: retryData, retriedWithoutStops: true };
        }
      }

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Edge function error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
