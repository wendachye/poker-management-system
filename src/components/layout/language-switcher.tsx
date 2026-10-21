"use client";
import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Select } from "@/components/page/PokerManagementPage/components/shared";
export function LanguageSwitcher() {
  const locale = useLocale(),
    router = useRouter(),
    pathname = usePathname();
  return (
    <div className="w-28 shrink-0">
      <Select
        aria-label="Language / 语言"
        value={locale}
        onValueChange={(value) => router.replace(pathname, { locale: value })}
        options={[
          { value: "en", label: "English" },
          { value: "zh", label: "中文" },
        ]}
      />
    </div>
  );
}
