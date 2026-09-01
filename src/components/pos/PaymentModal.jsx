import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, X, Check } from 'lucide-react';
import { PAYMENT_METHODS, formatUZS } from '@/lib/pos';

export default function PaymentModal({ open, total, onClose, onConfirm, loading }) {
  const [payments, setPayments] = useState([{ method: 'cash', amount: total }]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setPayments([{ method: 'cash', amount: total }]);
      setError('');
    }
  }, [open, total]);

  const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const remaining = Math.max(0, total - paid);
  const overpay = Math.max(0, paid - total);

  const updatePayment = (idx, field, value) => {
    setPayments((prev) => prev.map((p, i) => i === idx ? { ...p, [field]: field === 'method' ? value : (value === '' ? '' : Number(value)) } : p));
  };

  const addRow = () => {
    if (payments.length >= PAYMENT_METHODS.length) return;
    const used = payments.map((p) => p.method);
    const next = PAYMENT_METHODS.find((m) => !used.includes(m.id));
    setPayments([...payments, { method: next?.id || 'cash', amount: remaining }]);
  };

  const removeRow = (idx) => setPayments((prev) => prev.filter((_, i) => i !== idx));

  const handleConfirm = () => {
    const valid = payments.filter((p) => Number(p.amount) > 0);
    if (valid.length === 0) { setError('Enter at least one payment.'); return; }
    const sum = valid.reduce((s, p) => s + Number(p.amount), 0);
    if (Math.abs(sum - total) > 1) {
      setError(`Total is ${formatUZS(total)} but payments sum to ${formatUZS(sum)}. Difference: ${formatUZS(Math.abs(sum - total))}.`);
      return;
    }
    onConfirm(valid.map((p) => ({ method: p.method, amount: Number(p.amount) })));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Payment</DialogTitle>
        </DialogHeader>

        <div className="rounded-2xl bg-primary/10 px-4 py-3 mb-4 flex items-center justify-between">
          <span className="text-sm font-medium text-primary-strong">Total to collect</span>
          <span className="font-display text-2xl font-bold text-primary-strong">{formatUZS(total)}</span>
        </div>

        <div className="space-y-2.5">
          {payments.map((p, idx) => (
            <div key={idx} className="flex gap-2 items-center">
              <select
                value={p.method}
                onChange={(e) => updatePayment(idx, 'method', e.target.value)}
                className="h-10 rounded-lg border border-input bg-card px-2 text-sm font-medium flex-1 min-w-0"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <Input
                type="number"
                value={p.amount}
                onChange={(e) => updatePayment(idx, 'amount', e.target.value)}
                className="w-32 h-10 text-right font-medium"
                placeholder="0"
              />
              {payments.length > 1 && (
                <button onClick={() => removeRow(idx)} className="w-9 h-10 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-destructive shrink-0">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between mt-3 text-sm">
          <button onClick={addRow} disabled={remaining <= 0 && payments.length >= PAYMENT_METHODS.length} className="text-primary-strong font-medium flex items-center gap-1 disabled:opacity-40">
            <Plus className="w-4 h-4" /> Add split payment
          </button>
          <div className="text-right">
            {remaining > 0 ? (
              <span className="text-destructive font-medium">Remaining {formatUZS(remaining)}</span>
            ) : overpay > 0 ? (
              <span className="text-primary-strong font-medium">Change {formatUZS(overpay)}</span>
            ) : (
              <span className="text-emerald-600 font-medium flex items-center gap-1"><Check className="w-4 h-4" /> Exact</span>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-destructive mt-2">{error}</p>}

        <DialogFooter className="mt-4 gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={loading} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {loading ? 'Processing…' : `Complete · ${formatUZS(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}