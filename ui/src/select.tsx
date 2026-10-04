import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import * as Primitive from "@radix-ui/react-select";
import { Icon } from "./common";

export const SelectPortal = createContext<HTMLElement | null>(null);

export function selectIsOpen() {
  return Boolean(document.querySelector("[data-laci-select-popup]"));
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// Radix reserves the empty string for its placeholder. Keep API/form values intact.
const EMPTY = "__laci_empty_value__";
export function Select({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  id,
  disabled,
  className = "inp",
  children,
}: {
  label: string;
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const container = useContext(SelectPortal);
  const [local, setLocal] = useState(defaultValue ?? options[0]?.value ?? "");
  const selected = value ?? local;
  return (
    <>
      {name ? (
        <input type="hidden" name={name} value={selected} disabled={disabled} />
      ) : null}
      <Primitive.Root
        value={selected || EMPTY}
        onValueChange={(next) => {
          const decoded = next === EMPTY ? "" : next;
          setLocal(decoded);
          onValueChange?.(decoded);
        }}
        disabled={disabled}
      >
        <Primitive.Trigger
          id={id}
          className={`select-trigger ${className}`}
          aria-label={label}
        >
          {children ?? <Primitive.Value className="select-value" />}
          <Primitive.Icon className="select-chevron">
            <Icon name="chev" className="sm" />
          </Primitive.Icon>
        </Primitive.Trigger>
        <Primitive.Portal container={container ?? undefined}>
          <Primitive.Content
            className="select-popup"
            data-laci-select-popup=""
            data-compact={className.includes("terminal-target") || undefined}
            position="popper"
            side="bottom"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            <Primitive.ScrollUpButton className="select-scroll">
              ↑
            </Primitive.ScrollUpButton>
            <Primitive.Viewport className="select-options">
              {options.map((option) => (
                <Primitive.Item
                  className="select-option"
                  key={option.value}
                  value={option.value || EMPTY}
                  data-value={option.value}
                  textValue={option.label}
                  disabled={option.disabled}
                >
                  <Primitive.ItemText>{option.label}</Primitive.ItemText>
                  <Primitive.ItemIndicator className="select-check">
                    ✓
                  </Primitive.ItemIndicator>
                </Primitive.Item>
              ))}
            </Primitive.Viewport>
            <Primitive.ScrollDownButton className="select-scroll">
              ↓
            </Primitive.ScrollDownButton>
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </>
  );
}
