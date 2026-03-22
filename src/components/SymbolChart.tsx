import { useEffect, useMemo, useRef, useState } from "react";
import { useMetaApi } from "@/contexts/MetaApiContext";

interface SymbolChartProps {
  symbol: string;
}

interface CandlePoint {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

const MAX_CANDLES = 60;
const POLL_INTERVAL_MS = 5000;

const SymbolChart = ({ symbol }: SymbolChartProps) => {
  const { fetchCandles, timeframe, isConnected } = useMetaApi();
  const [candles, setCandles] = useState<CandlePoint[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [chartSize, setChartSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setChartSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isConnected || !symbol) return;
    let mounted = true;
    const load = async () => {
      const data = await fetchCandles(symbol, timeframe, MAX_CANDLES);
      if (!mounted || !data.length) return;

      const mapped = data
        .map((c) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
        .filter(
          (c) =>
            Number.isFinite(c.open) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low) &&
            Number.isFinite(c.close) &&
            c.high >= c.low
        );

      if (mapped.length) {
        setCandles(mapped);
      }
    };
    void load();
    const interval = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [isConnected, symbol, timeframe, fetchCandles]);

  const chartCandles = useMemo(() => candles.slice(-MAX_CANDLES), [candles]);

  if (!chartCandles.length) {
    return (
      <div ref={containerRef} className="w-full h-full flex items-center justify-center">
        <span className="text-xs text-muted-foreground">Loading chart...</span>
      </div>
    );
  }

  const width = Math.max(chartSize.width, 320);
  const height = Math.max(chartSize.height, 180);
  const padding = 10;
  const plotHeight = height - padding * 2;
  const maxPrice = Math.max(...chartCandles.map((c) => c.high));
  const minPrice = Math.min(...chartCandles.map((c) => c.low));
  const priceRange = Math.max(maxPrice - minPrice, 1);
  const slotWidth = width / chartCandles.length;
  const candleWidth = Math.max(2, Math.min(10, slotWidth * 0.6));

  const priceToY = (price: number) => padding + ((maxPrice - price) / priceRange) * plotHeight;

  return (
    <div ref={containerRef} className="w-full h-full">
      <svg width={width} height={height} className="block">
        {[0, 1, 2, 3, 4].map((step) => {
          const y = padding + (plotHeight / 4) * step;
          return (
            <line key={step} x1={0} y1={y} x2={width} y2={y} stroke="hsl(var(--border))" strokeWidth={0.5} />
          );
        })}

        {chartCandles.map((candle, index) => {
          const x = slotWidth * index + slotWidth / 2;
          const openY = priceToY(candle.open);
          const closeY = priceToY(candle.close);
          const highY = priceToY(candle.high);
          const lowY = priceToY(candle.low);
          const bodyY = Math.min(openY, closeY);
          const bodyHeight = Math.max(Math.abs(closeY - openY), 1.25);
          const isBullish = candle.close >= candle.open;
          const candleColor = isBullish ? "hsl(var(--bullish))" : "hsl(var(--bearish))";

          return (
            <g key={index}>
              <line x1={x} y1={highY} x2={x} y2={lowY} stroke={candleColor} strokeWidth={1} />
              <rect x={x - candleWidth / 2} y={bodyY} width={candleWidth} height={bodyHeight} fill={candleColor} />
            </g>
          );
        })}
      </svg>
    </div>
  );
};

export default SymbolChart;
