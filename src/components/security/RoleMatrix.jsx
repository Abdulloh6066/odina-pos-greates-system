import React from 'react';
import { ROLE_MENU, MENU_ITEMS } from '@/lib/pos';
import { Check, X } from 'lucide-react';

const ROLES = [
  { key: 'admin', label: 'Admin' },
  { key: 'manager', label: 'Boshqar.' },
  { key: 'cashier', label: 'Kassir' },
  { key: 'accountant', label: 'Hisobchi' },
  { key: 'production', label: 'Ishlab chiq.' },
  { key: 'warehouse', label: 'Omborchi' },
];

export default function RoleMatrix() {
  const items = MENU_ITEMS.filter((m) => m.key !== 'screens');
  return (
    <section className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5">
      <h2 className="font-display text-lg font-bold mb-1">Rol va ruxsat matritsasi</h2>
      <p className="text-xs text-muted-foreground mb-4">Har bir rol qaysi bo'limlarni ko'ra oladi. "Ekranlar" alohida yo'nalish sifatida boshqariladi.</p>
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left font-semibold px-2 py-2.5">Bo'lim</th>
              {ROLES.map((r) => <th key={r.key} className="px-2 py-2.5 text-center font-semibold">{r.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key} className="border-b border-border/60 last:border-0">
                <td className="px-2 py-2.5 font-medium">{item.label}</td>
                {ROLES.map((r) => {
                  const allowed = (ROLE_MENU[r.key] || []).includes(item.key);
                  return (
                    <td key={r.key} className="px-2 py-2.5 text-center">
                      {allowed
                        ? <Check className="w-4 h-4 text-emerald-600 mx-auto" />
                        : <X className="w-4 h-4 text-muted-foreground/40 mx-auto" />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}