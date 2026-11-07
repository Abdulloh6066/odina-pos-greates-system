import React, { useEffect, useRef, useState } from 'react';
import { Check, Download, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { cachePosImages } from '@/lib/pos-image-cache';

function imageDimensions() {
  const root = document.querySelector('.odina-pos');
  const image = root?.querySelector('.odina-product-photo')?.firstElementChild;
  const size = image?.getBoundingClientRect();
  if (size?.width > 0 && size?.height > 0) return size;
  // An empty category/search still needs the same grid/card content box that
  // Image's useSize measures, without changing the cashier's selected view.
  const scroll = root?.querySelector('.odina-product-scroll');
  if (!scroll) throw new Error('Katalog yuklangach qayta urinib ko‘ring.');
  const style = window.getComputedStyle(scroll);
  const width = scroll.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  const probe = document.createElement('div');
  probe.className = 'odina-product-grid grid';
  probe.setAttribute('aria-hidden', 'true');
  Object.assign(probe.style, { position: 'fixed', left: '-10000px', top: '0', width: width + 'px', visibility: 'hidden', pointerEvents: 'none' });
  const card = document.createElement('div');
  card.className = 'odina-product-card odina-workbench-product border border-border';
  const photo = document.createElement('div');
  photo.className = 'odina-product-photo relative';
  const wrapper = document.createElement('span');
  wrapper.className = 'inline-block relative w-full h-full';
  photo.append(wrapper); card.append(photo); probe.append(card); root.append(probe);
  try {
    const measured = wrapper.getBoundingClientRect();
    if (!(measured.width > 0 && measured.height > 0)) throw new Error('Rasm o‘lchami aniqlanmadi.');
    return measured;
  } finally { probe.remove(); }
}

export default function PosImageCacheButton({ products, scopeKey, online, disabled }) {
  const [progress, setProgress] = useState(null);
  const jobRef = useRef(null);
  useEffect(() => {
    setProgress(null);
    return () => { jobRef.current?.abort(); jobRef.current = null; };
  }, [products, scopeKey, online]);
  const supported = typeof window !== 'undefined' && window.isSecureContext && 'caches' in window;
  const running = Boolean(progress?.running);
  const complete = progress && !running && !progress.cancelled && !progress.failed.length && !progress.skipped
    && progress.total > 0 && progress.cached + progress.downloaded === progress.total;
  const done = progress ? progress.cached + progress.downloaded + progress.failed.length : 0;
  const label = running ? `Rasmlar ${done}/${progress.total}` : complete ? 'Rasmlar saqlandi' : 'Rasmlarni saqlash';
  const title = !supported ? 'Brauzer rasmlarni saqlashni qo‘llamaydi.' : !online ? 'Rasmlarni yuklash uchun internet kerak.'
    : running ? 'Yuklashni to‘xtatish' : 'Kassa rasmlarini shu brauzerda oldindan saqlash';

  const start = async () => {
    if (jobRef.current) { jobRef.current.abort(); return; }
    if (disabled || !online || !supported) return;
    const controller = new AbortController();
    jobRef.current = controller;
    setProgress({ running: true, total: 0, cached: 0, downloaded: 0, failed: [], skipped: 0 });
    try {
      const photo = imageDimensions();
      const result = await cachePosImages(products, {
        origin: window.location.origin, width: photo.width, height: photo.height,
        signal: controller.signal,
        onProgress: next => { if (jobRef.current === controller) setProgress({ ...next, running: true }); },
      });
      if (jobRef.current !== controller) return;
      setProgress({ ...result, running: false });
      const stored = result.cached + result.downloaded;
      const missing = result.skipped + result.total - stored;
      toast({ title: result.cancelled ? 'Yuklash to‘xtatildi' : !result.total ? 'Saqlanadigan rasm topilmadi'
        : !stored ? 'Rasmlar saqlanmadi' : missing ? 'Rasmlarning bir qismi saqlandi' : 'Rasmlar tayyor',
        description: `Saqlangan: ${result.downloaded}. Oldindan bor: ${result.cached}. Saqlanmagan: ${missing}.`
          + (result.failed.length ? ' Tugmani yana bossangiz, yetishmaganlari qayta tekshiriladi.' : '') });
    } catch (error) {
      if (jobRef.current === controller) {
        setProgress(null);
        toast({ title: 'Rasmlarni saqlab bo‘lmadi', description: error?.message || 'Qayta urinib ko‘ring.', variant: 'destructive' });
      }
    } finally { if (jobRef.current === controller) jobRef.current = null; }
  };

  return <>
    <Button type="button" variant="outline" size="sm" aria-label={running ? 'Rasmlarni yuklashni to‘xtatish' : label}
      title={title} aria-busy={running} disabled={disabled || !products.length || !online || !supported}
      onClick={() => void start()} className="h-11 shrink-0 rounded-xl px-3 touch-manipulation">
      {running ? <><Loader2 className="h-4 w-4 animate-spin" /><span className="ml-1.5 tabular-nums">{done}/{progress.total}</span><X className="ml-1 h-3.5 w-3.5" /></>
        : <>{complete ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}<span className="ml-1.5 hidden xl:inline">{label}</span></>}
    </Button>
    <span role="status" aria-live="polite" className="sr-only">{running ? `${done}/${progress.total} ta rasm tekshirildi.` : complete ? 'Rasmlar shu brauzerga saqlandi.' : ''}</span>
  </>;
}
