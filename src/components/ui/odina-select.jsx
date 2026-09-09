import React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const EMPTY_VALUE = '__odina_select_empty__';

const normalizeValue = (value) => {
  const normalized = String(value ?? '');
  return normalized === '' ? EMPTY_VALUE : normalized;
};

const optionNodes = (children) => {
  const options = [];

  const visit = (nodes) => {
    React.Children.forEach(nodes, (child) => {
      if (!React.isValidElement(child)) return;
      if (child.type === React.Fragment) {
        visit(child.props.children);
        return;
      }
      if (child.type !== 'option') return;

      options.push({
        value: normalizeValue(child.props.value),
        originalValue: String(child.props.value ?? ''),
        label: child.props.children,
        disabled: Boolean(child.props.disabled),
      });
    });
  };

  visit(children);
  return options;
};

/**
 * Odina-styled replacement for a native <select>.
 * It intentionally keeps the familiar value/onChange contract so existing
 * form and business logic can stay unchanged.
 */
export default function OdinaSelect({
  children,
  value,
  defaultValue,
  onChange,
  disabled = false,
  className,
  contentClassName,
  placeholder,
  name,
  required,
  id,
  ...triggerProps
}) {
  const options = optionNodes(children);
  const emptyOption = options.find((option) => option.value === EMPTY_VALUE);
  const controlledValue = value === undefined ? undefined : normalizeValue(value);
  const initialValue = defaultValue === undefined ? undefined : normalizeValue(defaultValue);

  const handleValueChange = (nextValue) => {
    const nextOption = options.find((option) => option.value === nextValue);
    const next = nextOption?.originalValue ?? (nextValue === EMPTY_VALUE ? '' : nextValue);
    onChange?.({
      target: { value: next, name },
      currentTarget: { value: next, name },
    });
  };

  return (
    <Select
      value={controlledValue}
      defaultValue={initialValue}
      onValueChange={handleValueChange}
      disabled={disabled}
      name={name}
      required={required}
    >
      <SelectTrigger
        id={id}
        className={cn(
          'h-11 rounded-xl border-input bg-card px-3 text-sm font-medium shadow-sm',
          'transition-[border-color,box-shadow,background-color] duration-150',
          'hover:border-brand-olive/70 data-[state=open]:border-brand-olive',
          'data-[state=open]:ring-2 data-[state=open]:ring-brand-olive/20',
          'focus:ring-2 focus:ring-brand-olive/25',
          className,
        )}
        {...triggerProps}
      >
        <SelectValue placeholder={placeholder || emptyOption?.label || 'Tanlang'} />
      </SelectTrigger>
      <SelectContent
        position="popper"
        className={cn(
          'z-[100] max-h-80 rounded-2xl border-brand-sand/45 bg-card p-1.5',
          'premium-shadow-lg',
          contentClassName,
        )}
      >
        {options.map((option, index) => (
          <SelectItem
            key={`${option.value}-${index}`}
            value={option.value}
            disabled={option.disabled}
            className="min-h-11 rounded-xl px-3 pr-9 text-sm font-medium data-[state=checked]:bg-brand-olive/15 data-[state=checked]:text-brand-ink"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
