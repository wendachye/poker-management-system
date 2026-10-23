"use client";

import { ThemeProvider } from "@/components/layout/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/auth-context";
import { Toaster } from "@/components/ui/sonner";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TooltipProvider>
        <AuthProvider>{children}</AuthProvider>
        <Toaster
          position="bottom-right"
          mobileOffset={{
            bottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
          }}
          richColors
          closeButton
        />
      </TooltipProvider>
    </ThemeProvider>
  );
}
