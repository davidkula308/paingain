import { useState } from "react";
import { useMetaApi } from "@/contexts/MetaApiContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";

interface ManualTradePanelProps {
  selectedSymbol: string | null;
}

const ManualTradePanel = ({ selectedSymbol }: ManualTradePanelProps) => {
  const {
    autoTrade, setAutoTrade, lotSize, setLotSize,
    autoTradeLotSize, setAutoTradeLotSize,
    exitMode, setExitMode,
    takeProfit, setTakeProfit, stopLoss, setStopLoss,
    tpCandles, setTpCandles, slCandles, setSlCandles,
    openMultiplePositions, accountInfo, watchList, isConnected,
    autoTradeSymbols, autoTradeExcludedSymbols, toggleAutoTradeSymbol, toggleAutoTradeExclusion,
  } = useMetaApi();
  const [numTrades, setNumTrades] = useState(1);
  const [isTrading, setIsTrading] = useState(false);
  const [symbol, setSymbol] = useState(selectedSymbol || "");

  const currentSymbol = selectedSymbol || symbol;

  const executeTrades = async (type: "buy" | "sell") => {
    if (!currentSymbol || !isConnected) {
      toast.error("Select a symbol and connect first");
      return;
    }
    setIsTrading(true);
    try {
      const exitTp = exitMode === "candles" ? tpCandles : takeProfit;
      const exitSl = exitMode === "candles" ? slCandles : stopLoss;
      const results = await openMultiplePositions(
        currentSymbol, type, lotSize, numTrades, exitTp, exitSl
      );
      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success);

      if (succeeded > 0) {
        toast.success(`${succeeded}/${numTrades} ${type.toUpperCase()} trades placed on ${currentSymbol}`);
      }
      failed.forEach((r) => {
        toast.error(`Trade #${r.index} failed: ${r.error || "Insufficient margin"}`);
      });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Trade execution failed");
    } finally {
      setIsTrading(false);
    }
  };

  const maxMarginUsed = accountInfo
    ? ((accountInfo.margin / (accountInfo.margin + accountInfo.freeMargin)) * 100).toFixed(1)
    : "0.0";

  return (
    <div className="p-3 space-y-3 text-sm">
      {/* Auto Trade Toggle */}
      <div className="flex items-center justify-between">
        <Label className="text-xs">Auto-Trade</Label>
        <Switch checked={autoTrade} onCheckedChange={setAutoTrade} />
      </div>
      {autoTrade && (
        <div className="space-y-2 bg-bearish/10 rounded p-2">
          <p className="text-[10px] text-bearish font-semibold">
            BOT ACTIVE — trades until margin exhausted
          </p>

          {/* Auto-Trade Lot Size */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Auto-Trade Lot Size</Label>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              value={autoTradeLotSize || ""}
              onChange={(e) => {
                const val = e.target.value;
                setAutoTradeLotSize(val === "" || val === "0" ? 0 : Number(val));
              }}
              onBlur={() => { if (autoTradeLotSize <= 0) setAutoTradeLotSize(0.01); }}
              className="bg-muted font-mono text-sm h-7"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Opens trades with this lot until margin is full
          </p>
          <p className="text-[10px] text-muted-foreground">
            Auto-trade uses the same exit mode and values configured below
          </p>
          <p className="text-[10px] text-muted-foreground font-semibold">Auto-Trade Symbols</p>
          <div className="space-y-1 max-h-32 overflow-auto">
            {watchList.map((s) => (
              <div key={s} className="grid grid-cols-[1fr_auto] items-center gap-2 text-[10px] font-mono">
                <label className="flex items-center gap-1.5">
                  <Checkbox
                    checked={autoTradeSymbols.includes(s)}
                    onCheckedChange={() => toggleAutoTradeSymbol(s)}
                    className="h-3 w-3"
                  />
                  <span className={autoTradeExcludedSymbols.includes(s) ? "text-muted-foreground line-through" : ""}>{s}</span>
                </label>
                <button
                  type="button"
                  onClick={() => toggleAutoTradeExclusion(s)}
                  className={`rounded border px-1.5 py-0.5 text-[9px] transition-colors ${autoTradeExcludedSymbols.includes(s) ? "border-bearish/40 bg-bearish/15 text-bearish" : "border-border bg-muted text-muted-foreground hover:text-foreground"}`}
                >
                  {autoTradeExcludedSymbols.includes(s) ? "Excluded" : "Allow"}
                </button>
              </div>
            ))}
          </div>
          <p className="text-[9px] text-muted-foreground">
            Excluded symbols stay visible but are never auto-traded; if multiple spikes, trades highest eligible index only
          </p>
        </div>
      )}

      {/* Symbol */}
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Symbol</Label>
        <select
          value={currentSymbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="w-full bg-muted border border-border rounded px-2 py-1.5 text-sm font-mono text-foreground"
        >
          <option value="">Select symbol</option>
          {watchList.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* Lot Size */}
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Lot Size</Label>
        <Input
          type="number"
          step="0.01"
          min="0.01"
          value={lotSize || ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "" || val === "0") {
              setLotSize(0);
            } else {
              setLotSize(Number(val));
            }
          }}
          onBlur={() => { if (lotSize <= 0) setLotSize(0.01); }}
          className="bg-muted font-mono text-sm h-8"
        />
      </div>

      {/* Exit mode */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Exit Mode</Label>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setExitMode("pips")}
            className={exitMode === "pips" ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}
          >
            Pips
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setExitMode("candles")}
            className={exitMode === "candles" ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}
          >
            Candles
          </Button>
        </div>
      </div>

      {/* TP / SL settings */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{exitMode === "candles" ? "TP (candles)" : "TP (pips)"}</Label>
          <Input
            type="number"
            value={exitMode === "candles" ? tpCandles || "" : takeProfit || ""}
            onChange={(e) => {
              const val = e.target.value;
              if (exitMode === "candles") {
                setTpCandles(val === "" ? 0 : Number(val));
              } else {
                setTakeProfit(val === "" ? 0 : Number(val));
              }
            }}
            onBlur={() => {
              if (exitMode === "candles") {
                if (tpCandles < 0) setTpCandles(0);
              } else if (takeProfit < 0) {
                setTakeProfit(0);
              }
            }}
            placeholder={exitMode === "candles" ? "3" : "5000"}
            className="bg-muted font-mono text-sm h-8"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{exitMode === "candles" ? "SL (candles)" : "SL (pips)"}</Label>
          <Input
            type="number"
            value={exitMode === "candles" ? slCandles || "" : stopLoss || ""}
            onChange={(e) => {
              const val = e.target.value;
              if (exitMode === "candles") {
                setSlCandles(val === "" ? 0 : Number(val));
              } else {
                setStopLoss(val === "" ? 0 : Number(val));
              }
            }}
            onBlur={() => {
              if (exitMode === "candles") {
                if (slCandles < 0) setSlCandles(0);
              } else if (stopLoss < 0) {
                setStopLoss(0);
              }
            }}
            placeholder={exitMode === "candles" ? "1" : "8000"}
            className="bg-muted font-mono text-sm h-8"
          />
        </div>
      </div>
      {exitMode === "candles" && (
        <p className="text-[10px] text-muted-foreground">
          Candle exits close immediately after the selected candle count closes; set 0 to disable either side
        </p>
      )}

      {/* Number of Trades */}
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Number of Trades</Label>
        <Input
          type="number"
          min="1"
          value={numTrades}
          onChange={(e) => setNumTrades(Number(e.target.value) || 1)}
          className="bg-muted font-mono text-sm h-8"
        />
      </div>

      {/* Max Margin */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Margin Used</span>
        <span className="font-mono">{maxMarginUsed}%</span>
      </div>

      {/* Buy / Sell */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          onClick={() => executeTrades("buy")}
          disabled={isTrading || !currentSymbol || !isConnected}
          className="bg-bullish hover:bg-bullish/90 text-bullish-foreground font-semibold h-10"
        >
          {isTrading ? "..." : "BUY"}
        </Button>
        <Button
          onClick={() => executeTrades("sell")}
          disabled={isTrading || !currentSymbol || !isConnected}
          className="bg-bearish hover:bg-bearish/90 text-bearish-foreground font-semibold h-10"
        >
          {isTrading ? "..." : "SELL"}
        </Button>
      </div>
    </div>
  );
};

export default ManualTradePanel;
