import React from "react";
import OdinaBrand from "./brand/OdinaBrand";
import odinaMark from "./brand/odina-mark";

export default function AuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <div className="odina-auth-layout">
      <div className="odina-auth-shell">
        <aside className="odina-auth-story" aria-label="Odina Cake">
          <OdinaBrand />
          <div className="odina-auth-story-copy">
            <h2>Har kuningizga<br />bir chimdim mehr.</h2>
            <p>Mahsulotdan mijozgacha — kundalik ishlaringiz bir joyda.</p>
          </div>
          <span className="odina-auth-story-caption">ODINA CAKE · ISH MAYDONI</span>
          <img className="odina-auth-watermark" src={odinaMark} alt="" aria-hidden="true" />
        </aside>
        <div className="odina-auth-form">
          <div className="odina-auth-mobile-brand"><OdinaBrand /></div>
          <div className="odina-auth-heading">
            <span className="odina-auth-icon"><Icon className="w-5 h-5" aria-hidden="true" /></span>
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="odina-auth-card">{children}</div>
          {footer && <p className="odina-auth-footer">{footer}</p>}
        </div>
      </div>
    </div>
  );
}
