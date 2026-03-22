import { Home, User, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

type Tab = "home" | "account" | "trade";

interface AppSidebarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "home", label: "Home", icon: <Home size={18} /> },
  { id: "account", label: "Account", icon: <User size={18} /> },
  { id: "trade", label: "Trade", icon: <TrendingUp size={18} /> },
];

const AppSidebar = ({ activeTab, onTabChange }: AppSidebarProps) => {
  return (
    <div className="w-16 bg-sidebar border-r border-sidebar-border flex flex-col items-center py-4 gap-2">
      <span className="text-xs font-bold text-sidebar-primary mb-4">MT5</span>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            "w-12 h-12 rounded flex flex-col items-center justify-center gap-1 transition-all duration-100",
            activeTab === tab.id
              ? "bg-primary/20 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
          title={tab.label}
        >
          {tab.icon}
          <span className="text-[9px]">{tab.label}</span>
        </button>
      ))}
    </div>
  );
};

export default AppSidebar;
