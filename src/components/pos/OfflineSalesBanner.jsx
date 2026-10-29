import React from 'react';
import { CloudOff, CloudUpload, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
export default function OfflineSalesBanner({ isOnline, browserOnline = isOnline, connectionPaused = false, records, syncing, storageError, syncError, onRetry }) {
  const failed = records.find(record => record.status === 'failed');
  const error = storageError || failed?.last_error || syncError;
  if (isOnline && !records.length && !syncing && !error) return null;
  const tone = storageError || failed ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900';
  const Icon = !isOnline ? CloudOff : syncing ? RefreshCw : CloudUpload;
  const title = storageError ? 'Offline xotira ishlamayapti' : !isOnline
    ? `${connectionPaused && browserOnline ? 'Server bilan aloqa yo‘q' : 'Internet yo‘q'}${records.length ? ` · ${records.length} ta savdo navbatda` : ''}`
    : syncing ? `${records.length} ta savdo yuborilmoqda…` : `${records.length} ta savdo tasdig‘i kutilmoqda`;
  const description = error || (!isOnline ? 'Oddiy savdolar shu qurilmada xavfsiz saqlanadi.'
    : 'Savdolar navbat bilan serverga yuboriladi. Oddiy savdoni davom ettirishingiz mumkin.');
  return <div className={`mx-3 sm:mx-5 mt-3 shrink-0 flex items-center gap-3 rounded-2xl border px-3.5 py-2.5 ${tone}`}>
    <span className="w-9 h-9 rounded-xl bg-card/60 flex items-center justify-center shrink-0"><Icon className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} /></span>
    <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{title}</span><span className="block text-xs opacity-80 mt-0.5 truncate">{description}</span></span>
    {browserOnline && records.length > 0 && <Button type="button" variant="outline" size="sm" disabled={syncing}
      onClick={() => { void onRetry(); }} aria-label={isOnline ? 'Navbatdagi savdolarni yuborish' : 'Server aloqasini tekshirish'} className="h-10 shrink-0 bg-card/70">
      <RefreshCw className={`w-4 h-4 sm:mr-1.5 ${syncing ? 'animate-spin' : ''}`} /><span className="hidden sm:inline">{isOnline ? 'Qayta yuborish' : 'Aloqani tekshirish'}</span>
    </Button>}
  </div>;
}