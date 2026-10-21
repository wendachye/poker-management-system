"use client";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useState,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useLocale, useMessages } from "next-intl";
import {
  Check,
  ChevronsUpDown,
  Inbox,
  LoaderCircle,
  Info,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import { Badge as UiBadge } from "@/components/ui/badge";
import {
  Field as UiField,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
  CommandGroup,
} from "@/components/ui/command";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import { Link } from "@/i18n/navigation";
import { fieldError } from "@/lib/form-validation";
import { cn } from "@/lib/utils";
import { timestamp as formatTimestamp } from "../utils";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { usePokerManagementContext } from "../PokerManagementProvider";

export function useText() {
  const messages = useMessages() as { ui?: Record<string, string> };
  return (text: string) =>
    messages.ui?.[
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
    ] ?? text;
}
export function useTimestamp() {
  const locale = useLocale();
  return (value: string, timezone: string) =>
    formatTimestamp(value, timezone, locale);
}
const DirtyContext = createContext<(() => void) | null>(null);
const FormRevision = createContext<{ current: number | undefined } | null>(
  null,
);
export function Panel({
  title,
  description,
  children,
  action,
  compact = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  const t = useText();
  return (
    <Card className={cn("min-w-0", compact && "gap-3 py-3 sm:py-4")}>
      <CardHeader
        className={
          compact
            ? "flex flex-col items-stretch gap-2 px-3 sm:px-4"
            : action
              ? "max-sm:flex max-sm:flex-col max-sm:gap-3"
              : undefined
        }
      >
        {compact ? (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <CardTitle>
              <h2 className="text-sm">{t(title)}</h2>
            </CardTitle>
            {action && <div className="min-w-0 max-w-full">{action}</div>}
          </div>
        ) : (
          <CardTitle>
            <h2>{t(title)}</h2>
          </CardTitle>
        )}
        {description && (
          <CardDescription
            className={compact ? "text-xs leading-5" : undefined}
          >
            {t(description)}
          </CardDescription>
        )}
        {!compact && action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className={compact ? "space-y-3 px-3 sm:px-4" : "space-y-4"}>
        {children}
      </CardContent>
    </Card>
  );
}
const Errors = createContext<{
  errors: Record<string, string>;
  clear: (id: string) => void;
}>({ errors: {}, clear: () => {} });
export function Field({
  label,
  hint,
  optional = false,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  const id = useId(),
    t = useText(),
    context = useContext(Errors);
  const error = context.errors[id];
  const child = Children.only(children) as ReactElement<{
    id?: string;
    required?: boolean;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
    onChange?: (...args: unknown[]) => void;
    onValueChange?: (...args: unknown[]) => void;
  }>;
  return (
    <UiField
      data-invalid={!!error}
      orientation={child.type === Checkbox ? "horizontal" : "vertical"}
      className={
        child.type === Checkbox ? "min-w-0 rounded-lg border p-3" : "min-w-0"
      }
    >
      <FieldLabel htmlFor={id} className="flex-wrap gap-x-1.5">
        {t(label)}
        {child.props.required && (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        )}
        {optional && !child.props.required && (
          <span
            aria-hidden="true"
            className="font-normal text-muted-foreground"
          >
            ({t("Optional")})
          </span>
        )}
      </FieldLabel>
      {isValidElement(child)
        ? cloneElement(child, {
            id,
            "aria-invalid": !!error,
            "aria-describedby":
              [hint ? id + "-hint" : "", error ? id + "-error" : ""]
                .filter(Boolean)
                .join(" ") || undefined,
            ...(child.props.onChange
              ? {
                  onChange: (...args: unknown[]) => {
                    context.clear(id);
                    child.props.onChange?.(...args);
                  },
                }
              : {}),
            ...(child.props.onValueChange
              ? {
                  onValueChange: (...args: unknown[]) => {
                    context.clear(id);
                    child.props.onValueChange?.(...args);
                  },
                }
              : {}),
          })
        : child}
      {hint && <FieldDescription id={id + "-hint"}>{t(hint)}</FieldDescription>}
      {error && <FieldError id={id + "-error"}>{t(error)}</FieldError>}
    </UiField>
  );
}
export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const t = useText();
  return (
    <fieldset className="min-w-0 space-y-4 border-b pb-5 last:border-0 last:pb-0">
      <FieldLegend variant="label" className="mb-3 font-semibold">
        {t(title)}
      </FieldLegend>
      {description && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t(description)}
        </p>
      )}
      {children}
    </fieldset>
  );
}
export function FormGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2", className)}
    >
      {children}
    </div>
  );
}
type ChoiceProps = {
  options: { value: string; label: string; disabled?: boolean }[];
  value: string;
  onValueChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
};
export function Select({
  options,
  value,
  onValueChange,
  required,
  disabled,
  ...props
}: ChoiceProps) {
  const t = useText();
  const markDirty = useContext(DirtyContext);
  return (
    <UiSelect
      value={value || "__none__"}
      onValueChange={(v) => {
        markDirty?.();
        onValueChange(v === "__none__" ? "" : v);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        {...props}
        type="button"
        aria-required={required}
        data-required={required || undefined}
        data-value={value}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value || "__none__"}
            disabled={o.disabled}
          >
            {t(o.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
  );
}
export function SearchSelect({
  options,
  value,
  onValueChange,
  required,
  disabled,
  className,
  ...props
}: ChoiceProps) {
  const [open, setOpen] = useState(false),
    t = useText();
  const markDirty = useContext(DirtyContext);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          {...props}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-required={required}
          data-required={required || undefined}
          data-value={value}
          disabled={disabled}
          className={cn(
            "w-full min-w-0 justify-between px-3 text-base font-normal md:text-sm",
            className,
          )}
        >
          <span className="truncate">
            {t(
              options.find((o) => o.value === value)?.label ?? "Select player",
            )}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput
            placeholder={t("Search by name or phone")}
            aria-label={t("Search by name or phone")}
          />
          <CommandList>
            <CommandEmpty>{t("No matching players.")}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value + " " + o.label}
                  disabled={o.disabled}
                  onSelect={() => {
                    markDirty?.();
                    onValueChange(o.value);
                    setOpen(false);
                  }}
                >
                  {t(o.label)}
                  {value === o.value && <Check className="ml-auto" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
export function MoneyInput(props: React.ComponentProps<typeof Input>) {
  return (
    <Input
      inputMode="decimal"
      placeholder="0.00"
      data-money="true"
      {...props}
    />
  );
}
const ActionFormId = createContext<string | undefined>(undefined);
const ModalFooter = createContext<HTMLDivElement | null>(null);

function hasRequiredControl(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement<{ required?: boolean; children?: ReactNode }>(child))
      return false;
    return !!child.props.required || hasRequiredControl(child.props.children);
  });
}

export function ActionForm({
  children,
  onSubmit,
  onSuccess,
  disabled = false,
  revision,
  validationKey,
}: {
  children: ReactNode;
  onSubmit: () => Promise<unknown> | unknown;
  onSuccess?: () => void;
  disabled?: boolean;
  revision?: number;
  validationKey?: string | number;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const [validation, setValidation] = useState<{
    key: string | number | undefined;
    errors: Record<string, string>;
  }>({ key: validationKey, errors: {} });
  // Requirements can change without remounting the form or discarding its draft.
  if (validation.key !== validationKey)
    setValidation({ key: validationKey, errors: {} });
  const errors = validation.key === validationKey ? validation.errors : {};
  const formId = useId();
  const submitError = useRef<HTMLDivElement | null>(null);
  const attemptedHere = useRef(false);
  const openedRevision = useContext(FormRevision);
  useEffect(() => {
    if (s.error) submitError.current?.focus();
  }, [s.error]);
  return (
    <ActionFormId.Provider value={formId}>
      <Errors.Provider
        value={{
          errors,
          clear: (id) =>
            setValidation((current) => ({
              key: validationKey,
              errors: {
                ...(current.key === validationKey ? current.errors : {}),
                [id]: "",
              },
            })),
        }}
      >
        <form
          id={formId}
          noValidate
          onSubmit={async (event) => {
            event.preventDefault();
            if (s.busy || (disabled && !s.retryRequired)) return;
            const form = event.currentTarget;
            const next: Record<string, string> = {};
            form
              .querySelectorAll<
                HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
              >("input:not([type=hidden]),textarea,[data-required=true]")
              .forEach((control) => {
                if (control.disabled || !control.id) return;
                const native =
                  control instanceof HTMLInputElement ||
                  control instanceof HTMLTextAreaElement;
                const dateInput =
                  control instanceof HTMLInputElement && control.type === "date"
                    ? control
                    : null;
                const error = fieldError(
                  native ? control.value : (control.dataset.value ?? ""),
                  {
                    required: native ? control.required : true,
                    minLength: native ? control.minLength : undefined,
                    maxLength: native ? control.maxLength : undefined,
                    money: control.dataset.money === "true",
                    phone:
                      control instanceof HTMLInputElement &&
                      control.type === "tel",
                    date: !!dateInput,
                    minDate: dateInput?.min,
                    maxDate: dateInput?.max,
                  },
                );
                if (error) next[control.id] = error;
              });
            setValidation({ key: validationKey, errors: next });
            if (Object.keys(next).length && !s.retryRequired) {
              document.getElementById(Object.keys(next)[0])?.focus();
              return;
            }
            s.setError("");
            try {
              const retry = s.retryRequired;
              const expected = revision ?? openedRevision?.current;
              if (
                !retry &&
                expected !== undefined &&
                expected !== s.snapshot?.revision
              )
                throw new Error(
                  "Records changed while this form was open. Close and reopen it to review the latest values.",
                );
              if (!retry) attemptedHere.current = true;
              const saved = retry ? await s.retryLast() : await onSubmit();
              if (saved === true && attemptedHere.current) onSuccess?.();
            } catch (error) {
              s.setError(
                error instanceof Error ? error.message : "Operation failed.",
              );
            }
          }}
        >
          {hasRequiredControl(children) && (
            <p className="mb-4 text-xs text-muted-foreground">
              {t("Fields marked * are required.")}
            </p>
          )}
          {Object.values(errors).some(Boolean) && (
            <Alert variant="destructive" className="mb-4" role="alert">
              <AlertDescription>
                {t("Check the highlighted fields before continuing.")}
              </AlertDescription>
            </Alert>
          )}
          <FieldSet
            disabled={s.busy || disabled || s.retryRequired}
            className="gap-5"
          >
            {Children.map(children, (child) =>
              isValidElement(child) && child.type === FormActions
                ? null
                : child,
            )}
          </FieldSet>
          {s.error && (
            <Alert
              ref={submitError}
              tabIndex={-1}
              variant="destructive"
              role="alert"
              className="mt-4 outline-none"
            >
              <AlertDescription>{t(s.error)}</AlertDescription>
            </Alert>
          )}
          {s.retryRequired && (
            <Alert className="mt-4">
              <AlertDescription>
                {t(
                  "The last request has an unconfirmed result. Retry it before continuing.",
                )}
                <Button type="submit" disabled={s.busy}>
                  {t("Retry last request")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {Children.map(children, (child) =>
            isValidElement(child) && child.type === FormActions
              ? cloneElement(child as ReactElement<{ disabled?: boolean }>, {
                  disabled:
                    (child.props as { disabled?: boolean }).disabled ||
                    disabled ||
                    s.retryRequired,
                })
              : null,
          )}
        </form>
      </Errors.Provider>
    </ActionFormId.Provider>
  );
}
export function FormActions({
  children,
  destructive = false,
  disabled = false,
}: {
  children: string;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const host = useContext(ModalFooter);
  const formId = useContext(ActionFormId);
  const actions = (
    <DialogFooter className="mx-0 mb-0 grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-none border-t bg-popover px-0 pb-0 pt-4 sm:mx-0 sm:mb-0 sm:flex sm:px-0 sm:pb-0 sm:pt-4">
      <DialogClose asChild>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={s.busy}
        >
          {t("Cancel")}
        </Button>
      </DialogClose>
      <Button
        type="submit"
        form={formId}
        className="h-11 min-w-0 whitespace-normal leading-snug"
        variant={destructive ? "destructive" : "default"}
        disabled={s.busy || disabled}
      >
        {s.busy && <LoaderCircle className="animate-spin" />}
        {t(s.busy ? "Saving…" : children)}
      </Button>
    </DialogFooter>
  );
  return host ? createPortal(actions, host) : actions;
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  trackChanges = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  trackChanges?: boolean;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const returnFocus = useRef<HTMLElement | null>(null);
  const openedRevision = useRef<number | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);
  return (
    <DirtyContext.Provider value={trackChanges ? () => setDirty(true) : null}>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!s.busy) {
            if (!value && dirty && trackChanges) {
              setConfirmClose(true);
              return;
            }
            s.setError("");
            onOpenChange(value);
          }
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl lg:max-w-2xl [&_input:not([type=hidden]):not([type=checkbox])]:h-11 sm:[&_input:not([type=hidden]):not([type=checkbox])]:h-10 [&_button[role=combobox]]:min-h-11 sm:[&_button[role=combobox]]:min-h-10"
          closeLabel={t("Close")}
          showCloseButton={!s.busy}
          onOpenAutoFocus={() => {
            openedRevision.current = s.snapshot?.revision;
            setDirty(false);
            setConfirmClose(false);
            returnFocus.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault();
              returnFocus.current.focus();
            }
          }}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader className="min-w-0 shrink-0 border-b pb-4">
            <DialogTitle className="pr-8">{t(title)}</DialogTitle>
            <DialogDescription className="min-w-0 [overflow-wrap:anywhere]">
              {t(description)}
            </DialogDescription>
          </DialogHeader>
          <div
            data-slot="modal-body"
            className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1 sm:-mx-6 sm:px-6"
            onChangeCapture={(event) => {
              if (
                trackChanges &&
                !(event.target as HTMLElement).closest(
                  "[cmdk-input], [data-list-controls]",
                )
              )
                setDirty(true);
            }}
            onClickCapture={(event) => {
              if (
                trackChanges &&
                (event.target as HTMLElement).closest(
                  '[role="checkbox"], [role="tab"], [data-mark-dirty="true"]',
                )
              )
                setDirty(true);
            }}
          >
            <FormRevision.Provider value={openedRevision}>
              <ModalFooter.Provider value={footerHost}>
                <div className="space-y-4">{children}</div>
              </ModalFooter.Provider>
            </FormRevision.Provider>
          </div>
          <div
            ref={setFooterHost}
            data-slot="modal-actions"
            className="shrink-0 empty:hidden"
          />
        </DialogContent>
      </Dialog>
      <AlertDialog open={open && confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Discard unsaved changes?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Your changes have not been submitted. Continue editing or discard them.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Continue editing")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDirty(false);
                setConfirmClose(false);
                s.setError("");
                onOpenChange(false);
              }}
            >
              {t("Discard changes")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DirtyContext.Provider>
  );
}
export function Submit({ children }: { children: string }) {
  const t = useText(),
    s = usePokerManagementContext();
  return (
    <Button type="submit" disabled={s.busy}>
      {t(s.busy ? "Saving…" : children)}
    </Button>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  const t = useText();
  return (
    <UiBadge
      variant={tone === "red" ? "destructive" : "secondary"}
      className={
        tone === "green"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : undefined
      }
    >
      {typeof children === "string" ? t(children) : children}
    </UiBadge>
  );
}
export function Stat({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  const t = useText();
  const currency = compact ? value.match(/^(-?)RM\s*(\d[\d,]*\.\d{2})$/) : null;
  const amount = currency ? currency[2] : "";
  const digits = amount.replace(/\D/g, "").length;
  // Reserve enough room for tabular digits and punctuation at the card's width.
  const amountWidth = digits * 0.65 + (amount.length - digits) * 0.4 + 0.4;
  return (
    <Card className={compact ? "gap-0 py-3 sm:py-3" : undefined}>
      <CardHeader className={compact ? "gap-1 px-3 sm:px-3" : undefined}>
        <CardDescription
          className={
            compact
              ? "text-[11px] font-normal leading-4"
              : "text-xs font-medium uppercase tracking-wide"
          }
        >
          {t(label)}
        </CardDescription>
        <p
          className={cn(
            "min-w-0 break-words font-semibold tabular-nums",
            compact
              ? "@container/stat-value text-sm leading-5 [overflow-wrap:anywhere] sm:text-lg sm:leading-6"
              : "text-lg sm:text-2xl",
          )}
        >
          {currency ? (
            <>
              <span className="sr-only">{value}</span>
              <span
                aria-hidden="true"
                className="flex flex-wrap items-baseline gap-x-1"
              >
                <span>{currency[1]}RM</span>
                <span
                  className="whitespace-nowrap"
                  style={{
                    fontSize: `min(1em, ${(100 / amountWidth).toFixed(4)}cqi)`,
                  }}
                >
                  {amount}
                </span>
              </span>
            </>
          ) : (
            value
          )}
        </p>
      </CardHeader>
    </Card>
  );
}
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  const t = useText();
  return (
    <Empty className="border py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox />
        </EmptyMedia>
        <EmptyTitle>{t(title)}</EmptyTitle>
        {description && <EmptyDescription>{t(description)}</EmptyDescription>}
      </EmptyHeader>
      {children}
    </Empty>
  );
}
export function DayNotice() {
  const s = usePokerManagementContext(),
    t = useText();
  if (!s.locked) return null;
  return (
    <div
      role="status"
      className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
    >
      <Info aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{t("Operations paused")}</span>
      <span aria-hidden="true">·</span>
      <Link
        href="/reports"
        className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4 hover:no-underline"
      >
        {t("Open business day")}
      </Link>
    </div>
  );
}
export function Pager({
  page,
  total,
  setPage,
  label = "Record pages",
  pageSize = 20,
}: {
  page: number;
  total: number;
  setPage: (page: number) => void;
  label?: string;
  pageSize?: number;
}) {
  const t = useText();
  const size = Number.isFinite(pageSize)
    ? Math.max(1, Math.floor(pageSize))
    : 20;
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const pages = Math.max(1, Math.ceil(count / size));
  const current = Math.min(
    Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0),
    pages - 1,
  );
  if (count <= size) return null;
  return (
    <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <p
        className="text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {t("Showing")} {current * size + 1}–
        {Math.min((current + 1) * size, count)} {t("of")} {count}
      </p>
      <Pagination className="mx-0 w-auto" aria-label={t(label)}>
        <PaginationContent className="gap-1">
          {pages > 2 && (
            <PaginationItem>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11 sm:size-9"
                aria-label={t("First page")}
                disabled={current === 0}
                onClick={() => setPage(0)}
              >
                <ChevronsLeft aria-hidden="true" />
              </Button>
            </PaginationItem>
          )}
          <PaginationItem>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 px-3 sm:h-9"
              aria-label={t("Previous page")}
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft aria-hidden="true" />
              <span className="hidden sm:inline">{t("Previous")}</span>
            </Button>
          </PaginationItem>
          <PaginationItem>
            <span
              className="whitespace-nowrap px-2 text-xs tabular-nums sm:text-sm"
              aria-current="page"
            >
              <span className="sr-only">{t("Page")} </span>
              {current + 1} / {pages}
            </span>
          </PaginationItem>
          <PaginationItem>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 px-3 sm:h-9"
              aria-label={t("Next page")}
              disabled={current + 1 >= pages}
              onClick={() => setPage(current + 1)}
            >
              <span className="hidden sm:inline">{t("Next")}</span>
              <ChevronRight aria-hidden="true" />
            </Button>
          </PaginationItem>
          {pages > 2 && (
            <PaginationItem>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11 sm:size-9"
                aria-label={t("Last page")}
                disabled={current + 1 >= pages}
                onClick={() => setPage(pages - 1)}
              >
                <ChevronsRight aria-hidden="true" />
              </Button>
            </PaginationItem>
          )}
        </PaginationContent>
      </Pagination>
    </div>
  );
}
