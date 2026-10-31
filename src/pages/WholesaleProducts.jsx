import React, { useEffect, useState } from 'react';
import { useOutletContext, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import OdinaSelect from '@/components/ui/odina-select';
import WholesaleCatalog from '@/components/wholesale/WholesaleCatalog';
import WholesaleHistory from '@/components/wholesale/WholesaleHistory';
import WholesaleSaleDialog from '@/components/wholesale/WholesaleSaleDialog';
import useWholesalePage, { wholesaleCall } from '@/hooks/useWholesalePage';

export default function WholesaleProducts() {
  const { user, adminShopScope } = useOutletContext();
  const [setup, setSetup] = useState({ sources: [], branches: [] });
  const [setupError, setSetupError] = useState(''), [setupLoading, setSetupLoading] = useState(true);
  const [localSource, setLocalSource] = useState(''), [search, setSearch] = useState('');
  const [selection, setSelection] = useState(null), [revision, setRevision] = useState(0);
  const scopeId = user.role === 'admin' ? adminShopScope?.specificShopId : user.shop_id;
  const sourceId = scopeId || localSource;
  const validSource = setup.sources.some(s => s.id === sourceId) ? sourceId : '';
  const data = useWholesalePage(validSource, search, revision);
  useEffect(() => {
    let live = true;
    wholesaleCall({ action: 'setup' }).then(value => { if (live) { setSetup(value); setLocalSource(value.sources[0]?.id || ''); } })
      .catch(e => { if (live) setSetupError(e?.response?.data?.error || e.message); })
      .finally(() => { if (live) setSetupLoading(false); });
    return () => { live = false; };
  }, [user.id]);
  return <div className="p-4 sm:p-6 space-y-6">
    <header><h1 className="text-2xl font-bold">Mahsulotlar</h1><p className="text-muted-foreground">Odina filiallari va tashqi do‘konlarga sotuv · narx 1 list uchun</p></header>
    {setupError && <p role="alert" className="text-destructive">{setupError}</p>}
    {setupLoading ? <p role="status">Ishlab chiqarish joylari yuklanmoqda…</p> : !scopeId && <OdinaSelect aria-label="Ishlab chiqarish ombori" value={localSource} onChange={e => setLocalSource(e.target.value)}>
      <option value="">Ishlab chiqarish omborini tanlang</option>{setup.sources.map(source => <option value={source.id} key={source.id}>{source.name}</option>)}
    </OdinaSelect>}
    {!setupLoading && !validSource && <p>Ishlab chiqarish joyini tanlang. Bu sahifa chakana do‘kon Kassasidan alohida ishlaydi.</p>}
    {validSource && <>
      <div className="flex flex-wrap gap-3"><Input className="max-w-sm" aria-label="Mahsulotlarni qidirish" placeholder="Mahsulotlarni qidirish…" value={search} onChange={e => setSearch(e.target.value)} />
        <Button variant="outline" disabled={data.loading} onClick={() => setRevision(v => v + 1)}>Yangilash</Button>
        {user.role === 'admin' && <Button asChild variant="outline"><Link to="/3d-plus">List narxlarini belgilash</Link></Button>}</div>
      {data.error && <p role="alert" className="text-destructive">{data.error}</p>}
      <WholesaleCatalog products={data.catalog.items} onSell={product => setSelection({ product })} loading={data.loading && !data.catalog.items.length} />
      {data.catalog.has_more && <Button variant="outline" disabled={data.loading} onClick={data.moreProducts}>Yana mahsulotlar</Button>}
      <WholesaleHistory rows={data.history.items} loading={data.loading} hasMore={data.history.has_more} onMore={data.moreHistory} onResume={sale => setSelection({ sale })} error={data.error} />
    </>}
    {selection && <WholesaleSaleDialog selection={selection} sourceId={validSource} branches={setup.branches} onClose={() => { setSelection(null); setRevision(v => v + 1); }} onSaved={() => setRevision(v => v + 1)} />}
  </div>;
}