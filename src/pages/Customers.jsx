import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useOutletContext } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Search, Loader2, Phone, Cake, UserCircle, Wallet, ShoppingBag, ChevronRight } from 'lucide-react';
import { fullName, formatPhone, birthdayDisplay, normalizePhone } from '@/lib/customers';
import { formatUZS } from '@/lib/pos';
import CustomerForm from '@/components/customers/CustomerForm';
import CustomerProfile from '@/components/customers/CustomerProfile';
import BirthdayFollowupPanel from '@/components/customers/BirthdayFollowupPanel';
import { useToast } from '@/components/ui/use-toast';
import '@/styles/customers.css';
import '@/styles/catalog-workbench.css';
import PageHeader from '@/components/PageHeader';

export default function Customers() {
  const { user } = useOutletContext();
  const { toast } = useToast();
  const role = user?.role || 'cashier';
  const canEdit = role === 'admin' || role === 'accountant';

  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [profileCustomer, setProfileCustomer] = useState(null);
  const [spendMap, setSpendMap] = useState({});
  const [countMap, setCountMap] = useState({});
  const [sortMode, setSortMode] = useState('default');

  const load = async () => {
    setLoading(true);
    try {
      const list = await base44.entities.Customer.list('first_name', 500);
      setCustomers(list || []);
    } catch {
      setCustomers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Compute lifetime spend per customer (orders by id/phone + sales by id).
  useEffect(() => {
    let cancelled = false;
    const compute = async () => {
      if (!customers.length) { setSpendMap({}); setCountMap({}); return; }
      try {
        const phoneNorms = customers.map((c) => c.phone_normalized || normalizePhone(c.phone)).filter(Boolean);
        const [ordersByPhone, ordersById, salesById] = await Promise.all([
          phoneNorms.length ? base44.entities.CustomerOrder.filter({ customer_phone: { $in: customers.map((c) => c.phone).filter(Boolean) } }, '-created_date', 1000) : Promise.resolve([]),
          base44.entities.CustomerOrder.filter({ customer_id: { $in: customers.map((c) => c.id) } }, '-created_date', 1000).catch(() => []),
          base44.entities.Sale.filter({ customer_id: { $in: customers.map((c) => c.id) } }, '-created_date', 1000).catch(() => []),
        ]);
        if (cancelled) return;
        const map = {};
        const counts = {};
        const normByCustomer = {};
        customers.forEach((c) => { normByCustomer[c.id] = c.phone_normalized || normalizePhone(c.phone); });
        const addOrder = (o) => {
          if (!o || o.order_status === 'bekor_qilindi') return;
          const cid = o.customer_id;
          if (cid && map[cid] === undefined) map[cid] = 0;
          if (cid) map[cid] = (map[cid] || 0) + Number(o.total || 0);
          if (cid) counts[cid] = (counts[cid] || 0) + 1;
        };
        const addByPhone = (o) => {
          if (!o || o.order_status === 'bekor_qilindi') return;
          const n = normalizePhone(o.customer_phone);
          for (const c of customers) {
            if ((c.phone_normalized || normalizePhone(c.phone)) === n) {
              map[c.id] = (map[c.id] || 0) + Number(o.total || 0);
              counts[c.id] = (counts[c.id] || 0) + 1;
              break;
            }
          }
        };
        (ordersById || []).forEach(addOrder);
        (ordersByPhone || []).forEach(addByPhone);
        (salesById || []).forEach((s) => {
          if (!s || s.status !== 'completed') return;
          map[s.customer_id] = (map[s.customer_id] || 0) + Number(s.total || 0);
          counts[s.customer_id] = (counts[s.customer_id] || 0) + 1;
        });
        setSpendMap(map);
        setCountMap(counts);
      } catch {
        if (!cancelled) { setSpendMap({}); setCountMap({}); }
      }
    };
    compute();
    return () => { cancelled = true; };
  }, [customers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = customers;
    if (q) {
      list = customers.filter((c) => {
        return fullName(c).toLowerCase().includes(q) || String(c.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, ''));
      });
    }
    if (sortMode === 'mostBuys') {
      return [...list].sort((a, b) => (countMap[b.id] || 0) - (countMap[a.id] || 0));
    }
    if (sortMode === 'mostSpends') {
      return [...list].sort((a, b) => (spendMap[b.id] || 0) - (spendMap[a.id] || 0));
    }
    return list;
  }, [customers, query, sortMode, countMap, spendMap]);

  const openProfile = (c) => setProfileCustomer(c);
  const openEdit = () => { setEditing(profileCustomer); setFormOpen(true); };

  const onSaved = (saved) => {
    setCustomers((prev) => {
      const idx = prev.findIndex((c) => c.id === saved.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], ...saved }; return next; }
      return [saved, ...prev];
    });
    if (profileCustomer && saved.id === profileCustomer.id) setProfileCustomer((p) => ({ ...p, ...saved }));
  };

  return (
    <div className="odina-customers odina-page odina-workbench catalog-workbench catalog-customers p-5 sm:p-8 max-w-7xl mx-auto">
      <PageHeader title="Mijozlar" subtitle={`${customers.length} ta mijoz ro‘yxatdan o‘tgan`} icon={UserCircle} actions={canEdit && (
          <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus className="w-4 h-4" /> Yangi mijoz
          </Button>
        )} />

      <BirthdayFollowupPanel user={user} />

      <div className="catalog-toolbar customer-directory-toolbar">
      <label className="catalog-filter-field customer-directory-search"><span>Mijoz qidirish</span>
      <div className="customer-search relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ism yoki telefon bo‘yicha qidirish…" className="pl-9 h-11 rounded-xl" />
      </div>
      </label>

      <div className="catalog-filter-field"><span>Saralash</span>
      <div className="customer-sort flex flex-wrap gap-2">
        <Button
          variant={sortMode === 'mostBuys' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={sortMode === 'mostBuys'}
          onClick={() => setSortMode((m) => (m === 'mostBuys' ? 'default' : 'mostBuys'))}
        >
          <ShoppingBag className="w-4 h-4" /> Ko‘p xarid qiluvchi
        </Button>
        <Button
          variant={sortMode === 'mostSpends' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={sortMode === 'mostSpends'}
          onClick={() => setSortMode((m) => (m === 'mostSpends' ? 'default' : 'mostSpends'))}
        >
          <Wallet className="w-4 h-4" /> Ko‘p pul sarflagan
        </Button>
      </div>
      </div>
      </div>

      <div className="catalog-section-heading">
        <div><h2>Mijozlar ro‘yxati</h2><p>Aloqa, xaridlar va umumiy sarf</p></div>
        <span className="catalog-result-count" aria-live="polite">{filtered.length} ta mijoz</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <div className="catalog-empty flex flex-col items-center justify-center py-16 text-center">
          <UserCircle className="w-12 h-12 text-muted-foreground/40 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">Mijoz topilmadi</p>
          {canEdit && <Button variant="outline" className="mt-3" onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="w-4 h-4" /> Mijoz qo‘shish</Button>}
        </div>
      ) : (
        <div className="customer-directory">
          <div className="customer-directory-head" aria-hidden="true"><span>Mijoz</span><span>Aloqa</span><span>Xaridlar</span><span>Umumiy sarf</span><span /></div>
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => openProfile(c)}
              className="customer-card customer-directory-row text-left transition-colors touch-manipulation"
            >
              <div className="customer-directory-identity flex items-center gap-3">
                <div className="customer-avatar w-11 h-11 rounded-full flex items-center justify-center font-semibold shrink-0">
                  {(c.first_name || c.phone || '?').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold break-words">{fullName(c)}</div>
                  {c.birth_date && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                      <Cake className="w-3.5 h-3.5" /> {birthdayDisplay(c.birth_date)}
                    </div>
                  )}
                </div>
              </div>
              <div className="customer-directory-phone"><Phone className="w-3.5 h-3.5" aria-hidden="true" /><span>{formatPhone(c.phone)}</span></div>
              <div className="customer-directory-purchases"><span className="customer-mobile-label">Xaridlar</span><strong>{countMap[c.id] || 0} <span>ta</span></strong></div>
              <div className="customer-directory-spend"><span className="customer-mobile-label">Umumiy sarf</span><strong className="customer-spend">{formatUZS(spendMap[c.id] || 0)}</strong></div>
              <ChevronRight className="customer-directory-chevron w-4 h-4" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}

      <CustomerForm open={formOpen} onClose={() => setFormOpen(false)} onSaved={onSaved} customer={editing} />
      <CustomerProfile
        open={Boolean(profileCustomer)}
        onClose={() => setProfileCustomer(null)}
        customer={profileCustomer}
        onEdit={openEdit}
        canEdit={canEdit}
      />
    </div>
  );
}
