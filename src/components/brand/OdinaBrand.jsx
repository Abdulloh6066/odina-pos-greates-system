import React from 'react';
import odinaMark from './odina-mark';

export default function OdinaBrand({ collapsed = false, compact = false }) {
  return (
    <div className={`odina-brand ${compact ? 'odina-brand-compact' : ''}`} aria-label="Odina Cake">
      <span className="odina-brand-symbol" aria-hidden="true">
        <img src={odinaMark} alt="" width="48" height="48" />
      </span>
      <span className={`odina-brand-wordmark flex ${collapsed ? 'lg:hidden' : ''}`} aria-hidden="true">
        <span className="odina-brand-name">odina</span>
        <span className="odina-brand-caption">cake · kassa</span>
      </span>
    </div>
  );
}
