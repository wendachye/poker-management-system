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
import { toast } from "sonner";
import { useLocale, useMessages } from "next-intl";
import { ChevronsUpDown, Inbox, LoaderCircle, Info } from "lucide-react";
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
import { RadioGroup } from "radix-ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  RequestRecoveryAlert,
  RequestRecoveryResult,
} from "./request-recovery-alert";
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
import { Link } from "@/i18n/navigation";
import { ListPager } from "./list-order-controls";
import { fieldError } from "@/lib/form-validation";
import { cn } from "@/lib/utils";
import {
  matchesSearchChoice,
  type SearchChoiceOption,
} from "@/lib/operation-form-options";
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
  title?: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  const t = useText();
  return (
    <Card
      className={cn(
        "min-w-0 gap-3 py-3 sm:gap-4 sm:py-6",
        compact && "gap-2.5 sm:gap-3 sm:py-4",
      )}
    >
      {(title || description || action) && (
        <CardHeader
          className={
            compact
              ? "flex flex-col items-stretch gap-1.5 px-3 sm:gap-2 sm:px-4"
              : action
                ? "px-3 max-sm:flex max-sm:flex-col max-sm:gap-2 sm:px-6"
                : "px-3 sm:px-6"
          }
        >
          {compact && (title || action) ? (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              {title && (
                <CardTitle>
                  <h2 className="text-sm">{t(title)}</h2>
                </CardTitle>
              )}
              {action && (
                <div className={cn("min-w-0 max-w-full", !title && "ml-auto")}>
                  {action}
                </div>
              )}
            </div>
          ) : !compact && title ? (
            <CardTitle className="text-sm sm:text-base">
              <h2>{t(title)}</h2>
            </CardTitle>
          ) : null}
          {description && (
            <CardDescription
              className={
                compact
                  ? "text-xs leading-4 sm:leading-5"
                  : "text-xs leading-4 sm:text-sm sm:leading-relaxed"
              }
            >
              {t(description)}
            </CardDescription>
          )}
          {!compact && action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent
        className={
          compact
            ? "space-y-2.5 px-3 sm:space-y-3 sm:px-4"
            : "space-y-3 px-3 sm:space-y-4 sm:px-6"
        }
      >
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
  children: ReactElement;
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
        child.type === Checkbox
          ? "min-w-0 gap-1.5 rounded-lg border p-2.5 sm:gap-2 sm:p-3"
          : "min-w-0 gap-1.5 sm:gap-2"
      }
    >
      <FieldLabel
        htmlFor={id}
        className="flex-wrap gap-x-1.5 text-xs sm:text-sm"
      >
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
      {hint && (
        <FieldDescription
          id={id + "-hint"}
          className="text-xs leading-4 sm:text-sm sm:leading-normal"
        >
          {t(hint)}
        </FieldDescription>
      )}
      {error && <FieldError id={id + "-error"}>{t(error)}</FieldError>}
    </UiField>
  );
}
export function FormSection({
  title,
  description,
  hideTitle = false,
  children,
}: {
  title: string;
  description?: string;
  hideTitle?: boolean;
  children: ReactNode;
}) {
  const t = useText();
  return (
    <fieldset className="min-w-0 space-y-3 border-b pb-4 last:border-0 last:pb-0 sm:space-y-4 sm:pb-5">
      <FieldLegend
        variant="label"
        className={hideTitle ? "sr-only m-0" : "mb-2 font-semibold sm:mb-3"}
      >
        {t(title)}
      </FieldLegend>
      {description && (
        <p className="text-xs leading-4 text-muted-foreground sm:text-sm sm:leading-relaxed">
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
      className={cn(
        "grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
type ChoiceProps = {
  options: SearchChoiceOption[];
  value: string;
  onValueChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  onSearchChange?: (query: string) => void;
  searching?: boolean;
};
export function ChoiceButtons({
  options,
  value,
  onValueChange,
  required,
  disabled,
  className,
  ...props
}: ChoiceProps) {
  const t = useText();
  const markDirty = useContext(DirtyContext);
  return (
    <RadioGroup.Root
      {...props}
      value={value}
      required={required}
      disabled={disabled}
      data-required={(required && !disabled) || undefined}
      data-value={value}
      onValueChange={(next) => {
        markDirty?.();
        onValueChange(next);
      }}
      className={cn(
        "grid min-w-0 grid-cols-3 gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          asChild
        >
          <Button
            type="button"
            variant={value === option.value ? "default" : "outline"}
            className="h-10 min-w-0 whitespace-normal px-2 sm:h-11"
          >
            {t(option.label)}
          </Button>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
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
  const selected = options.find((option) => option.value === value);
  const contextId = useId();
  const context = selected?.description ? t(selected.description) : undefined;
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
        aria-describedby={
          [props["aria-describedby"], context && contextId]
            .filter(Boolean)
            .join(" ") || undefined
        }
        data-required={required || undefined}
        data-value={value}
        title={
          selected
            ? [
                t(selected.label),
                selected.description && t(selected.description),
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
      >
        <SelectValue>
          {selected
            ? t(selected.label)
            : value
              ? t("Unavailable selection")
              : undefined}
        </SelectValue>
      </SelectTrigger>
      {context && (
        <span id={contextId} className="sr-only">
          {context}
        </span>
      )}
      <SelectContent className="max-w-[calc(100vw-2rem)]">
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value || "__none__"}
            disabled={o.disabled}
            textValue={t(o.label)}
            className={
              o.description
                ? "min-h-10 min-w-0 sm:min-h-11 [&>span:last-child]:min-w-0"
                : undefined
            }
          >
            <span className="block min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
              <span className="block">{t(o.label)}</span>
              {o.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t(o.description)}
                </span>
              )}
            </span>
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
  onSearchChange,
  searching,
  searchLabel = "Search by name or phone",
  searchPlaceholder = searchLabel,
  emptyText = "No matching players.",
  placeholder = "Select player",
  ...props
}: ChoiceProps & {
  searchLabel?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    t = useText();
  const markDirty = useContext(DirtyContext);
  const selected = options.find((option) => option.value === value);
  const contextId = useId();
  const context = selected?.description ? t(selected.description) : undefined;
  const searchOptions = new Map(
    options.map((option) => [
      (option.value + " " + option.label).trim(),
      option,
    ]),
  );
  // Remote results stay authoritative. Only the empty selection needs local
  // handling so keyboard search cannot activate a placeholder instead of a row.
  const visibleOptions = options.filter((option) => {
    if (option.value || !query.trim()) return true;
    if (t(option.label) === t(placeholder)) return false;
    return matchesSearchChoice(
      { value: "", label: t(option.label), searchTerms: [option.label] },
      query,
    );
  });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          onSearchChange?.("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          {...props}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-required={required}
          aria-describedby={
            [props["aria-describedby"], context && contextId]
              .filter(Boolean)
              .join(" ") || undefined
          }
          aria-busy={searching || undefined}
          data-required={required || undefined}
          data-value={value}
          disabled={disabled}
          title={
            selected
              ? [
                  t(selected.label),
                  selected.description && t(selected.description),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
          className={cn(
            "w-full min-w-0 justify-between px-3 text-sm font-normal",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {t(
              selected?.label ??
                (value ? "Unavailable selection" : placeholder),
            )}
          </span>
          <ChevronsUpDown
            aria-hidden="true"
            className="size-4 shrink-0 opacity-50"
          />
        </Button>
      </PopoverTrigger>
      {context && (
        <span id={contextId} className="sr-only">
          {context}
        </span>
      )}
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"
      >
        <Command
          label={t(searchLabel)}
          shouldFilter={!onSearchChange}
          filter={(itemValue, query) => {
            const option = searchOptions.get(itemValue);
            return option &&
              matchesSearchChoice(
                {
                  ...option,
                  label: t(option.label),
                  description: option.description
                    ? t(option.description)
                    : undefined,
                  searchTerms: [
                    option.label,
                    ...(option.description ? [option.description] : []),
                    ...(option.searchTerms ?? []),
                  ],
                },
                query,
              )
              ? 1
              : 0;
          }}
        >
          <CommandInput
            placeholder={t(searchPlaceholder)}
            aria-label={t(searchLabel)}
            value={query}
            onValueChange={(next) => {
              setQuery(next);
              onSearchChange?.(next);
            }}
          />
          <CommandList aria-busy={searching || undefined}>
            {searching ? (
              <p
                role="status"
                className="px-3 py-3 text-sm text-muted-foreground"
              >
                {t("Loading records…")}
              </p>
            ) : (
              <CommandEmpty>{t(emptyText)}</CommandEmpty>
            )}
            <CommandGroup>
              {visibleOptions.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value + " " + o.label}
                  disabled={o.disabled || searching}
                  data-checked={value === o.value || undefined}
                  className="min-h-10 min-w-0 items-center py-1 sm:min-h-11 sm:py-1.5"
                  onSelect={() => {
                    if (o.disabled || searching) return;
                    markDirty?.();
                    onValueChange(o.value);
                    setQuery("");
                    setOpen(false);
                    onSearchChange?.("");
                  }}
                >
                  <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">
                    <span className="block">{t(o.label)}</span>
                    {o.description && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t(o.description)}
                      </span>
                    )}
                  </span>
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
  const invalidFocus = useRef<string | null>(null);
  const attemptedHere = useRef(false);
  const openedRevision = useContext(FormRevision);
  useEffect(() => {
    const id = invalidFocus.current;
    if (!id) return;
    invalidFocus.current = null;
    const control = document.getElementById(id);
    control?.focus({ preventScroll: true });
    control?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [validation]);
  useEffect(() => {
    if (s.error) submitError.current?.focus();
  }, [s.error]);
  return (
    <ActionFormId.Provider value={formId}>
      <Errors.Provider
        value={{
          errors,
          clear: (id) => {
            setValidation((current) => ({
              key: validationKey,
              errors: {
                ...(current.key === validationKey ? current.errors : {}),
                [id]: "",
              },
            }));
            if (attemptedHere.current && s.error && !s.retryRequired)
              s.setError("");
          },
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
              invalidFocus.current = Object.keys(next)[0];
              return;
            }
            s.setError("");
            try {
              const retry = s.retryRequired;
              const expected = revision ?? openedRevision?.current;
              if (!retry) attemptedHere.current = true;
              const saved = retry
                ? await s.retryLast()
                : await s.withReviewedRevision(expected, onSubmit);
              if (saved === true && attemptedHere.current) onSuccess?.();
            } catch (error) {
              s.setError(
                error instanceof Error ? error.message : "Operation failed.",
              );
            }
          }}
        >
          {Object.values(errors).some(Boolean) && (
            <Alert variant="destructive" className="mb-4" role="alert">
              <AlertDescription>
                {t("Check the highlighted fields before continuing.")}
              </AlertDescription>
            </Alert>
          )}
          <FieldSet
            disabled={s.busy || disabled || s.retryRequired}
            className="min-w-0 gap-4 sm:gap-5"
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
          <RequestRecoveryAlert
            state={s}
            t={t}
            className="mt-4"
            onRetry={() => {
              void s.retryLast().then((saved) => {
                if (saved && attemptedHere.current) onSuccess?.();
              });
            }}
          />
          <RequestRecoveryResult state={s} t={t} className="mt-4" />
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
  summary,
}: {
  children: string;
  destructive?: boolean;
  disabled?: boolean;
  summary?: ReactNode;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const host = useContext(ModalFooter);
  const formId = useContext(ActionFormId);
  const actions = (
    <DialogFooter
      className={cn(
        "mx-0 mb-0 grid grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-none border-t bg-popover px-0 pb-0 pt-3 sm:mx-0 sm:mb-0 sm:flex sm:gap-3 sm:px-0 sm:pb-0 sm:pt-4",
        summary &&
          "sm:grid sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center",
      )}
    >
      {summary && (
        <div className="col-span-2 min-w-0 text-left sm:col-span-1">
          {summary}
        </div>
      )}
      <DialogClose asChild>
        <Button
          type="button"
          variant="outline"
          className="h-10 sm:h-11"
          disabled={s.busy}
        >
          {t("Cancel")}
        </Button>
      </DialogClose>
      <Button
        type="submit"
        form={formId}
        className="h-10 min-w-0 whitespace-normal leading-snug sm:h-11"
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
  fallbackFocus,
  initialFocus = "first-control",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  trackChanges?: boolean;
  fallbackFocus?: () => HTMLElement | null;
  initialFocus?: "first-control" | "heading";
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleFocus = useRef<HTMLHeadingElement | null>(null);
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
          className="flex max-h-[calc(100dvh-2rem)] flex-col gap-3 overflow-hidden p-3 sm:max-w-xl sm:gap-4 sm:p-6 lg:max-w-2xl [&_input:not([type=hidden]):not([type=checkbox])]:h-10 [&_button[role=combobox]]:min-h-10"
          closeLabel={t("Close")}
          showCloseButton={!s.busy}
          onOpenAutoFocus={(event) => {
            toast.dismiss();
            openedRevision.current = s.snapshot?.revision;
            setDirty(false);
            setConfirmClose(false);
            returnFocus.current = document.activeElement as HTMLElement;
            if (initialFocus === "heading") {
              event.preventDefault();
              titleFocus.current?.focus({ preventScroll: true });
            }
          }}
          onCloseAutoFocus={(event) => {
            const target =
              returnFocus.current?.isConnected &&
              returnFocus.current !== document.body
                ? returnFocus.current
                : fallbackFocus?.();
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader className="min-w-0 shrink-0 gap-1 border-b pb-3 sm:gap-1.5 sm:pb-4">
            <DialogTitle
              ref={titleFocus}
              tabIndex={initialFocus === "heading" ? -1 : undefined}
              className="pr-8 text-[14px] outline-none sm:text-base"
            >
              {t(title)}
            </DialogTitle>
            <DialogDescription className="min-w-0 text-xs leading-4 [overflow-wrap:anywhere] sm:text-sm sm:leading-relaxed">
              {t(description)}
            </DialogDescription>
          </DialogHeader>
          <div
            data-slot="modal-body"
            className="-mx-3 min-h-0 overflow-y-auto overscroll-contain px-3 pb-1 sm:-mx-6 sm:px-6"
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
                <div className="space-y-3 sm:space-y-4">{children}</div>
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
            <AlertDialogTitle>
              {t(
                s.retryRequired
                  ? "Close this form?"
                  : "Discard unsaved changes?",
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                s.retryRequired
                  ? "Closing the form keeps the request recovery information. Check the previous request before entering it again."
                  : "Continue editing or close this form and discard its draft.",
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
              {t(s.retryRequired ? "Close form" : "Discard changes")}
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
  const currency = value.match(/^(-?)RM\s*(\d[\d,]*\.\d{2})$/);
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
            "@container/stat-value min-w-0 break-words font-semibold tabular-nums",
            compact
              ? "text-sm leading-5 [overflow-wrap:anywhere] sm:text-lg sm:leading-6"
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
export function Pager(props: {
  page: number;
  total: number | null;
  setPage: (page: number) => void;
  label?: string;
  loading?: boolean;
  pageSize?: number;
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const t = useText();
  return <ListPager {...props} t={t} />;
}
