import { useState, useEffect } from "react";
import { useMetaApi } from "@/contexts/MetaApiContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const AccountTab = () => {
  const { isConnected, isConnecting, accountInfo, connect, disconnect, error, savedCredentials } = useMetaApi();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState("");

  // Pre-fill from saved credentials
  useEffect(() => {
    if (savedCredentials && !login && !password && !server) {
      setLogin(savedCredentials.login);
      setPassword(savedCredentials.password);
      setServer(savedCredentials.server);
    }
  }, [savedCredentials]);

  const handleConnect = async () => {
    try {
      await connect(login, password, server);
    } catch {}
  };

  return (
    <div className="p-6 max-w-md mx-auto space-y-6">
      {/* Connection Status */}
      <div className="flex items-center gap-2">
        <div className={`w-2.5 h-2.5 rounded-full ${isConnecting ? "bg-yellow-500 animate-pulse" : isConnected ? "bg-bullish pulse-green" : "bg-muted-foreground"}`} />
        <span className="text-sm font-mono text-muted-foreground">
          {isConnecting ? "Connecting..." : isConnected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {!isConnected ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Connect MT5 Account</h2>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Account Login (ID)</Label>
            <Input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              className="bg-muted font-mono"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Trading Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-muted"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Broker Server IP</Label>
            <Input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              className="bg-muted font-mono"
            />
          </div>

          <p className="text-xs text-muted-foreground">Connection uses port 443</p>

          {error && (
            <div className="text-xs text-bearish bg-bearish/10 rounded p-2">
              {error}
            </div>
          )}

          <Button onClick={handleConnect} disabled={isConnecting} className="w-full">
            {isConnecting ? "Connecting..." : "Connect"}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Account Details</h2>

          {accountInfo ? (
            <div className="space-y-2 text-sm font-mono">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Name</span>
                <span>{accountInfo.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Server</span>
                <span>{accountInfo.server}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Balance</span>
                <span>{accountInfo.balance.toFixed(2)} {accountInfo.currency}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Equity</span>
                <span>{accountInfo.equity.toFixed(2)} {accountInfo.currency}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Margin</span>
                <span>{accountInfo.margin.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Free Margin</span>
                <span>{accountInfo.freeMargin.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Margin Level</span>
                <span>{accountInfo.marginLevel.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Leverage</span>
                <span>1:{accountInfo.leverage}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading account details...</p>
          )}

          <Button variant="destructive" onClick={disconnect} className="w-full">
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );
};

export default AccountTab;
