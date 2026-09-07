import React from "react";

export default function AuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-background brand-surface px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-7">
          <p className="text-xs font-semibold tracking-[0.18em] text-brand-ink mb-5">ODINA SHOP · QANDOLAT</p>
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl brand-mark mb-4 premium-shadow">
            <Icon className="w-7 h-7 text-primary-foreground" aria-hidden="true" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="text-muted-foreground mt-2">{subtitle}</p>}
        </div>
        <div className="bg-card rounded-2xl premium-shadow-lg border border-brand-sand/40 p-5 sm:p-8">
          {children}
        </div>
        {footer && (
          <p className="text-center text-sm text-muted-foreground mt-6">{footer}</p>
        )}
      </div>
    </div>
  );
}
