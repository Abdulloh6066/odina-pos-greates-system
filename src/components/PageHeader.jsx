import React from 'react';

export default function PageHeader({ title, subtitle = null, actions = null, icon: Icon = null, eyebrow = null }) {
  return (
    <header className="odina-page-header flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <span className="odina-page-icon-wrap contents"><Icon className="odina-page-icon-simple mt-1 h-5 w-5 shrink-0" strokeWidth={1.9} aria-hidden="true" /></span>
        )}
        <div className="min-w-0">
          {eyebrow && <p className="odina-page-eyebrow">{eyebrow}</p>}
          <h1 className="odina-page-title text-2xl sm:text-[28px] font-semibold tracking-tight leading-tight">{title}</h1>
          {subtitle && <p className="odina-page-subtitle text-sm text-muted-foreground mt-1.5 break-words">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="odina-page-actions flex items-center gap-2 flex-wrap">{actions}</div>}
    </header>
  );
}
