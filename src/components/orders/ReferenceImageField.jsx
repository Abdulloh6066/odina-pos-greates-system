import React, { useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Image } from '@/components/ui/image';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Upload, Link2, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const tabBase = "flex-1 h-11 rounded-xl border text-sm font-medium transition-colors flex items-center justify-center gap-2";
const tabActive = "bg-brand-olive text-white border-brand-olive";
const tabIdle = "bg-card text-muted-foreground border-border hover:bg-secondary";

export default function ReferenceImageField({ value, onChange, disabled }) {
  const { toast } = useToast();
  const [mode, setMode] = useState('gallery');
  const [uploading, setUploading] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const fileRef = useRef(null);

  const pick = () => fileRef.current?.click();

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
      toast({ title: 'Faqat rasm fayli', description: 'Rasm formatidagi faylni tanlang.', variant: 'destructive' });
      return;
    }
    if (file.size > MAX_BYTES) {
      toast({ title: 'Fayl hajmi katta', description: 'Maksimal 10 MB rasm yuklash mumkin.', variant: 'destructive' });
      return;
    }
    setUploading(true);
    try {
      const res = await base44.integrations.Core.UploadFile({ file });
      const url = res?.file_url;
      if (!url) throw new Error('Rasm yuklanmadi');
      onChange(url);
      toast({ title: 'Rasm yuklandi' });
    } catch (err) {
      toast({ title: 'Yuklash xatosi', description: err?.message || 'Rasm yuklanmadi, qayta urinib ko‘ring.', variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const applyUrl = () => {
    const v = urlDraft.trim();
    if (!v) { onChange(''); return; }
    if (!/^https:\/\/.+\..+/i.test(v)) {
      toast({ title: 'Havola noto‘g‘ri', description: 'https:// bilan boshlangan to‘g‘ri rasm havolasini kiriting.', variant: 'destructive' });
      return;
    }
    onChange(v);
  };

  const remove = () => { onChange(''); setUrlDraft(''); };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button type="button" onClick={() => setMode('gallery')} aria-pressed={mode === 'gallery'} disabled={disabled || uploading}
          className={`${tabBase} ${mode === 'gallery' ? tabActive : tabIdle}`}>
          <Upload className="w-4 h-4" /> Galereyadan yuklash
        </button>
        <button type="button" onClick={() => setMode('url')} aria-pressed={mode === 'url'} disabled={disabled || uploading}
          className={`${tabBase} ${mode === 'url' ? tabActive : tabIdle}`}>
          <Link2 className="w-4 h-4" /> Rasm havolasi (URL)
        </button>
      </div>

      {value ? (
        <div className="rounded-xl border border-border bg-secondary/30 p-2 w-full max-w-[240px] space-y-2">
          <div className="relative rounded-lg overflow-hidden bg-secondary">
            <Image src={value} alt="Buyurtma namuna rasmi" fittingType="fill" className="w-full aspect-video" />
          </div>
          <div className="flex gap-2">
            {mode === 'gallery' ? (
              <Button type="button" size="sm" variant="outline" onClick={pick} disabled={disabled || uploading} className="flex-1">
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Almashtirish
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={() => { onChange(''); setUrlDraft(''); }} disabled={disabled} className="flex-1">
                <RefreshCw className="w-4 h-4" /> Almashtirish
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={remove} disabled={disabled}>
              <Trash2 className="w-4 h-4" /> Olib tashlash
            </Button>
          </div>
        </div>
      ) : mode === 'gallery' ? (
        <button type="button" onClick={pick} disabled={uploading || disabled}
          className="w-full h-28 rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:bg-secondary/40 disabled:opacity-50 transition-colors">
          {uploading ? (
            <><Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Yuklanmoqda...</span></>
          ) : (
            <><Upload className="w-5 h-5" /><span className="text-sm font-medium">Galereyadan rasm tanlash</span><span className="text-xs">Maksimal 10 MB · JPG, PNG, WEBP</span></>
          )}
        </button>
      ) : (
        <div className="flex gap-2">
          <Input value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} placeholder="https://example.com/rasm.jpg" disabled={disabled} />
          <Button type="button" variant="outline" onClick={applyUrl} disabled={disabled}>Qo‘shish</Button>
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
    </div>
  );
}