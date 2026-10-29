"use client";

import { ThemeProvider } from "@/components/layout/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { Toaster } from "@/components/ui/sonner";
import { prototypeEnabled } from "@/prototype/config";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TooltipProvider>
        <AuthProvider>
          {children}
          <StaffToaster />
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

function StaffToaster() {
  const { loading, signingOut } = useAuth();
  if (!prototypeEnabled && (loading || signingOut)) return null;
  return (
    <Toaster
      position="bottom-right"
      mobileOffset={{
        bottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
      }}
      richColors
      closeButton
    />
  );
}
