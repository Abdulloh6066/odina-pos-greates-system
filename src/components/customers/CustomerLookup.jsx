import React, { useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { normalizePhone, fullName } from '@/lib/customers';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UserCheck, Loader2 } from 'lucide-react';

/**
 * Phone field with debounced customer auto-lookup.
 * When a matching customer is found, calls onMatch with the customer record
 * (so the parent can autofill the name and keep the customer_id).
 */
export default function CustomerLookup({ phone, onPhoneChange, onMatch, label = 'Telefon', disabled }) {
  const [match, setMatch] = useState(null);
  const [searching, setSearching] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const normalized = normalizePhone(phone);
    if (normalized.length < 7) {
      setMatch(null);
      setSearching(false);
      onMatch?.(null);
      return;
    }
    setSearching(true);
    const myId = ++requestId.current;
    const t = setTimeout(async () => {
      try {
        const results = await base44.entities.Customer.filter({ phone_normalized: normalized });
        if (myId !== requestId.current) return;
        const found = (results && results[0]) || null;
        setMatch(found);
        onMatch?.(found);
      } catch {
        if (myId !== requestId.current) return;
        setMatch(null);
        onMatch?.(null);
      } finally {
        if (myId === requestId.current) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);

  return (
    <div>
      <Label>{label}</Label>
      <Input
        value={phone}
        onChange={(e) => onPhoneChange(e.target.value)}
        disabled={disabled}
        placeholder="+998..."
        className="mt-1"
        autoComplete="off"
      />
      {searching && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Mijoz qidirilmoqda…
        </div>
      )}
      {!searching && match && (
        <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 mt-1.5">
          <UserCheck className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">Mijoz topildi: {fullName(match)}</span>
        </div>
      )}
    </div>
  );
}