import React, { useEffect, useState } from 'react';
import { readRestartValue } from '@/lib/offline-restart';
export default function OfflineRestartStatus({ saved, error, offline }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const done = () => { if (active) setReady(true); };
    const fail = () => { if (active) setFailed(true); };
    if ('serviceWorker' in navigator) void navigator.serviceWorker.ready.then(done);
    else fail();
    window.addEventListener('odina:offline-ready', done);
    window.addEventListener('odina:offline-unavailable', fail);
    return () => { active = false; window.removeEventListener('odina:offline-ready', done); window.removeEventListener('odina:offline-unavailable', fail); };
  }, []);
  return <p role="status" className="mx-3 mt-2 text-xs text-muted-foreground sm:mx-5">
    {error || (offline ? 'Offline kassa: oxirgi saqlangan katalog va smena. Oddiy savdolar qurilmada saqlanadi; stol, chegirma va smena amallari uchun internet kerak.'
      : saved && ready && readRestartValue('staff') ? 'Offline qayta ochishga tayyor · shu brauzerda, ochiq smena bilan (24 soat).'
      : failed ? 'Offline qayta ochish tayyor emas. Internet borida kassani qayta oching.'
      : 'Offline qayta ochish uchun kassa tayyorlanmoqda…')}
  </p>;
}