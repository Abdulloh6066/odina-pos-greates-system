import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, Info, OctagonAlert } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { completeOdinaDialog, subscribeOdinaDialog } from '@/lib/odina-dialog';

const TONES = {
  info: {
    icon: Info,
    iconClass: 'bg-[#ACA95D]/15 text-[#77753B] ring-[#ACA95D]/25',
    detailClass: 'border-[#ACA95D]/25 bg-[#ACA95D]/8 text-foreground',
    actionClass: 'bg-[#ACA95D] text-[#272619] hover:bg-[#99964F]',
  },
  success: {
    icon: CheckCircle2,
    iconClass: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    detailClass: 'border-emerald-200 bg-emerald-50/70 text-emerald-950',
    actionClass: 'bg-emerald-700 text-white hover:bg-emerald-800',
  },
  warning: {
    icon: AlertTriangle,
    iconClass: 'bg-[#FECD7C]/30 text-amber-800 ring-[#FECD7C]/45',
    detailClass: 'border-[#D0B17F]/45 bg-[#FECD7C]/16 text-amber-950',
    actionClass: 'bg-[#FECD7C] text-[#352B18] hover:bg-[#F2BD66]',
  },
  danger: {
    icon: OctagonAlert,
    iconClass: 'bg-red-50 text-red-600 ring-red-100',
    detailClass: 'border-red-200 bg-red-50/70 text-red-950',
    actionClass: 'bg-red-600 text-white hover:bg-red-700',
  },
};

export default function OdinaDialogProvider({ children }) {
  const [request, setRequest] = useState(null);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => subscribeOdinaDialog((nextRequest) => {
    setRequest(nextRequest);
    setInputValue(nextRequest.defaultValue || '');
  }), []);

  const tone = useMemo(() => TONES[request?.tone] || TONES.info, [request?.tone]);
  const Icon = request?.kind === 'prompt' ? CircleHelp : tone.icon;

  const complete = (value) => {
    if (!request) return;
    const requestId = request.id;
    setRequest(null);
    completeOdinaDialog(requestId, value);
  };

  const cancelValue = request?.kind === 'prompt' ? null : false;
  const confirmValue = request?.kind === 'prompt' ? inputValue : true;

  return (
    <>
      {children}
      <AlertDialog
        open={Boolean(request)}
        onOpenChange={(open) => {
          if (!open && request) complete(cancelValue);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-1.5rem)] max-w-xl overflow-hidden rounded-[28px] border border-[#D0B17F]/45 bg-[#FFFDF8] p-0 shadow-[0_28px_90px_rgba(43,38,20,0.28)]">
          <div className="h-1.5 bg-gradient-to-r from-[#ACA95D] via-[#FECD7C] to-[#D0B17F]" />
          <div className="p-5 sm:p-7">
            <AlertDialogHeader className="flex-row items-start gap-4 space-y-0 text-left">
              <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ring-1 ${tone.iconClass}`}>
                <Icon className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <AlertDialogTitle className="font-display text-xl font-bold leading-tight text-foreground sm:text-2xl">
                  {request?.title}
                </AlertDialogTitle>
                {request?.description && (
                  <AlertDialogDescription className="mt-2 whitespace-pre-line text-[15px] leading-6 text-muted-foreground">
                    {request.description}
                  </AlertDialogDescription>
                )}
              </div>
            </AlertDialogHeader>

            {request?.details && (
              <div className={`mt-5 max-h-52 overflow-y-auto whitespace-pre-line rounded-2xl border px-4 py-3 text-sm font-medium leading-6 ${tone.detailClass}`}>
                {request.details}
              </div>
            )}

            {request?.kind === 'prompt' && (
              <label className="mt-5 block">
                {request.inputLabel && (
                  <span className="mb-2 block text-sm font-semibold text-foreground">{request.inputLabel}</span>
                )}
                <Input
                  autoFocus
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (!request.inputRequired || inputValue.trim())) {
                      event.preventDefault();
                      complete(inputValue);
                    }
                  }}
                  placeholder={request.placeholder}
                  className="h-12 rounded-xl border-[#D0B17F]/55 bg-white px-4 text-base focus-visible:ring-[#ACA95D]"
                />
              </label>
            )}

            <AlertDialogFooter className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-0">
              {request?.kind !== 'alert' && (
                <AlertDialogCancel
                  onClick={() => complete(cancelValue)}
                  className="mt-0 min-h-12 rounded-xl border-[#D0B17F]/45 bg-white px-5 text-base font-semibold hover:bg-[#FECD7C]/12"
                >
                  {request?.cancelLabel}
                </AlertDialogCancel>
              )}
              <AlertDialogAction
                onClick={() => complete(confirmValue)}
                disabled={request?.kind === 'prompt' && request.inputRequired && !inputValue.trim()}
                className={`min-h-12 rounded-xl px-6 text-base font-bold shadow-sm disabled:cursor-not-allowed disabled:opacity-45 ${tone.actionClass}`}
              >
                {request?.confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
