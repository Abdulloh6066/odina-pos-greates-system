import React, { useEffect, useRef, useState } from 'react';
import { ImageDown } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { optimizePosThumbnails, posThumbnailQueue } from '@/lib/pos-thumbnail-tool';
import PosThumbnailOptimizerDialog from './PosThumbnailOptimizerDialog';

// Faqat administrator uchun: asl rasmlardan kassa uchun kichik WebP nusxa tayyorlaydi.
export default function PosThumbnailOptimizer({ products = [], canRun = false, onSaved }) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const cancelledRef = useRef(false);
  const queue = posThumbnailQueue(products);

  useEffect(() => () => { cancelledRef.current = true; }, []);

  if (!canRun) return null;

  const start = async () => {
    if (running) return;
    cancelledRef.current = false;
    setRunning(true);
    setError('');
    setSummary(null);
    try {
      const result = await optimizePosThumbnails(products, {
        isCancelled: () => cancelledRef.current,
        onProgress: (progress) => { if (!cancelledRef.current) setSummary(progress); },
        uploadFile: (file) => base44.integrations.Core.UploadFile({ file }),
        saveThumbnail: (payload) => base44.functions.invoke('pos-thumbnails', payload),
      });
      if (cancelledRef.current) return;
      setSummary(result);
      if (result.done.length) onSaved?.();
    } catch (e) {
      if (!cancelledRef.current) setError(e?.message || 'Optimallashtirishni boshlab bo‘lmadi.');
    } finally {
      if (!cancelledRef.current) setRunning(false);
    }
  };

  return (
    <>
      <Button type="button" variant="outline" disabled={running}
        onClick={() => setOpen(true)} className="min-h-11 rounded-xl touch-manipulation">
        <ImageDown className="w-4 h-4 mr-1.5" aria-hidden="true" />
        Kassa rasmlarini optimallashtirish
      </Button>
      <PosThumbnailOptimizerDialog open={open} running={running} summary={summary}
        error={error} queue={queue} onStart={start} onClose={() => setOpen(false)} />
    </>
  );
}