import * as React from 'react';
import { formatMoneyInput, moneyEdit, ungroupMoney } from '@/lib/money-input';

// Used only by explicitly marked money fields. PINs and quantities remain native inputs.
export const MoneyInput = React.forwardRef(function MoneyInput(
  /** @type {React.InputHTMLAttributes<HTMLInputElement>} */
  { value, defaultValue, onChange, onKeyDown, inputMode, type, min, max, step, ...props }, ref,
) {
  const [draft, setDraft] = React.useState(() => formatMoneyInput(value ?? defaultValue));
  const inputRef = React.useRef(null);
  const lastEmitted = React.useRef(value);
  const selection = React.useRef(null);
  React.useImperativeHandle(ref, () => inputRef.current);

  React.useLayoutEffect(() => {
    if (value !== undefined && !Object.is(value, lastEmitted.current)) {
      lastEmitted.current = value;
      setDraft(formatMoneyInput(value));
    }
  }, [value]);

  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (selection.current !== null) {
      input.setSelectionRange(selection.current, selection.current);
      selection.current = null;
    }
    // Text inputs cannot enforce number min/max/step themselves. Reuse the browser's
    // native numeric validity rules without exposing grouped text to number parsing.
    if (['-', '.', '-.'].includes(ungroupMoney(draft))) {
      input.setCustomValidity('Summani to‘liq kiriting.');
    } else if (type === 'number') {
      const validator = input.ownerDocument.createElement('input');
      validator.type = 'number';
      if (min !== undefined) validator.min = String(min);
      if (max !== undefined) validator.max = String(max);
      if (step !== undefined) validator.step = String(step);
      validator.value = ungroupMoney(draft);
      input.setCustomValidity(validator.validationMessage);
    } else {
      input.setCustomValidity('');
    }
  }, [draft, type, min, max, step]);

  const change = (event) => {
    const edit = moneyEdit(event.target.value, event.target.selectionStart ?? event.target.value.length);
    if (!edit) return;
    selection.current = edit.caret;
    setDraft(edit.formatted);
    // Some consumers store numbers, others strings. Remember the value they will
    // render so decimal typing (e.g. 3000.) does not lose the in-progress decimal.
    lastEmitted.current = typeof value === 'number' ? Number(edit.value) : edit.value;
    const target = new Proxy(event.target, { get: (node, key) => {
      if (key === 'value') return edit.value;
      if (key === 'valueAsNumber') return edit.value === '' ? NaN : Number(edit.value);
      const result = Reflect.get(node, key, node);
      return typeof result === 'function' ? result.bind(node) : result;
    } });
    onChange?.({ ...event, target, currentTarget: target });
    // Restore immediately too: deleting only a separator may not trigger a render.
    event.target.value = edit.formatted;
    event.target.setSelectionRange(edit.caret, edit.caret);
  };

  const keyDown = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const input = event.currentTarget;
    const start = input.selectionStart;
    if (start !== input.selectionEnd) return;
    // Skip the visual separator so Backspace/Delete always removes a digit.
    if (event.key === 'Backspace' && start > 0 && input.value[start - 1] === ' ') {
      input.setSelectionRange(Math.max(0, start - 2), start);
    } else if (event.key === 'Delete' && input.value[start] === ' ') {
      input.setSelectionRange(start, start + 2);
    }
  };

  return <input {...props} ref={inputRef} type="text" inputMode={inputMode ?? 'decimal'}
    value={draft} onChange={change} onKeyDown={keyDown} />;
});
