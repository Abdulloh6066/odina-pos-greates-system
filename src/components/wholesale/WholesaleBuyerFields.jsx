import React from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function WholesaleBuyerFields({ form, setForm, branches }) {
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }));
  return <div className="space-y-3">
    <div><Label>Xaridor turi</Label><OdinaSelect value={form.buyer_type} onChange={e => change('buyer_type', e.target.value)}>
      <option value="branch">Odina filiali</option><option value="external">Tashqi do‘kon</option>
    </OdinaSelect></div>
    <div><Label>{form.buyer_type === 'branch' ? 'Odina filiali' : 'Tashqi do‘kon nomi'}</Label>
      {form.buyer_type === 'branch' ? <OdinaSelect value={form.buyer_id} onChange={e => change('buyer_id', e.target.value)}>
        <option value="">Filialni tanlang</option>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </OdinaSelect> : <Input aria-label="Tashqi do‘kon nomi" maxLength={120} value={form.buyer_name} onChange={e => change('buyer_name', e.target.value)} />}
    </div>
    <div><Label>Miqdor (list)</Label><Input aria-label="Miqdor (list)" type="number" min="0.5" max="10000" step="0.5" value={form.quantity} onChange={e => change('quantity', e.target.value)} /></div>
    <div><Label>Qabul qilingan to‘lov</Label><OdinaSelect value={form.payment_method} onChange={e => change('payment_method', e.target.value)}>
      <option value="cash">Naqd pul</option><option value="bank_transfer">Bank o‘tkazmasi</option>
    </OdinaSelect></div>
  </div>;
}