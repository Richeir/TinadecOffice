import { readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs'

const D = 'tmp/perf/boot-perf/'
const load = (f) => { try { return JSON.parse(readFileSync(D + f, 'utf8')) } catch { return null } }
const pick = (j) => j && {
  locale: j.locale ?? 'zh-CN(default)',
  wallMs: j.wallMs,
  splashAppearedMs: j.result?.splashAppearedMs ?? null,
  splashGoneMs: j.result?.splashGoneMs ?? null,
  mainContentMs: j.result?.mainContentMs ?? null,
  shellVisibleMs: j.result?.shellVisibleMs ?? null,
  bannerVisibleMs: j.result?.bannerVisibleMs ?? null,
  fcp: j.result?.paint?.['first-contentful-paint'] ?? null,
  lcp: j.result?.lcp?.t ?? null,
  longTaskTotal: j.result?.longTaskTotal ?? null,
  requestCount: j.requestCount,
  totalEncodedBytes: j.totalEncodedBytes,
  consoleErrors: (j.consoleErrors ?? []).length,
}

// every run I have, grouped by locale
const groups = { zhCN: [], en: [], zhTW: [], stubHost: [], baseline: [] }
const pushIf = (arr, f) => { const v = pick(load(f)); if (v && v.splashAppearedMs != null) arr.push({ file: f, ...v }) }
// baseline file uses the shared probe's older schema
const b = load('before-prod.json')
if (b) groups.baseline.push({
  file: 'before-prod.json', url: b.url, note: 'shared probe schema (splash gone / main / shell only)',
  splashGoneMs: Math.round(b.result.splashGone.at), mainContentMs: Math.round(b.result.main.at),
  shellVisibleMs: Math.round(b.result.shell.at), fcp: b.result.paint?.['first-contentful-paint'] ?? null,
  lcp: b.result.lcp?.t ?? null, longTaskTotal: b.result.longTaskTotal,
  requestCount: b.requestCount, totalEncodedBytes: b.totalEncodedBytes,
})
for (const f of readdirSync(D)) {
  if (!f.endsWith('.json')) continue
  if (f === 'after-stubhost.json') pushIf(groups.stubHost, f)
  else if (/^(after-prod|ctl|q)-/.test(f) && f !== 'before-prod.json') {
    const v = pick(load(f)); if (!v || v.splashAppearedMs == null) continue
    if (v.locale === 'en') pushIf(groups.en, f)
    else if (v.locale === 'zh-TW') pushIf(groups.zhTW, f)
    else pushIf(groups.zhCN, f)
  }
}
const stat = (arr, k) => { const a = arr.map((r) => r[k]).filter((v) => v != null).sort((x, y) => x - y); return a.length ? { n: a.length, min: a[0], med: a[Math.floor(a.length / 2)], max: a[a.length - 1] } : null }
const summary = {
  generated: new Date().toISOString(),
  machineNote: 'shared dev machine: 3 teammates (builds + dev servers) running concurrently, so wall-clock timings below are NOT a controlled A/B',
  groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, {
    runs: v,
    stat: {
      splashAppearedMs: stat(v, 'splashAppearedMs'), splashGoneMs: stat(v, 'splashGoneMs'),
      mainContentMs: stat(v, 'mainContentMs'), shellVisibleMs: stat(v, 'shellVisibleMs'),
      fcp: stat(v, 'fcp'), lcp: stat(v, 'lcp'), longTaskTotal: stat(v, 'longTaskTotal'),
    },
  }])),
  bytes: {
    baselineEntry: { file: 'index-Fjeluni6.js', raw: 1735908, fromBuildLog: 'tmp/perf/build.log: index-Fjeluni6.js 1,735.91 kB | gzip 545.01 kB' },
    afterEntry: { file: 'index-YQZfJESZ.js', raw: 814050, gzip: 275120, measured: 'gzipSync of the built file' },
    localeChunks: { en: [184433, 59074], 'zh-TW': [178560, 64568], ja: [251425, 70534], ru: [309917, 78741] },
    transferredBaseline: { total: 3850881, js: 3385893 },
    transferredAfter: { total: 2928572, js: 2464035 },
  },
}
writeFileSync(D + 'summary.json', JSON.stringify(summary, null, 2))
for (const [k, v] of Object.entries(summary.groups)) {
  const s = v.stat
  console.log(k.padEnd(10), 'n=' + v.runs.length,
    'splash', JSON.stringify(s.splashAppearedMs), 'gone', JSON.stringify(s.splashGoneMs))
  console.log('           main', JSON.stringify(s.mainContentMs), 'fcp', JSON.stringify(s.fcp), 'longtask', JSON.stringify(s.longTaskTotal))
}
