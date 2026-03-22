import { useState } from "react";
import AppSidebar from "@/components/AppSidebar";
import AccountHeader from "@/components/AccountHeader";
import HomeTab from "@/components/HomeTab";
import AccountTab from "@/components/AccountTab";
import TradeTab from "@/components/TradeTab";

type Tab = "home" | "account" | "trade";

const Index = () => {
  const [activeTab, setActiveTab] = useState<Tab>("account");

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <AppSidebar activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <AccountHeader />
        <div className="flex-1 overflow-auto">
          {activeTab === "home" && <HomeTab />}
          {activeTab === "account" && <AccountTab />}
          {activeTab === "trade" && <TradeTab />}
        </div>
      </div>
    </div>
  );
};

export default Index;
