import React from 'react';

export default function PageHeader({ title, subtitle, actions, icon: Icon }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
      <div className="flex min-w-0 items-center gap-3">
        {Icon && (
          <div className="w-11 h-11 rounded-2xl brand-surface border border-brand-sand/40 text-brand-ink flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5" strokeWidth={2.2} />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="font-display text-2xl sm:text-[28px] font-bold tracking-tight leading-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-1 break-words">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}