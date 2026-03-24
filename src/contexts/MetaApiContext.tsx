import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const toNumber = (v: unknown) => Number(v) || 0;

const STORAGE_KEY = "mt5_credentials";
const WATCHLIST_KEY = "mt5_watchlist";
const AUTO_TRADE_ENABLED_KEY = "mt5_auto_trade_enabled_symbols";
const AUTO_TRADE_EXCLUDED_KEY = "mt5_auto_trade_excluded_symbols";
const SPIKE_TIMEFRAME = "1m";
const SPIKE_SCAN_INTERVAL_MS = 5000;
const MAX_STORED_SPIKES = 200;

// WelTrade SYNTX synthetic indices patterns
const SYNTHETIC_PATTERNS = [
  /pain\s*x/i,
  /gain\s*x/i,
  /painx/i,
  /gainx/i,
  /pain\s*\d+/i,
  /gain\s*\d+/i,
  /synthetic/i,
  /volatility/i,
  /boom/i,
  /crash/i,
  /step/i,
  /range/i,
  /jump/i,
];

function isSyntheticIndex(name: string): boolean {
  return SYNTHETIC_PATTERNS.some((p) => p.test(name));
}

function getAutoTradeDirection(symbol: string, spikeDirection: "bullish" | "bearish"): "buy" | "sell" {
  const sym = symbol.toLowerCase();
  if (/pain/i.test(sym)) return "buy";
  if (/gain/i.test(sym)) return "sell";
  return spikeDirection === "bullish" ? "sell" : "buy";
}

/** Extract the numeric index value from symbol name, e.g. "Pain X 1200" → 1200 */
function extractIndexNumber(symbol: string): number {
  const match = symbol.match(/(\d{2,})/);
  return match ? parseInt(match[1], 10) : 0;
}

function loadCredentials(): { login: string; password: string; server: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCredentials(login: string, password: string, server: string) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ login, password, server }));
}

function clearCredentials() {
  localStorage.removeItem(STORAGE_KEY);
}

function loadSavedWatchList(): string[] | null {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveWatchList(list: string[]) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
}

function loadStoredList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveStoredList(key: string, list: string[]) {
  localStorage.setItem(key, JSON.stringify(list));
}

interface AccountInfo {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
  leverage: number;
  currency: string;
  server: string;
  name: string;
}

interface TickData {
  symbol: string;
  bid: number;
  ask: number;
  time: string;
}

interface TradeExecutionResponse {
  error?: string;
  warning?: string;
  stopsApplied?: boolean;
  ticket?: number;
}

type ExitMode = "pips" | "candles";

interface SymbolTradingParams {
  digits: number;
  tickSize: number;
  spread: number;
}

interface CandleManagedTrade {
  ticket: number;
  symbol: string;
  type: "buy" | "sell";
  volume: number;
  timeframe: string;
  openedBucket: number;
  tpCandles: number;
  slCandles: number;
}

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SpikeEvent {
  symbol: string;
  direction: "bullish" | "bearish";
  percentage: number;
  timestamp: number;
  candle: Candle;
  key: string;
}

interface TradeResult {
  index: number;
  success: boolean;
  error?: string;
}

interface MetaApiContextType {
  isConnected: boolean;
  isConnecting: boolean;
  connectionId: string | null;
  accountInfo: AccountInfo | null;
  symbols: string[];
  syntheticSymbols: string[];
  watchList: string[];
  ticks: Record<string, TickData>;
  spikes: SpikeEvent[];
  autoTrade: boolean;
  autoTradeSymbols: string[];
  autoTradeExcludedSymbols: string[];
  lotSize: number;
  autoTradeLotSize: number;
  exitMode: ExitMode;
  takeProfit: number;
  stopLoss: number;
  tpCandles: number;
  slCandles: number;
  timeframe: string;
  connect: (login: string, password: string, server: string) => Promise<void>;
  disconnect: () => void;
  fetchAccountInfo: () => Promise<void>;
  fetchSymbols: () => Promise<void>;
  removeFromWatch: (symbol: string) => void;
  addToWatch: (symbol: string) => void;
  subscribeTick: (symbol: string) => void;
  fetchCandles: (symbol: string, tf?: string, count?: number) => Promise<Candle[]>;
  openPosition: (symbol: string, type: string, volume: number, tp?: number, sl?: number) => Promise<unknown>;
  openMultiplePositions: (symbol: string, type: string, volume: number, count: number, tp?: number, sl?: number) => Promise<TradeResult[]>;
  setAutoTrade: (v: boolean) => void;
  setAutoTradeSymbols: (v: string[]) => void;
  toggleAutoTradeSymbol: (symbol: string) => void;
  toggleAutoTradeExclusion: (symbol: string) => void;
  setLotSize: (v: number) => void;
  setAutoTradeLotSize: (v: number) => void;
  setExitMode: (v: ExitMode) => void;
  setTakeProfit: (v: number) => void;
  setStopLoss: (v: number) => void;
  setTpCandles: (v: number) => void;
  setSlCandles: (v: number) => void;
  setTimeframe: (v: string) => void;
  savedCredentials: { login: string; password: string; server: string } | null;
  error: string | null;
}

const MetaApiContext = createContext<MetaApiContextType | null>(null);

export const useMetaApi = () => {
  const ctx = useContext(MetaApiContext);
  if (!ctx) throw new Error("useMetaApi must be within MetaApiProvider");
  return ctx;
};

export const MetaApiProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [syntheticSymbols, setSyntheticSymbols] = useState<string[]>([]);
  const [watchList, setWatchList] = useState<string[]>([]);
  const [ticks, setTicks] = useState<Record<string, TickData>>({});
  const [spikes, setSpikes] = useState<SpikeEvent[]>([]);
  const [autoTrade, setAutoTrade] = useState(false);
  const [autoTradeSymbols, setAutoTradeSymbols] = useState<string[]>([]);
  const [autoTradeExcludedSymbols, setAutoTradeExcludedSymbols] = useState<string[]>(() => loadStoredList(AUTO_TRADE_EXCLUDED_KEY));
  const [lotSize, setLotSize] = useState(0.5);
  const [autoTradeLotSize, setAutoTradeLotSize] = useState(0.5);
  const [exitMode, setExitMode] = useState<ExitMode>("pips");
  const [takeProfit, setTakeProfit] = useState(5000);
  const [stopLoss, setStopLoss] = useState(8000);
  const [tpCandles, setTpCandles] = useState(3);
  const [slCandles, setSlCandles] = useState(1);
  const [timeframe, setTimeframe] = useState("1m");
  const [error, setError] = useState<string | null>(null);
  const tickIntervals = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const connectionIdRef = useRef<string | null>(null);
  const hasFetchedRef = useRef(false);
  const autoConnectAttempted = useRef(false);
  const processedSpikeKeysRef = useRef<Set<string>>(new Set());
  const activeAutoTradeSpikeKeyRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const symbolParamsCacheRef = useRef<Record<string, SymbolTradingParams>>({});
  const candleManagedTradesRef = useRef<CandleManagedTrade[]>([]);
  const closingTradeTicketsRef = useRef<Set<number>>(new Set());

  const [savedCredentials] = useState(() => loadCredentials());

  useEffect(() => {
    connectionIdRef.current = connectionId;
  }, [connectionId]);

  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
    };
  }, []);

  const fetchAccountInfoInternal = useCallback(async (connId: string) => {
    try {
      const { data, error: fnError } = await supabase.functions.invoke("mt5-proxy", {
        body: { action: "accountInfo", connectionId: connId },
      });
      if (fnError) throw fnError;
      setAccountInfo({
        balance: toNumber(data.balance),
        equity: toNumber(data.equity),
        margin: toNumber(data.margin),
        freeMargin: toNumber(data.freeMargin),
        marginLevel: toNumber(data.marginLevel),
        leverage: toNumber(data.leverage),
        currency: data.currency || "USD",
        server: data.server || "",
        name: data.name || "",
      });
    } catch (err: unknown) {
      console.error("Failed to fetch account info:", err);
    }
  }, []);

  const fetchSymbolsInternal = useCallback(async (connId: string) => {
    try {
      const { data, error: fnError } = await supabase.functions.invoke("mt5-proxy", {
        body: { action: "symbols", connectionId: connId },
      });
      if (fnError) throw fnError;

      let allSyms: string[] = [];

      if (Array.isArray(data)) {
        allSyms = data
          .map((s: unknown) =>
            typeof s === "string" ? s : (s as { name?: string; symbol?: string })?.name || (s as { name?: string; symbol?: string })?.symbol || ""
          )
          .filter(Boolean);
      } else if (data && typeof data === "object") {
        allSyms = Object.keys(data as Record<string, unknown>).filter(Boolean);
      }

      allSyms = Array.from(new Set(allSyms));
      setSymbols(allSyms);

      const synthetics = allSyms.filter(isSyntheticIndex);
      setSyntheticSymbols(synthetics);

      const fallbackWatch = synthetics.length > 0 ? synthetics : allSyms.slice(0, 12);
      const saved = loadSavedWatchList();
      if (saved && saved.length > 0) {
        const valid = saved.filter((s) => allSyms.includes(s));
        setWatchList(valid.length > 0 ? valid : fallbackWatch);
      } else {
        setWatchList(fallbackWatch);
      }

      setAutoTradeSymbols((prev) => {
        const stored = prev.length > 0 ? prev : loadStoredList(AUTO_TRADE_ENABLED_KEY);
        const validStored = stored.filter((s) => allSyms.includes(s));
        return validStored.length > 0 ? validStored : fallbackWatch;
      });
      setAutoTradeExcludedSymbols((prev) => {
        const stored = prev.length > 0 ? prev : loadStoredList(AUTO_TRADE_EXCLUDED_KEY);
        return stored.filter((s) => allSyms.includes(s));
      });
    } catch (err: unknown) {
      console.error("Failed to fetch symbols:", err);
    }
  }, []);

  // Persist watchlist changes
  useEffect(() => {
    if (watchList.length > 0) {
      saveWatchList(watchList);
    }
  }, [watchList]);

  useEffect(() => {
    saveStoredList(AUTO_TRADE_ENABLED_KEY, autoTradeSymbols);
  }, [autoTradeSymbols]);

  useEffect(() => {
    saveStoredList(AUTO_TRADE_EXCLUDED_KEY, autoTradeExcludedSymbols);
  }, [autoTradeExcludedSymbols]);

  // Auto-fetch once when connectionId becomes available
  useEffect(() => {
    if (connectionId && isConnected && !hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchAccountInfoInternal(connectionId);
      fetchSymbolsInternal(connectionId);
    }
    if (!isConnected) {
      hasFetchedRef.current = false;
    }
  }, [connectionId, isConnected, fetchAccountInfoInternal, fetchSymbolsInternal]);

  // Periodic account info refresh
  useEffect(() => {
    if (!connectionId || !isConnected) return;
    const interval = setInterval(() => {
      fetchAccountInfoInternal(connectionId);
    }, 15000);
    return () => clearInterval(interval);
  }, [connectionId, isConnected, fetchAccountInfoInternal]);

  const connect = useCallback(async (login: string, password: string, server: string) => {
    setIsConnecting(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke("mt5-proxy", {
        body: {
          action: "connect",
          credentials: { login, password, host: server, port: 443 },
        },
      });
      if (fnError) throw new Error(fnError.message);
      if (data?.error) throw new Error(data.error);
      const connId = data.id || data.connectionId || data;
      setConnectionId(connId);
      setIsConnected(true);
      saveCredentials(login, password, server);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Connection failed");
      throw err;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    Object.values(tickIntervals.current).forEach(clearInterval);
    tickIntervals.current = {};
    setIsConnected(false);
    setConnectionId(null);
    setAccountInfo(null);
    setSymbols([]);
    setSyntheticSymbols([]);
    setWatchList([]);
    setTicks({});
    setSpikes([]);
    candleManagedTradesRef.current = [];
    closingTradeTicketsRef.current.clear();
    symbolParamsCacheRef.current = {};
    clearCredentials();
    localStorage.removeItem(WATCHLIST_KEY);
  }, []);

  // Auto-reconnect from saved credentials on mount
  useEffect(() => {
    if (autoConnectAttempted.current) return;
    const creds = loadCredentials();
    if (creds) {
      autoConnectAttempted.current = true;
      connect(creds.login, creds.password, creds.server).catch(() => {});
    }
  }, [connect]);

  const fetchAccountInfo = useCallback(async () => {
    const connId = connectionIdRef.current;
    if (connId) await fetchAccountInfoInternal(connId);
  }, [fetchAccountInfoInternal]);

  const fetchSymbols = useCallback(async () => {
    const connId = connectionIdRef.current;
    if (connId) await fetchSymbolsInternal(connId);
  }, [fetchSymbolsInternal]);

  const removeFromWatch = useCallback((symbol: string) => {
    setWatchList((prev) => prev.filter((s) => s !== symbol));
    if (tickIntervals.current[symbol]) {
      clearInterval(tickIntervals.current[symbol]);
      delete tickIntervals.current[symbol];
    }
  }, []);

  const addToWatch = useCallback((symbol: string) => {
    setWatchList((prev) => (prev.includes(symbol) ? prev : [...prev, symbol]));
  }, []);

  const toggleAutoTradeSymbol = useCallback((symbol: string) => {
    setAutoTradeSymbols((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]
    );
  }, []);

  const toggleAutoTradeExclusion = useCallback((symbol: string) => {
    setAutoTradeExcludedSymbols((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]
    );
  }, []);

  const subscribeTick = useCallback(
    (symbol: string) => {
      const connId = connectionIdRef.current;
      if (!connId || tickIntervals.current[symbol]) return;

      const startPolling = () => {
        const poll = async () => {
          const currentConnId = connectionIdRef.current;
          if (!currentConnId) return;
          try {
            const { data } = await supabase.functions.invoke("mt5-proxy", {
              body: { action: "tick", connectionId: currentConnId, symbol },
            });
            if (data && (data.bid || data.ask)) {
              setTicks((prev) => ({
                ...prev,
                [symbol]: {
                  symbol,
                  bid: toNumber(data.bid),
                  ask: toNumber(data.ask),
                  time: data.time || new Date().toISOString(),
                },
              }));
            }
          } catch {}
        };
        poll();
        tickIntervals.current[symbol] = setInterval(poll, 2000);
      };

      supabase.functions.invoke("mt5-proxy", {
        body: { action: "subscribe", connectionId: connId, symbol },
      }).then(() => startPolling()).catch(() => startPolling());
    },
    []
  );

  const fetchCandles = useCallback(
    async (symbol: string, tf?: string, count?: number): Promise<Candle[]> => {
      const connId = connectionIdRef.current;
      if (!connId) return [];
      try {
        const { data } = await supabase.functions.invoke("mt5-proxy", {
          body: { action: "candles", connectionId: connId, symbol, timeframe: tf || timeframe },
        });
        if (Array.isArray(data)) {
          const bars = data.map((c: Record<string, unknown>) => ({
            time: String(c.time || c.Time || c.date || c.Date || c.datetime || c.DateTime || ""),
            open: toNumber(c.open ?? c.Open ?? c.openPrice ?? c.OpenPrice),
            high: toNumber(c.high ?? c.High ?? c.highPrice ?? c.HighPrice),
            low: toNumber(c.low ?? c.Low ?? c.lowPrice ?? c.LowPrice),
            close: toNumber(c.close ?? c.Close ?? c.closePrice ?? c.ClosePrice),
            volume: toNumber(c.volume ?? c.Volume ?? c.tickVolume ?? c.TickVolume),
          }));
          const sliceCount = count || 50;
          return bars.slice(-sliceCount);
        }
        return [];
      } catch {
        return [];
      }
    },
    [timeframe]
  );

  const playSpikeSound = useCallback(() => {
    if (typeof window === "undefined") return;
    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextCtor();
    }

    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const tones = [0, 0.14];
    tones.forEach((offset) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(860, ctx.currentTime + offset);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.13);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(ctx.currentTime + offset);
      oscillator.stop(ctx.currentTime + offset + 0.13);
    });
  }, []);

  const sendSpikeNotification = useCallback((spike: SpikeEvent) => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const directionLabel = spike.direction === "bullish" ? "Bullish" : "Bearish";
    const notification = new Notification(`Spike detected: ${spike.symbol}`, {
      body: `${directionLabel} 1M spike (${spike.percentage.toFixed(2)}%).`,
      tag: `spike-${spike.symbol}-${spike.candle.time}`,
    });

    window.setTimeout(() => notification.close(), 8000);
  }, []);

  const getLatestTick = useCallback(async (symbol: string): Promise<TickData | null> => {
    const existing = ticks[symbol];
    if (existing && Number.isFinite(existing.bid) && Number.isFinite(existing.ask)) {
      return existing;
    }

    const connId = connectionIdRef.current;
    if (!connId) return null;

    try {
      const { data, error: fnError } = await supabase.functions.invoke("mt5-proxy", {
        body: { action: "tick", connectionId: connId, symbol },
      });

      if (fnError || !data) return null;

      const fetchedTick: TickData = {
        symbol,
        bid: toNumber(data.bid),
        ask: toNumber(data.ask),
        time: data.time || new Date().toISOString(),
      };

      if (!fetchedTick.bid && !fetchedTick.ask) return null;

      setTicks((prev) => ({ ...prev, [symbol]: fetchedTick }));
      return fetchedTick;
    } catch {
      return null;
    }
  }, [ticks]);

  const countDecimals = useCallback((value: number) => {
    const text = String(value);
    if (!text.includes(".")) return 0;
    return text.split(".")[1]?.length ?? 0;
  }, []);

  const fetchSymbolParams = useCallback(async (symbol: string, tick?: TickData | null): Promise<SymbolTradingParams> => {
    const cached = symbolParamsCacheRef.current[symbol];
    if (cached) return cached;

    const fallbackDigits = Math.max(countDecimals(tick?.bid ?? 0), countDecimals(tick?.ask ?? 0));
    const fallbackTickSize = fallbackDigits > 0 ? 1 / 10 ** fallbackDigits : 1;
    const fallbackSpread = tick ? Math.max(Math.abs(tick.ask - tick.bid) / fallbackTickSize, 0) : 0;
    const connId = connectionIdRef.current;

    if (!connId) {
      return { digits: fallbackDigits, tickSize: fallbackTickSize, spread: fallbackSpread };
    }

    try {
      const { data, error: fnError } = await supabase.functions.invoke("mt5-proxy", {
        body: { action: "symbolParams", connectionId: connId, symbol },
      });
      if (fnError) throw fnError;

      const digits = Math.max(0, toNumber(data?.digits ?? data?.Digits ?? fallbackDigits));
      const tickSize = Number(data?.tickSize ?? data?.TickSize ?? data?.point ?? data?.Point) || (digits > 0 ? 1 / 10 ** digits : fallbackTickSize);
      const spread = toNumber(data?.spread ?? data?.Spread ?? fallbackSpread);
      const resolved = { digits, tickSize: tickSize > 0 ? tickSize : fallbackTickSize, spread };

      symbolParamsCacheRef.current[symbol] = resolved;
      return resolved;
    } catch {
      return { digits: fallbackDigits, tickSize: fallbackTickSize, spread: fallbackSpread };
    }
  }, [countDecimals]);

  const timeframeToMs = useCallback((tf: string) => {
    const map: Record<string, number> = {
      "1m": 60_000,
      "5m": 300_000,
      "15m": 900_000,
      "30m": 1_800_000,
      "1h": 3_600_000,
      "4h": 14_400_000,
      "1d": 86_400_000,
    };
    return map[tf] ?? 60_000;
  }, []);

  const toCandleBucket = useCallback((time: string, tf: string) => {
    const timestamp = new Date(time).getTime();
    if (Number.isNaN(timestamp)) return Math.floor(Date.now() / timeframeToMs(tf));
    return Math.floor(timestamp / timeframeToMs(tf));
  }, [timeframeToMs]);

  // Convert entered distance values to actual price levels using the latest quote.
  const pipsToPriceLevel = useCallback(
    (tick: TickData | null, type: string, tpPips?: number, slPips?: number, symbolParams?: SymbolTradingParams | null) => {
      if (!tick) return { tpPrice: undefined, slPrice: undefined };

      const isBuy = type.toLowerCase() === "buy";
      const entryPrice = isBuy ? tick.ask : tick.bid;
      const tickSize = symbolParams?.tickSize && symbolParams.tickSize > 0
        ? symbolParams.tickSize
        : Math.max(1 / 10 ** Math.max(countDecimals(tick.bid), countDecimals(tick.ask)), 1e-8);
      const precision = Math.max(
        symbolParams?.digits ?? 0,
        countDecimals(tick.bid),
        countDecimals(tick.ask),
        countDecimals(tickSize),
      );
      const roundToPrecision = (value: number) => Number(value.toFixed(precision));
      const spreadDistance = symbolParams?.spread && symbolParams.spread > 0
        ? symbolParams.spread * tickSize
        : Math.abs(tick.ask - tick.bid);
      const minimumDistance = Math.max(tickSize, spreadDistance);

      const tpDistance = typeof tpPips === "number" && tpPips > 0 ? Math.max(tpPips * tickSize, minimumDistance) : undefined;
      const slDistance = typeof slPips === "number" && slPips > 0 ? Math.max(slPips * tickSize, minimumDistance) : undefined;

      const tpPrice =
        tpDistance !== undefined
          ? roundToPrecision(isBuy ? entryPrice + tpDistance : entryPrice - tpDistance)
          : undefined;

      const slPrice =
        slDistance !== undefined
          ? roundToPrecision(isBuy ? entryPrice - slDistance : entryPrice + slDistance)
          : undefined;

      return { tpPrice, slPrice };
    },
    [countDecimals]
  );

  const closeManagedTrade = useCallback(async (trade: CandleManagedTrade, reason: "tp" | "sl") => {
    if (closingTradeTicketsRef.current.has(trade.ticket)) return false;
    closingTradeTicketsRef.current.add(trade.ticket);

    try {
      const latestTick = await getLatestTick(trade.symbol);
      const closePrice = trade.type === "buy" ? latestTick?.bid : latestTick?.ask;
      const connId = connectionIdRef.current;
      if (!connId) throw new Error("Not connected");

      const { data, error: fnError } = await supabase.functions.invoke("mt5-proxy", {
        body: {
          action: "closeOrder",
          connectionId: connId,
          ticket: trade.ticket,
          lots: trade.volume,
          price: closePrice,
          symbol: trade.symbol,
          type: trade.type,
          comment: `Auto ${reason.toUpperCase()} candle exit`,
        },
      });
      if (fnError) throw fnError;
      if (data?.error) throw new Error(data.error);

      candleManagedTradesRef.current = candleManagedTradesRef.current.filter((item) => item.ticket !== trade.ticket);
      toast.success(`${trade.symbol} closed by ${reason.toUpperCase()} candle rule`);
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to close trade";
      toast.error(`${trade.symbol} candle close failed: ${message}`);
      return false;
    } finally {
      closingTradeTicketsRef.current.delete(trade.ticket);
    }
  }, [getLatestTick]);

  const openPosition = useCallback(
    async (symbol: string, type: string, volume: number, tpPips?: number, slPips?: number) => {
      const connId = connectionIdRef.current;
      if (!connId) throw new Error("Not connected");

      const normalizedType = type.toLowerCase() === "sell" ? "sell" : "buy";
      const latestTick = await getLatestTick(symbol);
      const symbolParams = await fetchSymbolParams(symbol, latestTick);
      const entryPrice = normalizedType === "buy" ? latestTick?.ask : latestTick?.bid;
      const { tpPrice, slPrice } = exitMode === "pips"
        ? pipsToPriceLevel(latestTick, normalizedType, tpPips, slPips, symbolParams)
        : { tpPrice: undefined, slPrice: undefined };

      console.log(`Opening ${normalizedType} ${volume} lots on ${symbol} | mode: ${exitMode} | TP input: ${tpPips} → price: ${tpPrice} | SL input: ${slPips} → price: ${slPrice}`);

      const { data, error: fnError } = await supabase.functions.invoke("mt5-proxy", {
        body: {
          action: "trade",
          connectionId: connId,
          symbol,
          type: normalizedType,
          volume,
          price: entryPrice,
          slippage: Math.max(2, Math.ceil(symbolParams.spread || 0)),
          tp: tpPrice,
          sl: slPrice,
        },
      });
      if (fnError) throw fnError;
      if (data?.error) throw new Error(data.error);

      const tradeResponse = data as TradeExecutionResponse | null;
      if (exitMode === "pips" && tradeResponse?.stopsApplied === false) {
        throw new Error(tradeResponse.warning || "Trade opened but TP/SL could not be applied");
      }
      if (tradeResponse?.warning) {
        toast.warning(tradeResponse.warning);
      }

      if (exitMode === "candles" && tradeResponse?.ticket) {
        const effectiveTpCandles = Math.max(0, Math.floor(tpPips || 0));
        const effectiveSlCandles = Math.max(0, Math.floor(slPips || 0));
        if (effectiveTpCandles > 0 || effectiveSlCandles > 0) {
          candleManagedTradesRef.current = [
            ...candleManagedTradesRef.current.filter((trade) => trade.ticket !== tradeResponse.ticket),
            {
              ticket: tradeResponse.ticket,
              symbol,
              type: normalizedType,
              volume,
              timeframe,
              openedBucket: latestTick?.time ? toCandleBucket(latestTick.time, timeframe) : Math.floor(Date.now() / timeframeToMs(timeframe)),
              tpCandles: effectiveTpCandles,
              slCandles: effectiveSlCandles,
            },
          ];
        }
      }

      return data;
    },
    [exitMode, fetchSymbolParams, getLatestTick, pipsToPriceLevel, timeframe, timeframeToMs, toCandleBucket]
  );

  // Open multiple positions with retry and per-trade error reporting
  const openMultiplePositions = useCallback(
    async (symbol: string, type: string, volume: number, count: number, tp?: number, sl?: number): Promise<TradeResult[]> => {
      const results: TradeResult[] = [];
      for (let i = 0; i < count; i++) {
        let success = false;
        let lastError = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await openPosition(symbol, type, volume, tp, sl);
            success = true;
            break;
          } catch (err: unknown) {
            lastError = err instanceof Error ? err.message : "Trade failed";
            if (attempt < 1) {
              await new Promise((r) => setTimeout(r, 400));
            }
          }
        }
        results.push({ index: i + 1, success, error: success ? undefined : lastError });
        if (i < count - 1) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      return results;
    },
    [openPosition]
  );

  // Open trades in a loop until margin is exhausted
  const openTradesUntilMarginExhausted = useCallback(
    async (symbol: string, tradeType: string, volume: number, tp?: number, sl?: number) => {
      let totalOpened = 0;
      const MAX_SAFETY = 200;
      for (let i = 0; i < MAX_SAFETY; i++) {
        try {
          await openPosition(symbol, tradeType, volume, tp, sl);
          totalOpened++;
          await fetchAccountInfo();
          await new Promise((r) => setTimeout(r, 400));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "";
          console.log(`Auto-trade stopped after ${totalOpened} trades: ${msg}`);
          break;
        }
      }
      return totalOpened;
    },
    [openPosition, fetchAccountInfo]
  );

  const toMinuteBucket = useCallback((time: string) => {
    const timestamp = new Date(time).getTime();
    if (Number.isNaN(timestamp)) return time;
    return String(Math.floor(timestamp / 60000));
  }, []);

  const detectSpikes = useCallback(async () => {
    if (!isConnected) return;

    const eligibleSymbols = (autoTradeSymbols.length > 0 ? autoTradeSymbols : watchList)
      .filter((symbol) => !autoTradeExcludedSymbols.includes(symbol));
    const symbolsToScan = eligibleSymbols.filter(isSyntheticIndex);
    if (!symbolsToScan.length) return;

    const candleBatches = await Promise.all(
      symbolsToScan.map(async (symbol) => ({
        symbol,
        candles: await fetchCandles(symbol, SPIKE_TIMEFRAME, 12),
      }))
    );

    // Collect all new spike events first
    const newSpikes: SpikeEvent[] = [];

    for (const { symbol, candles } of candleBatches) {
      if (candles.length < 3) continue;

      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const bodySize = Math.abs(last.close - last.open);
      const prevBody = Math.abs(prev.close - prev.open);

      if (prevBody <= 0 || bodySize <= 0) continue;

      const spikeRatio = bodySize / prevBody;
      if (spikeRatio < 3) continue;

      const spikeKey = `${symbol}:${toMinuteBucket(last.time)}`;
      if (processedSpikeKeysRef.current.has(spikeKey)) continue;
      if (processedSpikeKeysRef.current.size > 2000) {
        processedSpikeKeysRef.current.clear();
      }
      processedSpikeKeysRef.current.add(spikeKey);

      const direction: "bullish" | "bearish" = last.close > last.open ? "bullish" : "bearish";
      const percentage = prev.close !== 0 ? (bodySize / Math.abs(prev.close)) * 100 : 0;
      const spikeEvent: SpikeEvent = {
        symbol,
        direction,
        percentage,
        timestamp: Date.now(),
        candle: last,
        key: spikeKey,
      };

      newSpikes.push(spikeEvent);

      setSpikes((prevSpikes) => [spikeEvent, ...prevSpikes].slice(0, MAX_STORED_SPIKES));
      toast.warning(`🔺 ${direction.toUpperCase()} spike on ${symbol}: ${percentage.toFixed(2)}%`, { duration: 5000 });
      playSpikeSound();
      sendSpikeNotification(spikeEvent);
    }

    // Auto-trade: pick the highest index number among simultaneous spikes
    if (autoTrade && newSpikes.length > 0) {
      const sorted = [...newSpikes].sort(
        (a, b) => extractIndexNumber(b.symbol) - extractIndexNumber(a.symbol)
      );
      const chosen = sorted[0];
      if (activeAutoTradeSpikeKeyRef.current === chosen.key) {
        return;
      }

      activeAutoTradeSpikeKeyRef.current = chosen.key;
      const tradeType = getAutoTradeDirection(chosen.symbol, chosen.direction);

      toast.info(`Auto-trading ${tradeType.toUpperCase()} on ${chosen.symbol} (highest index: ${extractIndexNumber(chosen.symbol)})`, { duration: 4000 });

      try {
        const totalOpened = await openTradesUntilMarginExhausted(
          chosen.symbol, tradeType, autoTradeLotSize, takeProfit, stopLoss
        );

        if (totalOpened > 0) {
          toast.success(`Auto-${tradeType.toUpperCase()} opened ${totalOpened} trades on ${chosen.symbol} until margin exhausted`);
        } else {
          toast.error(`Auto-trade skipped ${chosen.symbol} — waiting for the next fresh spike`);
        }

        await fetchAccountInfo();
      } finally {
        activeAutoTradeSpikeKeyRef.current = null;
      }
    }
  }, [
    isConnected,
    autoTradeSymbols,
    autoTradeExcludedSymbols,
    watchList,
    fetchCandles,
    autoTrade,
    autoTradeLotSize,
    takeProfit,
    stopLoss,
    playSpikeSound,
    sendSpikeNotification,
    openTradesUntilMarginExhausted,
    fetchAccountInfo,
    toMinuteBucket,
  ]);

  useEffect(() => {
    if (!isConnected) return;
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, [isConnected]);

  useEffect(() => {
    if (!isConnected) return;
    void detectSpikes();
    const interval = setInterval(() => {
      void detectSpikes();
    }, SPIKE_SCAN_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isConnected, detectSpikes]);

  return (
    <MetaApiContext.Provider
      value={{
        isConnected, isConnecting, connectionId, accountInfo,
        symbols, syntheticSymbols, watchList, ticks, spikes,
        autoTrade, autoTradeSymbols, autoTradeExcludedSymbols, lotSize, autoTradeLotSize,
        takeProfit, stopLoss, timeframe,
        connect, disconnect, fetchAccountInfo, fetchSymbols,
        removeFromWatch, addToWatch, subscribeTick, fetchCandles,
        openPosition, openMultiplePositions,
        setAutoTrade, setAutoTradeSymbols, toggleAutoTradeSymbol, toggleAutoTradeExclusion,
        setLotSize, setAutoTradeLotSize, setTakeProfit, setStopLoss,
        setTimeframe, savedCredentials, error,
      }}
    >
      {children}
    </MetaApiContext.Provider>
  );
};
