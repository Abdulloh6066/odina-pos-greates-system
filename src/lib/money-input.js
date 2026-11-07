// Keep formatting separate from arithmetic: callbacks always receive ungrouped digits.
export function ungroupMoney(value) {
  return String(value ?? '').replace(/[\s\u00a0\u202f]/g, '');
}

export function formatMoneyInput(value) {
  const raw = ungroupMoney(value);
  const match = raw.match(/^(-?)(\d*)(\.\d*)?$/);
  if (!match) return raw;
  return match[1] + match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (match[3] || '');
}

export function moneyCaretPosition(formatted, rawOffset) {
  if (rawOffset <= 0) return 0;
  let count = 0;
  for (let index = 0; index < formatted.length; index++) {
    if (formatted[index] !== ' ') count++;
    if (count === rawOffset) return index + 1;
  }
  return formatted.length;
}

export function moneyEdit(text, caret = text.length) {
  const raw = ungroupMoney(text);
  // Reject ambiguous pasted currency/exponents instead of silently changing amounts.
  if (!/^-?\d*(\.\d*)?$/.test(raw)) return null;
  const formatted = formatMoneyInput(raw);
  return {
    formatted,
    value: ['-', '.', '-.'].includes(raw) ? '' : raw,
    caret: moneyCaretPosition(formatted, ungroupMoney(text.slice(0, caret)).length),
  };
}
