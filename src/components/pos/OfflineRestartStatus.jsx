import React, { useEffect, useState } from 'react';
import { readRestartValue } from '@/lib/offline-restart';
export default function OfflineRestartStatus({ saved, error, offline }) {
  const publishedBuild = import.meta.env.PROD;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!publishedBuild) return undefined;
    let active = true;
    const done = async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      if (active) setReady(Boolean(registration?.active && new URL(registration.active.scriptURL).pathname === '/odina-sw.js'));
    };
    const fail = () => { if (active) setFailed(true); };
    if ('serviceWorker' in navigator) void navigator.serviceWorker.ready.then(done).catch(fail);
    else fail();
    window.addEventListener('odina:offline-ready', done);
    window.addEventListener('odina:offline-unavailable', fail);
    return () => { active = false; window.removeEventListener('odina:offline-ready', done); window.removeEventListener('odina:offline-unavailable', fail); };
  }, [publishedBuild]);
  return <p role="status" className="mx-3 mt-2 text-xs text-muted-foreground sm:mx-5">
    {error || (offline ? 'Offline kassa: oxirgi saqlangan katalog va smena. Oddiy savdolar qurilmada saqlanadi; stol, chegirma va smena amallari uchun internet kerak.'
      : saved && ready && readRestartValue('staff') ? 'Offline qayta ochishga tayyor · shu brauzerda, ochiq smena bilan (24 soat).'
      : !publishedBuild ? 'Offline qayta ochish nashr qilingan ilovada ishlaydi. Ushbu oyna — oldindan ko‘rish.'
      : failed ? 'Offline qayta ochish tayyor emas. Internet borida kassani qayta oching.'
      : 'Offline qayta ochish uchun kassa tayyorlanmoqda…')}
  </p>;
}