import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { TEST_PRODUCT_IDS, deleteTestCatalog } from '@/lib/test-catalog-cleanup';
import { Button } from '@/components/ui/button';

export default function TestCatalogCleanup({ user, products, onComplete }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [message, setMessage] = useState('');
  const remaining = products.filter((product) => TEST_PRODUCT_IDS.includes(product.id));
  if (user?.role !== 'admin' || (!remaining.length && !message)) return null;
  const remove = async () => {
    if (running) return;
    setRunning(true); setMessage('');
    try {
      const counts = await deleteTestCatalog(base44, setProgress);
      setMessage(`O‘chirildi: ${counts.Product || 0} mahsulot, ${counts.Recipe || 0} retsept, ${counts.RecipeItem || 0} retsept qatori va ${counts.ProductStock || 0} sinov qoldig‘i. Arxivdan qayta tiklab bo‘lmaydi.`);
      await onComplete();
    } catch (error) {
      setMessage(error?.response?.data?.error || error?.message || 'O‘chirish amalga oshmadi.');
    } finally { setRunning(false); }
  };
  return (
    <div className="mb-5 rounded-2xl border border-destructive/25 bg-destructive/5 p-4 space-y-3">
      <div>
        <p className="font-semibold">Eski sinov katalogini tozalash</p>
        <p className="text-sm text-muted-foreground mt-1">Oldingi {remaining.length} ta sinov mahsuloti, ularning retseptlari va sinov qoldiqlari butunlay o‘chiriladi. Yangi mahsulotlar, masalliqlar, savdo va pul tarixi saqlanadi.</p>
      </div>
      {remaining.length > 0 && (
        <Button variant="destructive" disabled={running} onClick={remove} className="min-h-11 rounded-xl">
          <Trash2 className="w-4 h-4 mr-2" />
          {running ? `O‘chirilmoqda: ${progress.done}/${progress.total}` : 'Eski sinovlarni butunlay o‘chirish'}
        </Button>
      )}
      {message && <p role="status" className="text-sm">{message}</p>}
    </div>
  );
}
