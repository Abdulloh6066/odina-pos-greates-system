let listener = null;
let activeRequest = null;
const pendingRequests = [];
let nextId = 1;

const inferTone = (value) => {
  const text = String(value || '').toLowerCase();

  if (/saqlandi|yuborildi|muvaffaq|amalga oshdi|tayyor/.test(text)) return 'success';
  if (/xato|bo‘lmadi|yetarli emas|noto‘g‘ri|topilmadi|saqlanmadi|yuklanmadi|bekor qilinmadi/.test(text)) return 'danger';
  if (/diqqat|ogohlant|majburiy|kiriting|tanlang|yo‘q/.test(text)) return 'warning';
  return 'info';
};

const defaultTitle = (kind, tone) => {
  if (kind === 'prompt') return 'Ma’lumot kiriting';
  if (kind === 'confirm') return tone === 'danger' ? 'Amalni tasdiqlang' : 'Tasdiqlash';
  if (tone === 'success') return 'Tayyor';
  if (tone === 'danger') return 'Amal bajarilmadi';
  if (tone === 'warning') return 'Diqqat';
  return 'Xabar';
};

const normalizeRequest = (kind, message, options = {}) => {
  const config = typeof message === 'object' && message !== null
    ? { ...message }
    : { ...options, description: String(message ?? '') };
  const tone = config.tone || inferTone(`${config.title || ''} ${config.description || ''}`);

  return {
    kind,
    tone,
    title: config.title || defaultTitle(kind, tone),
    description: config.description || '',
    details: config.details || '',
    confirmLabel: config.confirmLabel || (kind === 'alert' ? 'Tushundim' : 'Tasdiqlash'),
    cancelLabel: config.cancelLabel || 'Bekor qilish',
    inputLabel: config.inputLabel || '',
    placeholder: config.placeholder || '',
    defaultValue: config.defaultValue || '',
  };
};

const deliverNext = () => {
  if (!listener || activeRequest || pendingRequests.length === 0) return;
  activeRequest = pendingRequests.shift();
  listener(activeRequest);
};

const enqueue = (kind, message, options) => new Promise((resolve) => {
  pendingRequests.push({
    id: nextId++,
    ...normalizeRequest(kind, message, options),
    resolve,
  });
  deliverNext();
});

export const odinaAlert = (message, options) => enqueue('alert', message, options);
export const odinaConfirm = (message, options) => enqueue('confirm', message, options);
export const odinaPrompt = (message, options) => enqueue('prompt', message, options);

export const subscribeOdinaDialog = (nextListener) => {
  listener = nextListener;
  if (activeRequest) listener(activeRequest);
  else deliverNext();

  return () => {
    if (listener === nextListener) listener = null;
  };
};

export const completeOdinaDialog = (requestId, value) => {
  if (!activeRequest || activeRequest.id !== requestId) return;

  const completed = activeRequest;
  activeRequest = null;
  completed.resolve(value);
  Promise.resolve().then(deliverNext);
};
