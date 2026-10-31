import React from 'react';
import { Button } from '@/components/ui/button';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';

export default function WholesaleHistory({ rows, loading, hasMore, onMore, onResume, error }) {
  return <section className="space-y-3"><h2 className="text-xl">List savdolari tarixi</h2>
    <p className="text-sm text-muted-foreground">Ushbu savdolar alohida jurnalga yoziladi; chakana Kassa va Budjetga avtomatik qo‘shilmaydi.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!loading && !rows.length && !error && <p className="text-muted-foreground">Hali savdo yo‘q.</p>}
    {rows.map(sale => <div key={sale.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
      <div><p className="font-semibold">{sale.buyer_name} · {sale.product_name}</p>
        <p className="text-sm">{sale.quantity} list × {formatUZS(sale.unit_price)} = {formatUZS(sale.total)}</p>
        <p className="text-xs text-muted-foreground">{formatUzbekistanDateTime(sale.sold_at || sale.created_date)} · {sale.payment_method === 'cash' ? 'Naqd pul' : 'Bank o‘tkazmasi'} · {sale.seller_name}</p>
        <p className="text-sm">{{ draft: 'Tasdiqlanmagan', processing: 'Yakunlash kutilmoqda — qayta pul olmang', completed: 'Sotildi', cancelled: 'Bekor qilingan' }[sale.status]}</p>
        {sale.status === 'completed' && sale.buyer_type === 'branch' && <p className="text-xs text-muted-foreground">Filial kirimi “Ombor → Transferlar” orqali qabul qilinadi.</p>}
      </div>
      {['draft', 'processing'].includes(sale.status) && <Button variant="outline" onClick={() => onResume(sale)}>Hujjatni ochish</Button>}
    </div>)}
    {loading && <p role="status">Yuklanmoqda…</p>}
    {hasMore && <Button variant="outline" disabled={loading} onClick={onMore}>Yana ko‘rsatish</Button>}
  </section>;
}