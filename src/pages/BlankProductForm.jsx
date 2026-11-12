import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOutletContext } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { startReceiptPrint } from '@/lib/receipt-print-lifecycle';
import { validRowCount, formWriter, rowCountKey } from '@/lib/blank-product-form';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import '@/styles/blank-product-form.css';

function Paper({ rows, writer, date }) {
  return <div className="blank-form-content">
    <h1>ODINA</h1><h2>Mahsulotlar ro‘yxati</h2>
    <p>Sana: {date}</p><p>Kim yozdi: {writer}</p>
    <p className="blank-form-line">Kim oldi:</p>
    <table><colgroup><col style={{ width: '35%' }} /><col style={{ width: '20%' }} /><col style={{ width: '10%' }} /><col style={{ width: '10%' }} /><col style={{ width: '25%' }} /></colgroup>
      <thead><tr><th>Mahsulot nomi</th><th>Kerakli miqdor</th><th>kg</th><th>dona</th><th>Do‘kondan olingan miqdor</th></tr></thead>
      <tbody>{Array.from({ length: rows }, (_, index) => <tr key={index}><td>&nbsp;</td><td /><td /><td /><td /></tr>)}</tbody>
    </table>
    <p className="blank-form-line">Olingan pul:</p><p className="blank-form-line">Qaytgan pul:</p>
  </div>;
}

export default function BlankProductForm() {
  const { user } = /** @type {{ user: { name?: string, full_name?: string } }} */ (useOutletContext());
  const [rows, setRows] = useState('10');
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [replaceCount, setReplaceCount] = useState(true);
  const [width, setWidth] = useState('80');
  const [job, setJob] = useState(null);
  const [warning, setWarning] = useState('');
  const writer = formWriter(user);
  const valid = validRowCount(rows);
  useEffect(() => {
    if (!job) return undefined;
    return startReceiptPrint({ printClass: 'odina-blank-form-printing', onDone: () => setJob(null),
      onWarning: () => setWarning('Chop etish ochilmadi. Qayta urinib ko‘ring.'), warningMessage: 'Chop etish ochilmadi. Qayta urinib ko‘ring. Hech qanday savdo yoki to‘lov saqlanmadi.' });
  }, [job]);
  return <section className="p-4 sm:p-6 max-w-xl mx-auto space-y-5">
    <h1 className="text-2xl font-semibold">Mahsulot blankasi</h1>
    <p className="text-sm text-muted-foreground">Qatorlar sonini tanlang. Mahsulotlar qog‘ozga qo‘lda yoziladi.</p>
    <p className="text-sm">Kim yozdi: <strong>{writer || 'Xodim ismi topilmadi'}</strong></p>
    <label className="block space-y-2"><span>Nechta qator kerak?</span>
      <input className="block w-full rounded-md border p-3 bg-background" type="number" inputMode="numeric" min="1" max="30" step="1" value={rows} aria-expanded={keypadOpen} aria-controls="row-count-keypad" onFocus={(e) => { e.target.select(); setReplaceCount(true); setKeypadOpen(true); }} onClick={(e) => { e.currentTarget.select(); setReplaceCount(true); setKeypadOpen(true); }} onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); setKeypadOpen(false); } }} disabled={!!job} onChange={(e) => { setRows(e.target.value); setReplaceCount(false); }} /></label>
    {keypadOpen && <div id="row-count-keypad" role="group" aria-label="Qatorlar soni uchun raqamli klaviatura" className="rounded-xl border p-3 space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'backspace'].map((key) => <button key={key} type="button" disabled={!!job}
          className="min-h-12 rounded-lg border bg-background text-lg font-semibold active:bg-secondary disabled:opacity-50"
          aria-label={key === 'clear' ? 'Tozalash' : key === 'backspace' ? 'Oxirgi raqamni o‘chirish' : key}
          onClick={() => { setRows((value) => rowCountKey(value, key, replaceCount)); setReplaceCount(false); }}>
          {key === 'clear' ? 'C' : key === 'backspace' ? '⌫' : key}
        </button>)}
      </div>
      <div className="flex gap-2">
        <button type="button" className="min-h-12 flex-1 rounded-lg border" onClick={() => setKeypadOpen(false)}>Yopish</button>
        <button type="button" disabled={!valid} className="min-h-12 flex-1 rounded-lg bg-primary text-primary-foreground disabled:opacity-50" onClick={() => setKeypadOpen(false)}>Tayyor</button>
      </div>
    </div>}
    {!valid && <p role="alert" className="text-destructive">1 dan 30 gacha butun son kiriting.</p>}
    <label className="block space-y-2"><span>Printer qog‘ozi</span>
      <select className="block w-full rounded-md border p-3 bg-background" value={width} disabled={!!job} onChange={(e) => setWidth(e.target.value)}><option value="80">80 mm</option><option value="58">58 mm</option></select></label>
    <p className="text-xs text-muted-foreground">Printeringizdagi qog‘oz kengligini tanlang. Chop etish oynasida shu o‘lcham, 100% masshtab va bo‘sh chetlar (0) ni tanlang; sarlavha/kolontitullarni o‘chiring.</p>
    {!writer && <p role="alert">Profilingizdagi ismni tekshiring. Ismsiz blanka chop etilmaydi.</p>}
    {warning && <p role="alert">{warning}</p>}
    <button type="button" className="w-full flex items-center justify-center rounded-md bg-primary text-primary-foreground p-3 disabled:opacity-50" disabled={!valid || !writer || !!job} onClick={() => {
      setKeypadOpen(false); setWarning(''); setJob({ rows: Number(rows), writer, width, date: formatUzbekistanDateTime(new Date().toISOString()) });
    }}><Printer className="w-4 h-4 mr-2" />{job ? 'Chop etish oynasi…' : 'Chop etish'}</button>
    {job && createPortal(<div className="receipt-print blank-product-ticket" style={{ width: `${job.width}mm` }}>
      <style>{`@media print { @page { size: auto; margin: 0; } html, body { width: ${job.width}mm !important; } }`}</style>
      <Paper rows={job.rows} writer={job.writer} date={job.date} />
    </div>, document.body)}
  </section>;
}
