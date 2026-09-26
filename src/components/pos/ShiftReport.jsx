import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';

export default function ShiftReport({ shift, onAfterPrint }) {
  const printPendingRef = useRef(false);
  const onAfterPrintRef = useRef(onAfterPrint);

  useEffect(() => {
    onAfterPrintRef.current = onAfterPrint;
  }, [onAfterPrint]);

  useEffect(() => {
    if (!shift || printPendingRef.current) return undefined;
    printPendingRef.current = true;

    const finishPrint = () => {
      if (!printPendingRef.current) return;
      printPendingRef.current = false;
      window.removeEventListener('afterprint', finishPrint);
      document.body.classList.remove('odina-shift-printing');
      onAfterPrintRef.current?.();
    };

    window.addEventListener('afterprint', finishPrint);
    document.body.classList.add('odina-shift-printing');
    const timer = window.setTimeout(() => {
      try {
        window.print();
      } catch {
        finishPrint();
      }
    }, 50);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', finishPrint);
      printPendingRef.current = false;
      document.body.classList.remove('odina-shift-printing');
    };
  }, [shift]);

  if (!shift) return null;

  const bankCard = Number(shift.uzcard_sales || 0) + Number(shift.humo_sales || 0);
  const rows = [
    ['Naqd savdo', formatUZS(shift.cash_sales)],
    ['Bank card savdosi', formatUZS(bankCard)],
    ['Online savdo', formatUZS(shift.online_sales)],
    ...(Number(shift.bank_transfer_sales || 0) !== 0
      ? [['Eski bank o‘tkazmalari', formatUZS(shift.bank_transfer_sales)]]
      : []),
    ['Jami savdo', formatUZS(shift.total_sales), true],
    ['Buyurtmalar', `${shift.order_count || 0} ta`],
    ['Boshlang‘ich naqd pul', formatUZS(shift.starting_cash)],
    ['Kassadan olingan pul', formatUZS(shift.cash_removed)],
    ['Qaytarishlar', formatUZS(shift.refunds_total)],
    ['Kutilayotgan naqd pul', formatUZS(shift.expected_cash), true],
    ['Sanab chiqilgan naqd pul', formatUZS(shift.actual_cash), true],
    ['Budgetga naqd topshirildi', formatUZS(shift.budget_cash_submitted)],
    ['Kassada qoldirildi', formatUZS(shift.cash_left_for_next_shift)],
    ['Pul farqi', formatUZS(shift.difference), true],
  ];

  return createPortal(
    <div className="receipt-print shift-report hidden font-mono text-[12px] leading-relaxed text-foreground">
      <div className="text-center">
        <div className="text-lg font-bold">ODINA SHOP</div>
        <div>SMENA HISOBOTI</div>
        <div className="text-[11px]">{shift.shop_name} · {shift.user_name}</div>
        <div className="text-[11px]">
          {formatUzbekistanDateTime(shift.opened_at || shift.created_date)} — {formatUzbekistanDateTime(shift.closed_at || Date.now())}
        </div>
      </div>
      <div className="my-2 border-t border-dashed border-border" />
      <div className="font-bold mb-1">Pul hisoboti</div>
      {rows.map(([label, value, bold]) => (
        <div key={label} className={`flex justify-between gap-2 py-0.5 ${bold ? 'font-bold' : ''}`}>
          <span>{label}</span>
          <span className="shrink-0 text-right">{value}</span>
        </div>
      ))}
    </div>,
    document.body
  );
}
