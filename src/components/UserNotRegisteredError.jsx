import React from 'react';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { LogOut, Send, ShieldAlert } from 'lucide-react';
import OdinaBrand from '@/components/brand/OdinaBrand';

const UserNotRegisteredError = () => {
  const { logout, user } = useAuth();
  const telegramHandle = '@Abdulloh1100';
  const telegramUrl = 'https://t.me/Abdulloh1100';

  return (
    <div className="min-h-screen flex items-center justify-center p-4 brand-surface">
      <div className="odina-panel w-full max-w-md rounded-3xl bg-card border border-border premium-shadow-lg overflow-hidden animate-pop-in">
        {/* Header band */}
        <div className="brand-mark px-6 py-8 text-center text-primary-foreground">
          <div className="flex justify-center mb-4">
            <OdinaBrand />
          </div>
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-white/20 backdrop-blur-sm mb-3">
            <ShieldAlert className="w-7 h-7" />
          </div>
          <h1 className="font-display text-2xl font-bold">Kirish cheklangan</h1>
          <p className="text-sm text-primary-foreground/90 mt-1">
            Odina POS — faqat taklif qilingan xodimlar uchun
          </p>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          <p className="text-sm text-muted-foreground text-center">
            Siz ushbu ilovadan foydalanish uchun ro‘yxatdan o‘tmagansiz. Ruxsat
            olish uchun administratorga murojaat qiling.
          </p>

          {/* Telegram contact card */}
          <a
            href={telegramUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-2xl border border-border bg-secondary/60 hover:bg-secondary transition-colors p-4 group"
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-[#229ED9] text-white shrink-0">
                <Send className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Ruxsat olish uchun Telegram</p>
                <p className="text-base font-semibold text-foreground truncate group-hover:text-brand-ink transition-colors">
                  {telegramHandle}
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Administratordan taklif oling — so‘ng shu email orqali qayta kiring.
            </p>
          </a>

          {/* Logged in as */}
          {user?.email && (
            <div className="rounded-xl bg-muted/60 border border-border px-4 py-3 text-center">
              <p className="text-xs text-muted-foreground">Joriy hisob</p>
              <p className="text-sm font-medium text-foreground truncate">{user.email}</p>
            </div>
          )}

          {/* Actions */}
          <div className="space-y-2">
            <Button
              onClick={() => logout(true)}
              className="w-full h-12"
              variant="outline"
            >
              <LogOut className="w-4 h-4 mr-2" /> Hisobni almashtirish
            </Button>
          </div>

          <div className="rounded-xl bg-muted/40 px-4 py-3 text-xs text-muted-foreground text-left">
            <p className="font-medium text-foreground mb-1">Agar bu xato deb hisoblasangiz:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>To‘g‘ri hisob bilan kirganingizni tekshiring</li>
              <li>Administrator telegram orqali taklif yuborishini so‘rang</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserNotRegisteredError;