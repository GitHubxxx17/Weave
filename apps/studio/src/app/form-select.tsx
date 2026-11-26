import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

type FormSelectOption = {
  readonly value: string;
  readonly label: string;
};

type FormSelectProps = {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly options: readonly FormSelectOption[];
  readonly onChange: (value: string) => void;
};

type FormSelectMenuPosition = {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
};

/** Result of parsing one optional numeric Provider field from its input string. */
export type ParsedNumberField =
  { readonly ok: true; readonly value: number | undefined } | { readonly ok: false };

/**
 * Parses an optional numeric Provider field: an empty string means "unset",
 * otherwise the value must be a finite number in range (temperature 0–2, or a
 * positive integer).
 */
export function parseProviderNumberField(
  raw: string,
  kind: 'temperature' | 'positiveInt',
): ParsedNumberField {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, value: undefined };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false };
  }
  if (kind === 'temperature') {
    return value >= 0 && value <= 2 ? { ok: true, value } : { ok: false };
  }
  return Number.isInteger(value) && value > 0 ? { ok: true, value } : { ok: false };
}

/**
 * Renders a keyboard-friendly select menu that matches the Studio visual
 * language instead of relying on the operating system's native select popup.
 */
export function FormSelect({
  label,
  value,
  placeholder,
  options,
  onChange,
}: FormSelectProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<FormSelectMenuPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value);

  useEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }

    function updateMenuPosition(): void {
      const trigger = triggerRef.current;
      if (trigger === null) {
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const viewportPadding = 12;
      const optionHeight = 42;
      const desiredHeight = Math.min(240, options.length * optionHeight + 10);
      const spaceBelow = window.innerHeight - triggerRect.bottom - viewportPadding;
      const spaceAbove = triggerRect.top - viewportPadding;
      const shouldOpenAbove = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
      const maxHeight = Math.max(
        120,
        Math.min(desiredHeight, shouldOpenAbove ? spaceAbove : spaceBelow),
      );
      const left = Math.min(
        triggerRect.left,
        Math.max(viewportPadding, window.innerWidth - triggerRect.width - viewportPadding),
      );

      setMenuPosition({
        top: shouldOpenAbove
          ? Math.max(viewportPadding, triggerRect.top - maxHeight - 6)
          : triggerRect.bottom + 6,
        left,
        width: triggerRect.width,
        maxHeight,
      });
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (
        containerRef.current?.contains(target) !== true &&
        menuRef.current?.contains(target) !== true
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, options.length]);

  function handleButtonKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsOpen(true);
    }
  }

  return (
    <div className={`form-select${isOpen ? ' form-select-open' : ''}`} ref={containerRef}>
      <button
        className="form-select-trigger"
        type="button"
        ref={triggerRef}
        aria-label={label}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={handleButtonKeyDown}
      >
        <span className={selectedOption === undefined ? 'form-select-placeholder' : undefined}>
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {isOpen && menuPosition !== null
        ? createPortal(
            <div
              className="form-select-menu"
              ref={menuRef}
              role="menu"
              aria-label={label}
              onPointerDown={(event) => event.stopPropagation()}
              style={{
                top: menuPosition.top,
                left: menuPosition.left,
                width: menuPosition.width,
                maxHeight: menuPosition.maxHeight,
              }}
            >
              {options.map((option) => (
                <button
                  className={`form-select-option${option.value === value ? ' form-select-option-selected' : ''}`}
                  type="button"
                  role="menuitem"
                  key={option.value}
                  onClick={() => {
                    onChange(option.value);
                    setIsOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === value ? <Check aria-hidden="true" /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
