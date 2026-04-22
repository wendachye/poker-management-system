import type React from "react";

import { Badge as UiBadge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type BadgeTone = "neutral" | "green" | "red" | "amber" | "blue";

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
}) {
  const variant = {
    neutral: "secondary",
    green: "success",
    red: "destructive",
    amber: "warning",
    blue: "info",
  }[tone] as React.ComponentProps<typeof UiBadge>["variant"];

  return (
    <UiBadge className="max-w-full whitespace-normal text-left" variant={variant}>
      {children}
    </UiBadge>
  );
}

export function FormSelect({
  value,
  onValueChange,
  options,
  placeholder,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<string | { value: string; label: string }>;
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => {
          const item =
            typeof option === "string" ? { value: option, label: option } : option;

          return (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: string;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader className="space-y-2 p-4 sm:p-6">
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={cn(
            "break-words text-[1.35rem] font-semibold leading-tight sm:text-2xl",
            tone,
          )}
        >
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 text-xs text-muted-foreground sm:px-6 sm:pb-6">
        {hint}
      </CardContent>
    </Card>
  );
}

export function FormField({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
