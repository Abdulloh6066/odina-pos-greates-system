import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export default function offlineRestartPlugin() {
  return {
    name: 'odina-offline-restart', apply: 'build', enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(name => /\.(js|css|woff2?)$/.test(name)).map(name => '/' + name).sort();
      const template = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8');
      const version = createHash('sha256').update(JSON.stringify(assets) + template).digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'odina-sw.js', source: template
        .replace('__ODINA_BUILD__', version).replace('/* __ODINA_ASSETS__ */ []', JSON.stringify(assets)) });
    },
  };
}