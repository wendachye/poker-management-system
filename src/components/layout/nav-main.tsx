"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useText } from "@/components/page/PokerManagementPage/components/shared";
import { useAuth } from "@/contexts/auth-context";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";

import { Link, usePathname } from "@/i18n/navigation";
import { NavItem } from "@/types/navigation";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";

function visibleNavigation(
  items: NavItem[],
  role: string | undefined,
): NavItem[] {
  return items.flatMap((item) => {
    if (
      (item.moduleKey === "settings" && role !== "ADMIN") ||
      (item.moduleKey === "admin" && !["MANAGER", "ADMIN"].includes(role ?? ""))
    ) {
      return [];
    }
    const children = item.items && visibleNavigation(item.items, role);
    if (item.items?.length && !children?.length) return [];
    return [{ ...item, items: children }];
  });
}

function matchesPath(item: NavItem, pathname: string): boolean {
  return (
    pathname === item.url ||
    pathname.startsWith(`${item.url}/`) ||
    !!item.items?.some((child) => matchesPath(child, pathname))
  );
}

function NavigationItem({
  item,
  pathname,
  closeMobile,
  nested = false,
}: {
  item: NavItem;
  pathname: string;
  closeMobile: () => void;
  nested?: boolean;
}) {
  const t = useText();
  const active = matchesPath(item, pathname);
  const [expansion, setExpansion] = useState({ pathname, open: active });
  // A newly active route opens its group, while still allowing the user to
  // collapse that group on the current route without an effect overriding it.
  if (expansion.pathname !== pathname) {
    setExpansion({ pathname, open: active || expansion.open });
  }
  const open =
    expansion.pathname === pathname ? expansion.open : active || expansion.open;
  const hasChildren = !!item.items?.length;
  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem;
  const link = (
    <Link
      href={item.url}
      onClick={closeMobile}
      aria-current={pathname === item.url && !hasChildren ? "page" : undefined}
    >
      {!nested && <item.icon />}
      <span>{t(item.title)}</span>
    </Link>
  );

  return (
    <Collapsible
      asChild
      open={open}
      onOpenChange={(nextOpen) => setExpansion({ pathname, open: nextOpen })}
    >
      <Item>
        {nested ? (
          <SidebarMenuSubButton asChild isActive={active}>
            {link}
          </SidebarMenuSubButton>
        ) : (
          <SidebarMenuButton asChild tooltip={t(item.title)} isActive={active}>
            {link}
          </SidebarMenuButton>
        )}
        {hasChildren && (
          <>
            <CollapsibleTrigger asChild>
              <SidebarMenuAction
                className="data-[state=open]:rotate-90"
                aria-label={`${t(open ? "Collapse" : "Expand")} ${t(item.title)}`}
              >
                <ChevronRight />
              </SidebarMenuAction>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                {item.items?.map((child) => (
                  <NavigationItem
                    key={child.url}
                    item={child}
                    pathname={pathname}
                    closeMobile={closeMobile}
                    nested
                  />
                ))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </>
        )}
      </Item>
    </Collapsible>
  );
}

export function NavMain({
  items,
  label = "Operations",
  className,
}: {
  items: NavItem[];
  label?: string;
  className?: string;
}) {
  const pathname = usePathname();
  const t = useText();
  const { user } = useAuth();
  const { isMobile, setOpenMobile } = useSidebar();
  const visibleItems = visibleNavigation(items, user?.role);

  if (!visibleItems.length) return null;

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <SidebarGroup className={className}>
      <SidebarGroupLabel>{t(label)}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {visibleItems.map((item) => (
            <NavigationItem
              key={item.url}
              item={item}
              pathname={pathname}
              closeMobile={closeMobile}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
