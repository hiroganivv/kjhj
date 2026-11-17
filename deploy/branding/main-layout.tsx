"use client";

import type { ReactNode } from "react";
import * as React from "react";

import { AppSidebar } from "@/app/(main)/_components/sidebar/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { auth } from "@/lib/auth";
import { getClientCookie } from "@/lib/cookie.client";
import {
  SIDEBAR_COLLAPSIBLE_VALUES,
  SIDEBAR_VARIANT_VALUES,
  type SidebarCollapsible,
  type SidebarVariant,
} from "@/lib/preferences/layout";
import { PREFERENCE_DEFAULTS } from "@/lib/preferences/preferences-config";
import { cn } from "@/lib/utils";

import { MainContent } from "./_components/main-content";

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof document === "undefined") return fallback;
  const value = getClientCookie(key);
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  const [authed, setAuthed] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return !!auth.getToken();
  });
  React.useEffect(() => {
    if (auth.getToken()) {
      setAuthed(true);
      return;
    }
    const t = window.setTimeout(() => {
      if (auth.getToken()) {
        setAuthed(true);
      } else {
        auth.clearToken();
        window.location.href = "/login";
      }
    }, 800);
    return () => window.clearTimeout(t);
  }, []);

  const defaultOpen = typeof document === "undefined" ? true : getClientCookie("sidebar_state") !== "false";
  const variant = readPref<SidebarVariant>(
    "sidebar_variant",
    SIDEBAR_VARIANT_VALUES,
    PREFERENCE_DEFAULTS.sidebar_variant,
  );
  const collapsible = readPref<SidebarCollapsible>(
    "sidebar_collapsible",
    SIDEBAR_COLLAPSIBLE_VALUES,
    PREFERENCE_DEFAULTS.sidebar_collapsible,
  );

  if (!authed) return null;

  return (
    <>
      
      <style>{`
        @media (min-width: 768px) {
          [data-slot="sidebar"]:not([data-mobile="true"]) {
            display: block !important;
          }
          [data-slot="sidebar-container"]:not([data-mobile="true"]) {
            display: flex !important;
          }
          [data-slot="sidebar-inner"] {
            display: flex !important;
            flex-direction: column !important;
            height: 100% !important;
          }
          [data-sidebar="content"] {
            min-height: 0 !important;
            flex: 1 1 0% !important;
            overflow-y: auto !important;
          }
        }
      `}</style>
      <SidebarProvider
      defaultOpen={defaultOpen}
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 68)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant={variant} collapsible={collapsible} />
      <SidebarInset
        className={cn(
          "[html[data-content-layout=centered]_&>*]:mx-auto",
          "[html[data-content-layout=centered]_&>*]:w-full",
          "[html[data-content-layout=centered]_&>*]:max-w-screen-2xl",
          "peer-data-[variant=inset]:border",
          "[--dashboard-header-height:--spacing(12)]",
          "min-w-0 overflow-x-hidden",
        )}
      >
        <MainContent>{children}</MainContent>
      </SidebarInset>
      </SidebarProvider>
    </>
  );
}
