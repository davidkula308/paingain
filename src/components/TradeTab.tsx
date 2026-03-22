import { useState, useEffect } from "react";
import { useMetaApi } from "@/contexts/MetaApiContext";
import MultiChartView from "./MultiChartView";
import ManualTradePanel from "./ManualTradePanel";

const TIMEFRAMES = [
  { value: "1m", label: "1M" },
  { value: "5m", label: "5M" },
  { value: "15m", label: "15M" },
  { value: "30m", label: "30M" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
];

const TradeTab = () => {
  const {
    isConnected, watchList, ticks, subscribeTick,
    timeframe, setTimeframe,
    autoTradeSymbols, spikes,
  } = useMetaApi();
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const scanCount = autoTradeSymbols.length > 0 ? autoTradeSymbols.length : watchList.length;

  useEffect(() => {
    if (!isConnected) return;
    watchList.forEach((s) => subscribeTick(s));
  }, [isConnected, watchList, subscribeTick]);

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Connect your MT5 account first
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: Symbol list */}
      <div className="w-48 border-r border-border flex flex-col overflow-hidden">
        <div className="p-2 border-b border-border">
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            className="w-full bg-muted border border-border rounded px-2 py-1 text-xs font-mono text-foreground"
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf.value} value={tf.value}>{tf.label}</option>
            ))}
          </select>
        </div>
        <div className="px-2 py-1 border-b border-border">
          <p className="text-[10px] text-bullish font-mono">Spike scanner active • 1M</p>
          <p className="text-[10px] text-muted-foreground">Scanning {scanCount} selected indices</p>
        </div>
        <div className="flex-1 overflow-auto">
          {watchList.map((sym) => {
            const tick = ticks[sym];
            const hasSpike = spikes.some((s) => s.symbol === sym && Date.now() - s.timestamp < 10000);
            const isAutoTraded = autoTradeSymbols.includes(sym);
            return (
              <button
                key={sym}
                onClick={() => setSelectedSymbol(sym === selectedSymbol ? null : sym)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors duration-100 ${
                  selectedSymbol === sym ? "bg-primary/20 text-primary" : "hover:bg-muted"
                } ${hasSpike ? "border-l-2 border-l-bearish" : ""}`}
              >
                <div className="flex items-center gap-1">
                  {isAutoTraded && <span className="w-1.5 h-1.5 rounded-full bg-bullish" />}
                  <span className="font-mono text-xs">{sym}</span>
                </div>
                {tick && (
                  <div className="text-[10px] text-muted-foreground font-mono">
                    {tick.bid.toFixed(5)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Center: Charts */}
      <div className="flex-1 overflow-auto p-2">
        <MultiChartView selectedSymbol={selectedSymbol} />
      </div>

      {/* Right: Trade Panel */}
      <div className="w-64 border-l border-border overflow-auto">
        <ManualTradePanel selectedSymbol={selectedSymbol} />
      </div>
    </div>
  );
};

export default TradeTab;
