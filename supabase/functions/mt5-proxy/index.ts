import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const MT5_API_URL = "https://mt5.mtapi.io";
const MAX_RETRIES = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 7000;
const CONNECT_REQUEST_TIMEOUT_MS = 20000;
const PRICE_TOLERANCE = 1e-6;

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
  openedAt?: number;
  stopLoss?: number;
  takeProfit?: number;
};

function normalizeSymbol(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric > 1e12 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

function toOpenOrderSnapshot(order: unknown): OpenOrderSnapshot | null {
  const payload = asRecord(order);
  if (!payload) return null;

  const ticket = extractTicket(payload.ticket ?? payload.Ticket ?? payload.order ?? payload.Order ?? payload.positionId);
  const symbol = String(payload.symbol ?? payload.Symbol ?? "").trim();
  const lots = toFiniteNumber(payload.lots ?? payload.Lots ?? payload.volume ?? payload.Volume);
  const openPrice = toFiniteNumber(payload.openPrice ?? payload.OpenPrice ?? payload.price ?? payload.Price);
  const operation = normalizeTradeSide(payload.type ?? payload.Type ?? payload.operation ?? payload.Operation ?? payload.orderType ?? payload.OrderType);
  const stopLoss = toFiniteNumber(payload.stopLoss ?? payload.StopLoss ?? payload.stoploss ?? payload.sl ?? payload.SL);
  const takeProfit = toFiniteNumber(payload.takeProfit ?? payload.TakeProfit ?? payload.takeprofit ?? payload.tp ?? payload.TP);
  const openedAt = parseTimestamp(
    payload.openTime ?? payload.OpenTime ?? payload.time ?? payload.Time ?? payload.date ?? payload.Date ?? payload.createdAt
  );

  if (!ticket || !symbol || lots === undefined || openPrice === undefined || !operation) {
    return null;
  }

  return { ticket, symbol, lots, openPrice, operation, openedAt, stopLoss, takeProfit };
}

function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(PRICE_TOLERANCE, Math.abs(a) * 1e-8, Math.abs(b) * 1e-8);
}

function hasExpectedStops(order: OpenOrderSnapshot | null, tp?: number, sl?: number): boolean {
  if (!order) return false;

  const expectsTp = Number.isFinite(tp) && Number(tp) > 0;
  const expectsSl = Number.isFinite(sl) && Number(sl) > 0;

  const tpMatches = !expectsTp || (order.takeProfit !== undefined && approximatelyEqual(order.takeProfit, Number(tp)));
  const slMatches = !expectsSl || (order.stopLoss !== undefined && approximatelyEqual(order.stopLoss, Number(sl)));

  return tpMatches && slMatches;
}

function isTradeFailurePayload(value: unknown): boolean {
  const payload = asRecord(value);
  if (!payload) return false;

  if (payload.error) return true;

  const code = String(payload.code ?? "").toUpperCase();
  const hasTicket = extractTicket(payload) !== undefined;
  if (!code) return false;
  if (["OK", "SUCCESS", "DONE", "PLACED"].includes(code)) return false;

  return !hasTicket;
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
  volume: number,
  requestedAt?: number
): Promise<OpenOrderSnapshot | null> {
  const response = await fetchWithRetry(
    `${MT5_API_URL}/OpenedOrders?id=${encodeURIComponent(connectionId)}`,
    { method: "GET" },
    DEFAULT_REQUEST_TIMEOUT_MS
  );

  const data = await parseApiResponse(response);
  if (!Array.isArray(data)) return null;

  const targetSymbol = normalizeSymbol(symbol);
  const matched = data
    .map(toOpenOrderSnapshot)
    .filter((order): order is OpenOrderSnapshot => Boolean(order))
    .filter((order) => normalizeSymbol(order.symbol) === targetSymbol && order.operation === operation)
    .sort((a, b) => {
      const aRecency = a.openedAt ?? a.ticket;
      const bRecency = b.openedAt ?? b.ticket;
      return bRecency - aRecency;
    });

  const exactVolumeMatch = matched.find((order) => Math.abs(order.lots - volume) < 1e-6);
  if (exactVolumeMatch) return exactVolumeMatch;

  const freshMatch = requestedAt
    ? matched.find((order) => order.openedAt !== undefined && order.openedAt >= requestedAt - 15000)
    : undefined;
  if (freshMatch) return freshMatch;

  return matched[0] ?? null;
}

async function applyStopsToOpenedOrder(
  connectionId: string,
  order: OpenOrderSnapshot,
  tp?: number,
  sl?: number
): Promise<unknown> {
  const takeProfit = Number.isFinite(tp) && Number(tp) > 0 ? Number(tp) : 0;
  const stopLoss = Number.isFinite(sl) && Number(sl) > 0 ? Number(sl) : 0;

  let url = `${MT5_API_URL}/OrderModifySafe?id=${encodeURIComponent(connectionId)}&ticket=${encodeURIComponent(String(order.ticket))}&stoploss=${encodeURIComponent(String(stopLoss))}&takeprofit=${encodeURIComponent(String(takeProfit))}`;

  if (Number.isFinite(order.openPrice) && order.openPrice > 0) {
    url += `&price=${encodeURIComponent(String(order.openPrice))}`;
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
  openedTicket?: number,
  requestedAt?: number,
  directOrder?: OpenOrderSnapshot | null
): Promise<OpenOrderSnapshot | null> {
  if (directOrder && normalizeSymbol(directOrder.symbol) === normalizeSymbol(symbol) && directOrder.operation === operation) {
    return directOrder;
  }

  const attempts = 20;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (openedTicket) {
      const byTicket = await getOpenedOrderByTicket(connectionId, openedTicket);
      if (byTicket) return byTicket;
    }

    const latestMatch = await findLatestOpenedOrder(connectionId, symbol, operation, volume, requestedAt);
    if (latestMatch) return latestMatch;

    await new Promise((resolve) => setTimeout(resolve, 700 + attempt * 250));
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
      const requestedAt = Date.now();

      const sendOrder = async () => {
        let url = `${MT5_API_URL}/OrderSendSafe?id=${encodeURIComponent(connectionId)}&symbol=${encodeURIComponent(symbol)}&operation=${encodeURIComponent(operation)}&volume=${encodeURIComponent(String(numericVolume))}`;
        if (Number.isFinite(slNum) && slNum > 0) {
          url += `&stoploss=${encodeURIComponent(String(slNum))}`;
        }
        if (Number.isFinite(tpNum) && tpNum > 0) {
          url += `&takeprofit=${encodeURIComponent(String(tpNum))}`;
        }
        console.log("Trade URL:", url);
        const response = await fetchWithRetry(url, { method: "GET" }, DEFAULT_REQUEST_TIMEOUT_MS);
        return parseApiResponse(response);
      };

      const openedOrderResult = await sendOrder();
      if (isTradeFailurePayload(openedOrderResult)) {
        const payload = asRecord(openedOrderResult) ?? {};
        const message = String(payload.message ?? payload.error ?? "Trade execution failed");
        return new Response(JSON.stringify({ ...payload, error: message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const responsePayload = asRecord(openedOrderResult)
        ? { ...(openedOrderResult as Record<string, unknown>) }
        : { result: openedOrderResult };

      if (hasStops) {
        const openedTicket = extractTicket(openedOrderResult);
        const directOrder = toOpenOrderSnapshot(openedOrderResult);

        if (hasExpectedStops(directOrder, tpNum, slNum)) {
          responsePayload.ticket = directOrder?.ticket;
          responsePayload.stopsApplied = true;
          return new Response(JSON.stringify(responsePayload), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const orderSnapshot = await waitForOpenedOrder(
          connectionId,
          symbol,
          operation,
          numericVolume,
          openedTicket,
          requestedAt,
          directOrder
        );

        if (orderSnapshot) {
          if (hasExpectedStops(orderSnapshot, tpNum, slNum)) {
            responsePayload.ticket = orderSnapshot.ticket;
            responsePayload.stopsApplied = true;
            return new Response(JSON.stringify(responsePayload), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          try {
            const modifyResult = await applyStopsToOpenedOrder(connectionId, orderSnapshot, tpNum, slNum);
            const verifiedOrder = await waitForOpenedOrder(
              connectionId,
              symbol,
              operation,
              numericVolume,
              orderSnapshot.ticket,
              requestedAt,
              null
            );

            responsePayload.ticket = orderSnapshot.ticket;
            responsePayload.stopsApplied = hasExpectedStops(verifiedOrder, tpNum, slNum);
            responsePayload.modifyResult = modifyResult;

            if (!responsePayload.stopsApplied) {
              responsePayload.warning = "Trade opened, but TP/SL could not be verified after modification";
            }
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
