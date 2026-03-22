import { useEffect, useState } from "react";
import { useMetaApi } from "@/contexts/MetaApiContext";
import { Input } from "@/components/ui/input";
import { X, Plus, Search } from "lucide-react";

const HomeTab = () => {
  const { isConnected, symbols, watchList, ticks, removeFromWatch, addToWatch, subscribeTick } = useMetaApi();
  const [search, setSearch] = useState("");

  // Subscribe to ticks for watchlist items
  useEffect(() => {
    if (!isConnected) return;
    watchList.forEach((s) => subscribeTick(s));
  }, [isConnected, watchList, subscribeTick]);

  const filteredWatch = watchList.filter((s) =>
    s.toLowerCase().includes(search.toLowerCase())
  );

  const removedSymbols = symbols.filter((s) => !watchList.includes(s));

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <p className="text-lg font-semibold">Not Connected</p>
        <p className="text-sm">Go to Account tab to connect your MT5 account</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={14} />
        <Input
          placeholder="Search symbols..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 bg-muted"
        />
      </div>

      <p className="text-xs text-muted-foreground">{watchList.length} symbols</p>

      {/* Watchlist Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {filteredWatch.map((symbol) => {
          const tick = ticks[symbol];
          return (
            <div key={symbol} className="group bg-card border border-border rounded p-3 relative">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-mono font-semibold">{symbol}</span>
                <button
                  onClick={() => removeFromWatch(symbol)}
                  className="text-muted-foreground hover:text-bearish opacity-0 group-hover:opacity-100 transition-opacity duration-100"
                  title="Remove from watch"
                >
                  <X size={12} />
                </button>
              </div>
              {tick ? (
                <div className="font-mono text-xs">
                  <span className="text-bullish">{tick.bid.toFixed(5)}</span>
                  <span className="text-muted-foreground mx-1">/</span>
                  <span className="text-bearish">{tick.ask.toFixed(5)}</span>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">Loading...</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Removed symbols */}
      {removedSymbols.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Removed ({removedSymbols.length})</p>
          <div className="flex flex-wrap gap-1">
            {removedSymbols.slice(0, 20).map((s) => (
              <button
                key={s}
                onClick={() => addToWatch(s)}
                className="text-xs bg-muted text-muted-foreground hover:text-foreground px-2 py-1 rounded flex items-center gap-1 transition-colors duration-100"
              >
                <Plus size={10} />
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default HomeTab;
