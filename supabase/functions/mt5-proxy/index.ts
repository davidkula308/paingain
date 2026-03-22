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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function toFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractTicket(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const direct = Number(value.trim());
    if (Number.isFinite(direct)) return direct;

    const matched = value.match(/\b(\d{4,})\b/);
    if (matched) return Number(matched[1]);
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const ticket = extractTicket(item);
      if (ticket) return ticket;
    }
    return undefined;
  }

  const payload = asRecord(value);
  if (!payload) return undefined;

  for (const key of ["ticket", "Ticket", "order", "Order", "orderTicket", "positionId", "deal", "result", "id"]) {
    const ticket = extractTicket(payload[key]);
    if (ticket) return ticket;
  }

  return undefined;
}

function normalizeTradeSide(value: unknown): "Buy" | "Sell" | undefined {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("buy")) return "Buy";
  if (normalized.includes("sell")) return "Sell";
  return undefined;
}

type OpenOrderSnapshot = {
  ticket: number;
  symbol: string;
  lots: number;
  openPrice: number;
  operation: "Buy" | "Sell";
};

function toOpenOrderSnapshot(order: unknown): OpenOrderSnapshot | null {
  const payload = asRecord(order);
  if (!payload) return null;

  const ticket = extractTicket(payload.ticket ?? payload.Ticket ?? payload.order ?? payload.Order ?? payload.positionId);
  const symbol = String(payload.symbol ?? payload.Symbol ?? "").trim();
  const lots = toFiniteNumber(payload.lots ?? payload.Lots ?? payload.volume ?? payload.Volume);
  const openPrice = toFiniteNumber(payload.openPrice ?? payload.OpenPrice ?? payload.price ?? payload.Price);
  const operation = normalizeTradeSide(payload.type ?? payload.Type ?? payload.operation ?? payload.Operation ?? payload.orderType ?? payload.OrderType);

  if (!ticket || !symbol || lots === undefined || openPrice === undefined || !operation) {
    return null;
  }

  return { ticket, symbol, lots, openPrice, operation };
}

async function getOpenedOrderByTicket(connectionId: string, ticket: number): Promise<OpenOrderSnapshot | null> {
  const response = await fetchWithRetry(
    `${MT5_API_URL}/OpenedOrder?id=${encodeURIComponent(connectionId)}&ticket=${encodeURIComponent(String(ticket))}`,
    { method: "GET" },
    DEFAULT_REQUEST_TIMEOUT_MS
  );
  return toOpenOrderSnapshot(await parseApiResponse(response));
}

async function findLatestOpenedOrder(
  connectionId: string,
  symbol: string,
  operation: "Buy" | "Sell",
  volume: number
): Promise<OpenOrderSnapshot | null> {
  const response = await fetchWithRetry(
    `${MT5_API_URL}/OpenedOrders?id=${encodeURIComponent(connectionId)}`,
    { method: "GET" },
    DEFAULT_REQUEST_TIMEOUT_MS
  );

  const data = await parseApiResponse(response);
  if (!Array.isArray(data)) return null;

  const matched = data
    .map(toOpenOrderSnapshot)
    .filter((order): order is OpenOrderSnapshot => Boolean(order))
    .filter((order) => order.symbol === symbol && order.operation === operation && Math.abs(order.lots - volume) < 1e-8)
    .sort((a, b) => b.ticket - a.ticket);

  return matched[0] ?? null;
}

async function applyStopsToOpenedOrder(
  connectionId: string,
  order: OpenOrderSnapshot,
  tp?: number,
  sl?: number
): Promise<unknown> {
  let url = `${MT5_API_URL}/OrderModifySafe?id=${encodeURIComponent(connectionId)}&ticket=${encodeURIComponent(String(order.ticket))}&symbol=${encodeURIComponent(order.symbol)}&lots=${encodeURIComponent(String(order.lots))}&price=${encodeURIComponent(String(order.openPrice))}&type=${encodeURIComponent(order.operation)}`;

  if (tp !== undefined && Number.isFinite(tp) && tp > 0) {
    url += `&tp=${encodeURIComponent(String(tp))}`;
  }
  if (sl !== undefined && Number.isFinite(sl) && sl > 0) {
    url += `&sl=${encodeURIComponent(String(sl))}`;
  }

  console.log("Modify URL:", url);
  const response = await fetchWithRetry(url, { method: "GET" }, DEFAULT_REQUEST_TIMEOUT_MS);
  return parseApiResponse(response);
}

async function waitForOpenedOrder(
  connectionId: string,
  symbol: string,
  operation: "Buy" | "Sell",
  volume: number,
  openedTicket?: number
): Promise<OpenOrderSnapshot | null> {
  const attempts = 8;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (openedTicket) {
      const byTicket = await getOpenedOrderByTicket(connectionId, openedTicket);
      if (byTicket) return byTicket;
    }

    const latestMatch = await findLatestOpenedOrder(connectionId, symbol, operation, volume);
    if (latestMatch) return latestMatch;

    await new Promise((resolve) => setTimeout(resolve, 500 + attempt * 250));
  }

  return null;
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

      const sendOrder = async () => {
        const url = `${MT5_API_URL}/OrderSendSafe?id=${encodeURIComponent(connectionId)}&symbol=${encodeURIComponent(symbol)}&operation=${encodeURIComponent(operation)}&volume=${encodeURIComponent(String(numericVolume))}`;
        console.log("Trade URL:", url);
        const response = await fetchWithRetry(url, { method: "GET" }, DEFAULT_REQUEST_TIMEOUT_MS);
        return parseApiResponse(response);
      };

      const openedOrderResult = await sendOrder();
      const responsePayload = asRecord(openedOrderResult)
        ? { ...(openedOrderResult as Record<string, unknown>) }
        : { result: openedOrderResult };

      if (hasStops) {
        const openedTicket = extractTicket(openedOrderResult);
        const orderSnapshot = await waitForOpenedOrder(connectionId, symbol, operation, numericVolume, openedTicket);

        if (orderSnapshot) {
          try {
            const modifyResult = await applyStopsToOpenedOrder(connectionId, orderSnapshot, tpNum, slNum);
            responsePayload.ticket = orderSnapshot.ticket;
            responsePayload.stopsApplied = true;
            responsePayload.modifyResult = modifyResult;
          } catch (modifyError) {
            console.error("Failed to apply TP/SL after order open:", modifyError);
            responsePayload.ticket = orderSnapshot.ticket;
            responsePayload.stopsApplied = false;
            responsePayload.warning = modifyError instanceof Error
              ? modifyError.message
              : "Trade opened, but TP/SL modification failed";
          }
        } else {
          responsePayload.stopsApplied = false;
          responsePayload.warning = "Trade opened, but the new position could not be resolved for TP/SL update";
        }
      }

      return new Response(JSON.stringify(responsePayload), {
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
