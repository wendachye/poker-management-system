"use client";

import { useId, useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

type PasswordInputProps = ComponentProps<typeof InputGroupInput> & {
  showLabel: string;
  hideLabel: string;
};

function PasswordInput({
  id,
  showLabel,
  hideLabel,
  disabled,
  ...props
}: PasswordInputProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const [visible, setVisible] = useState(false);
  return (
    <InputGroup>
      <InputGroupInput
        {...props}
        id={inputId}
        disabled={disabled}
        type={visible ? "text" : "password"}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          size="icon-sm"
          aria-label={visible ? hideLabel : showLabel}
          aria-controls={inputId}
          aria-pressed={visible}
          disabled={disabled}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

export { PasswordInput };
