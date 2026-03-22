import { useMetaApi } from "@/contexts/MetaApiContext";

const AccountHeader = () => {
  const { isConnected, accountInfo } = useMetaApi();

  if (!isConnected || !accountInfo) return null;

  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-card border-b border-border text-xs font-mono">
      <span className={`px-2 py-0.5 rounded text-xs font-semibold ${isConnected ? "bg-bullish/20 text-bullish" : "bg-bearish/20 text-bearish"}`}>
        {isConnected ? "Connected" : "Disconnected"}
      </span>
      <span className="text-muted-foreground">Balance:<span className="text-foreground ml-1">{accountInfo.balance.toFixed(2)}</span></span>
      <span className="text-muted-foreground">Equity:<span className="text-foreground ml-1">{accountInfo.equity.toFixed(2)}</span></span>
      <span className="text-muted-foreground">Margin:<span className="text-foreground ml-1">{accountInfo.margin.toFixed(2)}</span></span>
      <span className="text-muted-foreground">Free:<span className="text-foreground ml-1">{accountInfo.freeMargin.toFixed(2)}</span></span>
      <span className="text-muted-foreground">Level:<span className="text-foreground ml-1">{accountInfo.marginLevel.toFixed(1)}%</span></span>
    </div>
  );
};

export default AccountHeader;
