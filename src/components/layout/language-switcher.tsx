"use client";
import { useLocale } from "next-intl";
import { Languages } from "lucide-react";
import { usePathname, useRouter } from "@/i18n/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function LanguageSwitcher({
  compactMobile = false,
}: {
  compactMobile?: boolean;
}) {
  const locale = useLocale(),
    router = useRouter(),
    pathname = usePathname();
  return (
    <div className={cn("w-28 shrink-0", compactMobile && "w-11 sm:w-28")}>
      <Select
        value={locale}
        onValueChange={(value) => router.replace(pathname, { locale: value })}
      >
        <SelectTrigger
          aria-label="Language / 语言"
          title={locale === "zh" ? "中文" : "English"}
          className={cn(
            compactMobile &&
              "h-11 justify-center px-0 sm:h-10 sm:justify-between sm:px-3 [&>svg]:hidden sm:[&>svg]:block",
          )}
        >
          <SelectValue>
            {compactMobile && (
              <Languages className="size-4 sm:hidden" aria-hidden="true" />
            )}
            <span className={compactMobile ? "sr-only sm:not-sr-only" : undefined}>
              {locale === "zh" ? "中文" : "English"}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="en">English</SelectItem>
          <SelectItem value="zh">中文</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
