/* 안드로이드·아이폰 기기 없이 앱 연결 코드(apk/native.js)와 app.js의 네이티브 분기를 검증한다.
   apk/copy-web.js로 www/를 만들어 서빙하고, 페이지 스크립트보다 먼저 가짜 네이티브 브리지를 심는다.
   capacitor.js의 플랫폼 판정 그대로: 안드로이드는 window.androidBridge, iOS는 window.webkit.messageHandlers.bridge.
   여기에 window.Capacitor{PluginHeaders, nativePromise, nativeCallback}를 두면, 복사된 실제 capacitor.js가 그 위에 합쳐져
   registerPlugin 프록시가 가짜 브리지를 부르는지가 핵심이다.
   가짜 파일시스템(DATA 폴더), 로드 횟수, 파일·워처 호출 기록은 페이지의 sessionStorage에 두어 location.reload()를 넘어 유지된다
   (저장소 미러 복원 검사).
   실행: node tests/native.cjs  (Chromium + Playwright 필요) */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const apk = path.resolve(__dirname, '..', 'apk'), www = path.join(apk, 'www');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png'};
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); for (;;) { let v = null; try { v = await fn(); } catch (e) { /* 리로드 중 */ } if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(50); } };
const KEY = 'azura.gps.v1';
const MIRROR_PATH = 'DATA/azura-state.json';

/* 페이지 스크립트보다 먼저 실행되는 가짜 네이티브 브리지.
   cfg.platform: 없으면 서비스 워커 스파이만(브라우저 모드 대조용), 'android' | 'ios'.
   cfg.file: 첫 로드 전 가짜 DATA/azura-state.json 내용. cfg.local: 첫 로드 전 localStorage 'azura.gps.v1' 값.
   cfg.readDelay: readFile 응답 지연(ms, 기본 30). cfg.bigFile: localStorage 용량을 넘는 올바른 미러를 돌려준다.
   cfg.wipeLocalOnLoad: 그 번째 로드가 시작될 때 localStorage 값을 지운다(되살린 값이 리로드 뒤 사라진 상황). */
function fakeBridge(cfg) {
  window.__swRegister = 0;
  // Playwright의 serviceWorkers:'block'이 navigator.serviceWorker 인스턴스에 자체 register를 얹으므로 인스턴스에 직접 스파이를 둔다
  const spy = function () { window.__swRegister++; return Promise.reject(new Error('test: blocked')); };
  if (window.ServiceWorkerContainer) ServiceWorkerContainer.prototype.register = spy;
  if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'register', {value: spy, configurable: true, writable: true});
  if (!cfg.platform || !/^https?:$/.test(location.protocol)) return;
  if (cfg.platform === 'android') window.androidBridge = {postMessage() {}};          // capacitor.js의 getPlatform → 'android'
  else window.webkit = {messageHandlers: {bridge: {postMessage() {}}}};             // → 'ios'
  const ss = window.sessionStorage, KEY = 'azura.gps.v1';
  const load = (+ss.getItem('__loads') || 0) + 1; ss.setItem('__loads', String(load));
  if (load === 1) {
    if (cfg.local != null) localStorage.setItem(KEY, cfg.local);
    if (cfg.file != null) ss.setItem('__fs', JSON.stringify({'DATA/azura-state.json': cfg.file}));
  }
  if (cfg.wipeLocalOnLoad === load) localStorage.removeItem(KEY);
  const files = () => JSON.parse(ss.getItem('__fs') || '{}');
  const plog = rec => { const a = JSON.parse(ss.getItem('__log') || '[]'); a.push(Object.assign({load}, rec)); ss.setItem('__log', JSON.stringify(a)); };  // 리로드를 넘는 기록
  window.__calls = []; window.__watchers = {}; window.__listeners = {}; window.__readDone = false;
  window.__dataWrites = () => window.__calls.filter(c => c.plugin === 'Filesystem' && c.method === 'writeFile' && c.options.directory === 'DATA');
  let seq = 100;
  const H = (name, m) => ({name, methods: Object.entries(m).map(([n, rtype]) => ({name: n, rtype}))});
  window.Capacitor = {
    PluginHeaders: [
      H('BackgroundGeolocation', {addWatcher: 'callback', removeWatcher: 'promise', openSettings: 'promise'}),
      H('Filesystem', {writeFile: 'promise', readFile: 'promise'}),
      H('Share', {share: 'promise'}),
      H('App', {addListener: 'callback', removeListener: 'promise', minimizeApp: 'promise', exitApp: 'promise'}),
      H('KeepAwake', {keepAwake: 'promise', allowSleep: 'promise'}),
      H('LocalNotifications', {checkPermissions: 'promise', requestPermissions: 'promise'})],
    nativePromise(plugin, method, options) {
      window.__calls.push({plugin, method, options: options == null ? null : options});
      const key = plugin + '.' + method;
      if (key === 'BackgroundGeolocation.removeWatcher') { delete window.__watchers[options && options.id]; plog({op: 'removeWatcher', id: options && options.id}); }
      if (key === 'App.removeListener') delete window.__listeners[plugin + ':' + (options && options.eventName)];
      if (key === 'Filesystem.writeFile') {
        if (options.directory !== 'DATA') return Promise.resolve({uri: 'file:///cache/' + options.path});
        const fail = ss.getItem('__fsFail') === '1';
        plog({op: 'write', path: options.path, directory: options.directory, encoding: options.encoding, ok: !fail});
        if (fail) return Promise.reject(new Error('test: disk full'));
        const f = files(); f[options.directory + '/' + options.path] = options.data; ss.setItem('__fs', JSON.stringify(f));
        return Promise.resolve({uri: 'file:///data/' + options.path});
      }
      if (key === 'Filesystem.readFile') {
        plog({op: 'read', path: options.path, directory: options.directory, encoding: options.encoding});
        const k = options.directory + '/' + options.path;
        return new Promise((resolve, reject) => setTimeout(() => {
          window.__readDone = true;
          if (cfg.bigFile && k === 'DATA/azura-state.json') return resolve({data: JSON.stringify({schema: 1, settings: {units: 'yd'}, rounds: [], activeRoundId: null, ui: {hole: 1}, pad: 'x'.repeat(12e6)})});
          const f = files();
          if (k in f) resolve({data: f[k]});
          else reject(Object.assign(new Error(`'readFile' failed because file at '${options.path}' does not exist.`), {code: 'OS-PLUG-FILE-0008'}));
        }, cfg.readDelay == null ? 30 : cfg.readDelay));
      }
      if (key === 'LocalNotifications.checkPermissions') return Promise.resolve({display: 'prompt'});   // 아직 안 물어봄 → requestPermissions까지 가게
      if (key === 'LocalNotifications.requestPermissions') return Promise.resolve({display: 'granted'});
      return Promise.resolve({});
    },
    nativeCallback(plugin, method, options, cb) {
      const id = String(++seq);                                 // 실제 브리지처럼 콜백 id 문자열을 동기로 돌려준다
      window.__calls.push({plugin, method, options: options == null ? null : options, id});
      if (plugin === 'BackgroundGeolocation' && method === 'addWatcher') { window.__watchers[id] = cb; plog({op: 'addWatcher', id, bg: !!(options && options.backgroundMessage)}); }
      else if (method === 'addListener') window.__listeners[plugin + ':' + (options && options.eventName)] = cb;
      return id;
    }
  };
}

/* 미러에 들어 있는 상태(단위 yd, 끝난 라운드 1개, 3번홀)와 localStorage에 미리 둘 다른 상태(단위 m, 라운드 없음, 5번홀) */
const MIRROR_A = JSON.stringify({schema: 1, settings: {units: 'yd', keepAwake: false, testPos: null}, activeRoundId: null, ui: {hole: 3},
  rounds: [{id: 'mirror-round', startedAt: '2026-10-01T08:00:00.000Z', endedAt: '2026-10-01T12:00:00.000Z', startHole: 1,
    events: [{id: 'e1', t: '2026-10-01T08:05:00.000Z', hole: 1, type: 'shot', club: '드라이버', lat: -17.711, lon: 49.506, acc: 4, fixT: null, dtg: 200, pending: false}]}]});
const LOCAL_B = JSON.stringify({schema: 1, settings: {units: 'm', keepAwake: false, testPos: null}, rounds: [], activeRoundId: null, ui: {hole: 5}});

(async () => {
  execFileSync(process.execPath, [path.join(apk, 'copy-web.js')], {stdio: 'inherit'});
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    fs.readFile(path.join(www, p), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, {'content-type': types[path.extname(p)] || 'application/octet-stream'}); res.end(d); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/`;  // localhost여야 app.js의 서비스 워커 등록 조건이 참이 된다

  const TEE = {lat: -17.6830, lon: 49.5};
  const P2 = {lat: -17.6815, lon: 49.5};
  const browser = await chromium.launch();
  const ctxOpts = {viewport: {width: 360, height: 740}, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'ko-KR'};

  /* 가짜 브리지를 심은 새 브라우저 컨텍스트 하나 = 새로 설치한 앱 하나. 위치 권한 없음: 네이티브 경로가 아니면 거리가 나올 수 없다 */
  async function openApp(cfg, viewport) {
    const ctx = await browser.newContext(Object.assign({}, ctxOpts, viewport ? {viewport} : {}));
    await ctx.addInitScript(fakeBridge, cfg);
    const page = await ctx.newPage();
    const errors = [], logs = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { logs.push({type: m.type(), text: m.text()}); if (m.type() === 'error') errors.push(m.text()); });
    const ev = async (fn, arg) => { try { return await page.evaluate(fn, arg); } catch (e) { return undefined; } };  // 리로드 중이면 undefined
    const text = sel => page.locator(sel).innerText();
    const calls = () => page.evaluate(() => window.__calls.map((c, i) => Object.assign({i}, c)));
    const callsOf = async (plugin, method) => (await calls()).filter(c => c.plugin === plugin && c.method === method);
    return {
      ctx, page, errors, logs, ev, text, calls, callsOf,
      num: async sel => parseFloat((await text(sel)).replace(/[^\d.]/g, '')),
      hav: (a, b) => page.evaluate(([a, b]) => window.__azura.distM(a, b), [a, b]),
      count: async (plugin, method) => (await callsOf(plugin, method)).length,
      watcherIds: () => page.evaluate(() => Object.keys(window.__watchers)),
      pushLoc: (id, p, acc = 4) => page.evaluate(([id, p, acc]) => window.__watchers[id]({latitude: p.lat, longitude: p.lon, accuracy: acc, altitude: null, altitudeAccuracy: null, simulated: false, bearing: null, speed: null, time: Date.now()}), [id, p, acc]),
      pushErr: (id, err) => page.evaluate(([id, err]) => window.__watchers[id](null, err), [id, err]),
      active: () => page.evaluate(() => (document.querySelector('.screen.active') || {}).id),
      modalShown: () => page.evaluate(() => document.getElementById('modal').classList.contains('show')),
      mirrorWrites: async () => (await callsOf('Filesystem', 'writeFile')).filter(c => c.options.directory === 'DATA'),
      local: () => page.evaluate(k => localStorage.getItem(k), KEY),
      loads: () => ev(() => +sessionStorage.getItem('__loads')),
      plog: () => ev(() => JSON.parse(sessionStorage.getItem('__log') || '[]')),
      mirrorFile: () => ev(p => JSON.parse(sessionStorage.getItem('__fs') || '{}')[p], MIRROR_PATH),
      logCount: s => logs.filter(m => m.text === s).length,
      warnings: s => logs.filter(m => m.type === 'warning' && m.text.includes(s)).length,
      stateSummary: () => page.evaluate(k => { const s = window.__azura.state; return {local: localStorage.getItem(k), units: s.settings.units, hole: s.ui.hole, roundIds: s.rounds.map(r => r.id).join(','), active: s.activeRoundId}; }, KEY)
    };
  }
  /* 스스로 리로드할 수 있는 페이지가 minLoads번째 로드를 마치고 조용해질 때까지 기다린 뒤 로드 횟수를 돌려준다 */
  async function settle(A, minLoads, quietMs = 1500) {
    await waitFor(async () => { const r = await A.ev(() => ({n: +sessionStorage.getItem('__loads'), ready: !!window.__azura && document.readyState === 'complete'})); return r && r.n >= minLoads && r.ready; }, 8000);
    await sleep(quietMs);
    return A.loads();
  }
  const writesIn = log => (log || []).filter(x => x.op === 'write').length;
  const readsIn = log => (log || []).filter(x => x.op === 'read').length;
  const leaked = (log, load) => { const L = (log || []).filter(x => x.load === load), gone = new Set(L.filter(x => x.op === 'removeWatcher').map(x => x.id)); return L.filter(x => x.op === 'addWatcher' && !gone.has(x.id)).map(x => x.id); };

  // 대조: 브라우저 모드(androidBridge 없음)에서는 같은 스파이가 서비스 워커 등록 1회를 본다 → 스파이가 실제로 동작함
  const ctx0 = await browser.newContext(ctxOpts);
  await ctx0.addInitScript(fakeBridge, {});
  const page0 = await ctx0.newPage(); await page0.goto(base); await sleep(400);
  const ctl = await page0.evaluate(() => ({sw: window.__swRegister, native: !!window.AzuraNative, cap: !!window.Capacitor, plat: window.Capacitor && window.Capacitor.getPlatform()}));
  ok(ctl.sw === 1 && !ctl.native && ctl.plat === 'web', `대조(브라우저 모드): 서비스 워커 등록 1회, AzuraNative 없음, 플랫폼 web ${JSON.stringify(ctl)}`);
  await ctx0.close();

  /* ==================== 안드로이드 ==================== */
  console.log('\n# 안드로이드');
  {
    const A = await openApp({platform: 'android'});
    const {page, errors, text, num, hav, callsOf, count, watcherIds, pushLoc, pushErr, active, modalShown} = A;
    const back = () => page.evaluate(() => window.__listeners['App:backButton']({canGoBack: false}));

    await page.goto(base); await sleep(600);

    // 1) 네이티브 판정
    const info = await page.evaluate(() => ({has: !!window.AzuraNative, isNative: window.AzuraNative && window.AzuraNative.isNative, plat: window.Capacitor.getPlatform(), nplat: window.AzuraNative && window.AzuraNative.platform, isNP: window.Capacitor.isNativePlatform()}));
    ok(info.has && info.isNative === true, `window.AzuraNative 존재, isNative=true ${JSON.stringify(info)}`);
    ok(info.plat === 'android' && info.nplat === 'android' && info.isNP === true, "Capacitor.getPlatform()==='android', AzuraNative.platform='android'");
    ok(A.logCount('AzuraNative ready android') === 1, `콘솔 표식 'AzuraNative ready android' 1회 (${A.logCount('AzuraNative ready android')})`);

    // 2) 서비스 워커 등록 안 함
    ok((await page.evaluate(() => window.__swRegister)) === 0, '네이티브에서는 navigator.serviceWorker.register 호출 없음');

    // 3) 라운드 없음 → 포그라운드 워처, 가짜 위치로 거리 표시
    const w1 = await waitFor(async () => { const a = await callsOf('BackgroundGeolocation', 'addWatcher'); return a.length ? a[0] : null; });
    ok(!!w1 && !('backgroundMessage' in w1.options) && !('backgroundTitle' in w1.options), `라운드 없음 → addWatcher에 backgroundMessage 없음(fg) ${w1 ? JSON.stringify(w1.options) : ''}`);
    ok(!!w1 && w1.options.requestPermissions === true && w1.options.stale === false, 'addWatcher 옵션: requestPermissions=true, stale=false');
    ok((await watcherIds()).join() === (w1 ? w1.id : ''), '활성 워처 1개(fg)');
    ok((await text('#gpsText')).startsWith('GPS 대기 중'), '위치 오기 전 GPS 대기 중 표시');
    ok(A.logCount('AzuraNative first fix ±4 m') === 0, '위치 오기 전에는 first fix 표식 없음');
    const hole1 = await page.evaluate(() => ({lat: COURSE_DEFAULT[0][1], lon: COURSE_DEFAULT[0][2], src: window.__azura.state.settings.course.holes[0].center.src}));
    ok(hole1.src === 'default', '1번홀 그린 좌표는 COURSE_DEFAULT 기본값');
    await pushLoc(w1.id, TEE); await sleep(300);
    const d0 = await hav(TEE, hole1);
    ok(near(await num('#distblock .num'), Math.round(d0), 1), `가짜 위치 → 1번홀 그린 중앙까지 ${Math.round(d0)} m 표시 (화면: ${await num('#distblock .num')})`);
    ok(/GPS ±4 m/.test(await text('#gpsText')), 'GPS 정확도 ±4 m 표시');
    ok(await page.evaluate(() => !document.getElementById('distblock').classList.contains('stale')), '위치가 신선함(stale 아님)');
    ok(A.logCount('AzuraNative first fix ±4 m') === 1, "첫 위치 → 콘솔 표식 'AzuraNative first fix ±4 m' 1회");

    // 4) 클럽 탭 → 라운드 시작 → 알림 권한 + 백그라운드 워처로 교체
    const removeBefore = await count('BackgroundGeolocation', 'removeWatcher');
    await pushLoc(w1.id, TEE);
    await page.getByRole('button', {name: '드라이버', exact: true}).click(); await sleep(300);
    ok((await text('#score')).includes('이 홀 1타'), '드라이버 탭 → 라운드 시작, 1타');
    const w2 = await waitFor(async () => { const a = await callsOf('BackgroundGeolocation', 'addWatcher'); return a.length >= 2 ? a[1] : null; });
    const cp = await callsOf('LocalNotifications', 'checkPermissions'), rp = await callsOf('LocalNotifications', 'requestPermissions');
    ok(cp.length === 1 && rp.length === 1 && w2 && cp[0].i < rp[0].i && rp[0].i < w2.i, `알림 권한 checkPermissions → requestPermissions → addWatcher 순서 (${cp.length}/${rp.length})`);
    const rm = await callsOf('BackgroundGeolocation', 'removeWatcher');
    ok(rm.length === removeBefore + 1 && rm[rm.length - 1].options.id === w1.id, `이전 fg 워처(${w1.id}) removeWatcher`);
    ok(!!w2 && typeof w2.options.backgroundMessage === 'string' && w2.options.backgroundMessage.length > 0 && typeof w2.options.backgroundTitle === 'string', `새 워처는 backgroundMessage 있음(bg) ${w2 ? JSON.stringify(w2.options) : ''}`);
    ok((await watcherIds()).join() === (w2 ? w2.id : ''), '활성 워처 1개(bg)');
    await pushLoc(w2.id, P2); await sleep(300);
    await page.getByRole('button', {name: '7번 아이언', exact: true}).click(); await sleep(300);
    const d1 = await hav(TEE, P2);
    ok((await text('#last')) === `직전 드라이버 ${Math.round(d1)} m`, `bg 워처 위치로 샷 거리: 직전 드라이버 ${Math.round(d1)} m (화면: ${await text('#last')})`);
    ok((await text('#score')).includes('이 홀 2타'), '7번 아이언 → 2타');

    // 5) visibilitychange(visible) → 같은 모드면 워처 유지
    const a5 = await count('BackgroundGeolocation', 'addWatcher'), r5 = await count('BackgroundGeolocation', 'removeWatcher');
    const vis = await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); return document.visibilityState; });
    await sleep(400);
    ok(vis === 'visible', `visibilityState는 visible (${vis})`);
    ok((await count('BackgroundGeolocation', 'addWatcher')) === a5 && (await count('BackgroundGeolocation', 'removeWatcher')) === r5, 'visibilitychange 뒤 addWatcher/removeWatcher 호출 수 불변');
    ok((await watcherIds()).join() === w2.id, '같은 bg 워처 유지');

    // 6) 메뉴 → 라운드 종료 → 종료만 → fg 워처로 복귀
    await page.locator('#menuBtn').click(); await page.getByRole('button', {name: '라운드 종료', exact: true}).click(); await sleep(200);
    ok((await text('#modal')).includes('라운드 종료'), '라운드 종료 확인창');
    await page.getByRole('button', {name: '종료만', exact: true}).click(); await sleep(400);
    ok((await active()) === 's-rounds', '종료 뒤 라운드 기록 화면');
    const w3 = await waitFor(async () => { const a = await callsOf('BackgroundGeolocation', 'addWatcher'); return a.length >= 3 ? a[2] : null; });
    const rm6 = await callsOf('BackgroundGeolocation', 'removeWatcher');
    ok(rm6.length === r5 + 1 && rm6[rm6.length - 1].options.id === w2.id, `bg 워처(${w2.id}) removeWatcher`);
    ok(!!w3 && !('backgroundMessage' in w3.options) && !('backgroundTitle' in w3.options), `backgroundMessage 없는 fg 워처 추가 (호출 순서: ${w3 && w3.i < rm6[rm6.length - 1].i ? 'addWatcher → removeWatcher' : 'removeWatcher → addWatcher'}, 플러그인은 어느 순서든 최종 상태 동일)`);
    ok((await watcherIds()).join() === (w3 ? w3.id : ''), '활성 워처 1개(fg)');
    ok((await page.evaluate(() => window.__azura.state.activeRoundId)) === null, '활성 라운드 없음');

    // 7) 라운드 기록 화면 CSV → Filesystem.writeFile(CACHE) → Share.share  (DATA 폴더 쓰기는 저장소 미러라 여기서 제외)
    await page.locator('#roundsBody .card').getByRole('button', {name: 'CSV', exact: true}).click(); await sleep(400);
    const wf = (await callsOf('Filesystem', 'writeFile')).filter(c => c.options.directory !== 'DATA'), sh = await callsOf('Share', 'share');
    const o = wf.length ? wf[0].options : {};
    ok(wf.length === 1 && /^azura_round_\d{4}-\d{2}-\d{2}\.csv$/.test(o.path) && o.directory === 'CACHE' && o.encoding === 'utf8', `Filesystem.writeFile path=${o.path} directory=${o.directory} encoding=${o.encoding}`);
    ok(typeof o.data === 'string' && o.data.charCodeAt(0) === 0xFEFF && o.data.includes('샷거리m') && o.data.includes('드라이버'), 'CSV 데이터가 BOM으로 시작하고 머리글·샷 포함');
    const expectCsv = await page.evaluate(() => window.__azura.csvText([window.__azura.state.rounds[0]]));
    ok(o.data === expectCsv, 'CSV 데이터가 csvText()와 동일');
    ok(sh.length === 1 && wf.length === 1 && sh[0].i > wf[0].i && Array.isArray(sh[0].options.files) && sh[0].options.files.length === 1 && sh[0].options.files[0] === 'file:///cache/' + o.path, `Share.share가 writeFile 뒤에 그 uri로 호출 ${sh.length ? JSON.stringify(sh[0].options.files) : ''}`);

    // 8) 안드로이드 뒤로 가기
    ok(await page.evaluate(() => typeof window.__listeners['App:backButton'] === 'function'), "App.addListener('backButton') 콜백 등록됨");
    await page.locator('#s-rounds [data-nav="play"]').click(); await sleep(150);
    await page.locator('#menuBtn').click(); await page.getByRole('button', {name: '설정', exact: true}).click(); await sleep(300);
    ok((await active()) === 's-settings', '설정 화면으로 이동');
    await back(); await sleep(200);
    ok((await active()) === 's-play', '설정 화면에서 뒤로 → 플레이 화면');
    await page.locator('#menuBtn').click(); await sleep(150);
    ok(await modalShown(), '메뉴 모달 열림');
    await back(); await sleep(200);
    ok(!(await modalShown()) && (await active()) === 's-play', '모달 열린 채 뒤로 → 모달만 닫힘');
    const minBefore = await count('App', 'minimizeApp');
    await back(); await sleep(200);
    ok((await count('App', 'minimizeApp')) === minBefore + 1 && (await active()) === 's-play', '플레이 화면에서 뒤로 → App.minimizeApp');
    ok((await count('App', 'exitApp')) === 0, 'App.exitApp은 한 번도 안 불림');

    // 9) 권한 오류 → 상태줄 + 설정 열기 토스트
    await pushErr(w3.id, {code: 'NOT_AUTHORIZED', message: 'x'}); await sleep(300);
    ok(/권한/.test(await text('#gpsText')), `GPS 상태줄에 권한 문구 (${await text('#gpsText')})`);
    const tst = page.locator('#toast');
    ok(await page.evaluate(() => document.getElementById('toast').classList.contains('show')) && /위치 권한이 필요합니다/.test(await tst.innerText()), '토스트: 위치 권한이 필요합니다');
    await tst.getByRole('button', {name: '설정 열기', exact: true}).click(); await sleep(200);
    ok((await count('BackgroundGeolocation', 'openSettings')) === 1, "'설정 열기' → BackgroundGeolocation.openSettings");
    ok(!(await page.evaluate(() => document.getElementById('toast').classList.contains('show'))), '토스트 버튼 뒤 토스트 닫힘');
    ok((await count('BackgroundGeolocation', 'addWatcher')) === 3 && (await watcherIds()).join() === w3.id, '오류 뒤에도 워처는 그대로(재시작 안 함)');

    // 10) 화면 켜두기 토글 → KeepAwake
    const ka0 = await count('KeepAwake', 'keepAwake'), as0 = await count('KeepAwake', 'allowSleep');
    ok(ka0 === 0 && as0 >= 1, `켜두기 끔 상태에서는 allowSleep만 불림 (keepAwake ${ka0}, allowSleep ${as0})`);
    await page.locator('#menuBtn').click(); await page.getByRole('button', {name: '화면 켜두기: 끔', exact: true}).click(); await sleep(200);
    ok((await count('KeepAwake', 'keepAwake')) === 1 && (await page.evaluate(() => window.__azura.state.settings.keepAwake)) === true, '화면 켜두기 켬 → KeepAwake.keepAwake');
    await page.locator('#menuBtn').click(); await page.getByRole('button', {name: '화면 켜두기: 켬', exact: true}).click(); await sleep(200);
    ok((await count('KeepAwake', 'allowSleep')) === as0 + 1 && (await page.evaluate(() => window.__azura.state.settings.keepAwake)) === false, '화면 켜두기 끔 → KeepAwake.allowSleep');
    ok((await count('KeepAwake', 'keepAwake')) === 1, '끌 때 keepAwake는 더 안 불림');

    // 11) 저장소 미러도 안드로이드에서 해 없이 돈다: 시작 때 readFile 1회(파일 없음) → 리로드 없음, App pause → 최신 값 바로 기록
    const rf = await callsOf('Filesystem', 'readFile');
    ok(rf.length === 1 && rf[0].options.path === 'azura-state.json' && rf[0].options.directory === 'DATA' && rf[0].options.encoding === 'utf8' && (await A.loads()) === 1, `미러 readFile 1회(DATA/azura-state.json, utf8), 파일 없음 → 리로드 없음 ${JSON.stringify(rf.map(c => c.options))}`);
    ok(await page.evaluate(() => typeof window.__listeners['App:pause'] === 'function'), "App.addListener('pause') 등록됨");
    await page.evaluate(() => window.__listeners['App:pause']()); await sleep(200);
    const mwA = await A.mirrorWrites();
    ok(mwA.length >= 1 && mwA.every(c => c.options.path === 'azura-state.json' && c.options.encoding === 'utf8') && mwA[mwA.length - 1].options.data === await A.local() && (await A.mirrorFile()) === await A.local(),
      `App pause 뒤 미러 파일 = localStorage 값 (미러 쓰기 ${mwA.length}회)`);
    ok(A.logCount('AzuraNative ready android') === 1 && A.logs.filter(m => m.text.startsWith('AzuraNative first fix')).length === 1, '콘솔 표식은 끝까지 각 1회');

    // 12) 오류 없음, safe-area 스타일은 안드로이드(inset 0)에서 아무 영향 없음
    const sa0 = await page.evaluate(() => { const b = getComputedStyle(document.body); return {pad: [b.paddingTop, b.paddingRight, b.paddingBottom, b.paddingLeft].join(' '), toast: getComputedStyle(document.getElementById('toast')).bottom, modal: getComputedStyle(document.getElementById('modal')).paddingBottom}; });
    ok(sa0.pad === '0px 0px 0px 0px' && sa0.toast === '90px' && sa0.modal === '12px', `(vii) inset 0(안드로이드)에서는 body 패딩 0, 토스트 bottom 90px, 창 아래 여백 12px 그대로 ${JSON.stringify(sa0)}`);
    ok(errors.length === 0, `페이지 오류 없음 ${errors.length ? JSON.stringify(errors) : ''}`);
    await A.ctx.close();
  }

  /* ==================== 아이폰 (iOS) ==================== */
  console.log('\n# 아이폰 (iOS)');
  {
    const I = await openApp({platform: 'ios'}, {width: 390, height: 844});
    const {page, text, num, callsOf, count, watcherIds, pushLoc, pushErr} = I;
    await page.goto(base); await sleep(600);

    // (i) 플랫폼 판정
    const info = await page.evaluate(() => ({plat: window.Capacitor.getPlatform(), nplat: window.AzuraNative && window.AzuraNative.platform, isNP: window.Capacitor.isNativePlatform(), isNative: window.AzuraNative && window.AzuraNative.isNative, androidBridge: 'androidBridge' in window, sw: window.__swRegister}));
    ok(info.plat === 'ios' && info.nplat === 'ios' && info.isNP === true && info.isNative === true && !info.androidBridge, `(i) iOS 가짜 브리지(webkit.messageHandlers.bridge): Capacitor.getPlatform()==='ios', AzuraNative.platform='ios' ${JSON.stringify(info)}`);
    ok(info.sw === 0, '(i) iOS에서도 서비스 워커 등록 안 함');
    ok(I.logCount('AzuraNative ready ios') === 1, `(i) 콘솔 표식 'AzuraNative ready ios' 1회 (${I.logCount('AzuraNative ready ios')})`);

    // (vi) 미러 파일 없음 → readFile 거부 → 리로드 없이 진행
    const rf = await callsOf('Filesystem', 'readFile');
    ok(rf.length === 1 && rf[0].options.path === 'azura-state.json' && rf[0].options.directory === 'DATA' && rf[0].options.encoding === 'utf8', `(vi) localStorage 비어 있음 → 시작 때 미러 readFile 1회 ${JSON.stringify(rf.map(c => c.options))}`);
    ok((await I.loads()) === 1 && (await I.mirrorWrites()).length === 0, '(vi) 미러 파일 없음(readFile 거부) → 리로드 없음, 저장 전이라 미러 쓰기 없음');

    // fg 워처, 첫 위치
    const w1 = await waitFor(async () => { const a = await callsOf('BackgroundGeolocation', 'addWatcher'); return a.length ? a[0] : null; });
    ok(!!w1 && !('backgroundMessage' in w1.options) && w1.options.requestPermissions === true, `(i) 라운드 없음 → fg 워처(backgroundMessage 없음) ${w1 ? JSON.stringify(w1.options) : ''}`);
    ok(I.logs.filter(m => m.text.startsWith('AzuraNative first fix')).length === 0, '(i) 위치 오기 전에는 first fix 표식 없음');
    await pushLoc(w1.id, TEE); await sleep(300);
    const hole1 = await page.evaluate(() => ({lat: COURSE_DEFAULT[0][1], lon: COURSE_DEFAULT[0][2]}));
    const d0 = await I.hav(TEE, hole1);
    ok(near(await num('#distblock .num'), Math.round(d0), 1) && /GPS ±4 m/.test(await text('#gpsText')), `(i) 가짜 위치 → 거리 ${Math.round(d0)} m, GPS ±4 m 표시`);
    ok(I.logCount('AzuraNative first fix ±4 m') === 1, "(i) 첫 위치 → 콘솔 표식 'AzuraNative first fix ±4 m' 1회");

    // (i) 클럽 탭 → 라운드 시작 → 알림 권한 없이 bg 워처
    await pushLoc(w1.id, TEE);
    await page.getByRole('button', {name: '드라이버', exact: true}).click(); await sleep(300);
    ok((await text('#score')).includes('이 홀 1타'), '(i) 드라이버 탭 → 라운드 시작, 1타');
    const w2 = await waitFor(async () => { const a = await callsOf('BackgroundGeolocation', 'addWatcher'); return a.length >= 2 ? a[1] : null; });
    ok(!!w2 && typeof w2.options.backgroundMessage === 'string' && w2.options.backgroundMessage.length > 0, `(i) 라운드 중 워처는 backgroundMessage 있음(iOS 백그라운드 위치) ${w2 ? JSON.stringify(w2.options) : ''}`);
    ok((await I.calls()).filter(c => c.plugin === 'LocalNotifications').length === 0, '(i) 라운드 시작 때 LocalNotifications 호출 없음(권한 창 안 뜸)');
    const rm = await callsOf('BackgroundGeolocation', 'removeWatcher');
    ok(rm.length === 1 && rm[0].options.id === w1.id && (await watcherIds()).join() === (w2 ? w2.id : ''), `(i) fg 워처(${w1.id}) removeWatcher, 활성 워처 1개(bg)`);
    await pushLoc(w2.id, P2); await sleep(300);
    await page.getByRole('button', {name: '7번 아이언', exact: true}).click(); await sleep(300);
    const d1 = await I.hav(TEE, P2);
    ok((await text('#last')) === `직전 드라이버 ${Math.round(d1)} m`, `(i) bg 워처 위치로 샷 거리: 직전 드라이버 ${Math.round(d1)} m`);

    // (i) 뒤로 가기 리스너 없음, pause 리스너는 있음
    const listen = (await I.calls()).filter(c => c.plugin === 'App' && c.method === 'addListener').map(c => c.options && c.options.eventName);
    ok(!listen.includes('backButton') && !(await page.evaluate(() => 'App:backButton' in window.__listeners)), `(i) App.addListener('backButton') 미등록 (등록된 이벤트: ${listen.join(', ')})`);
    ok(listen.includes('pause') && await page.evaluate(() => typeof window.__listeners['App:pause'] === 'function'), "(ii) App.addListener('pause') 등록됨(미러 즉시 기록용)");

    // (ii)/(vi) 라운드 시작 저장 → 0.8초 디바운스 뒤 미러 writeFile({path, directory: DATA, encoding: utf8, data: localStorage 값})
    await waitFor(async () => (await I.mirrorWrites()).length >= 1, 3000); await sleep(1000);
    const mw = await I.mirrorWrites(), lv = await I.local();
    const m0 = mw.length ? mw[mw.length - 1].options : {};
    ok(mw.length >= 1 && Object.keys(m0).sort().join() === 'data,directory,encoding,path' && m0.path === 'azura-state.json' && m0.directory === 'DATA' && m0.encoding === 'utf8',
      `(ii) 저장 뒤 미러 writeFile 옵션 {path:'azura-state.json', directory:'DATA', encoding:'utf8', data} (${mw.length}회)`);
    ok(m0.data === lv && JSON.parse(lv).rounds.length === 1 && (await I.mirrorFile()) === lv, '(ii)/(vi) 미러 data = localStorage 값(라운드 1개 포함), 가짜 파일에도 같은 값');
    ok(mw.length <= 2, `(ii) 탭 두 번에 여러 번 저장해도 디바운스로 미러 쓰기는 ${mw.length}회`);

    // (ii) 디바운스: 연달아 3번 저장 → 0.3초엔 없음, 1.3초엔 마지막 값으로 정확히 1회
    const deb = await page.evaluate(async () => {
      const W = window.__dataWrites, n0 = W().length, wait = ms => new Promise(r => setTimeout(r, ms));
      for (let k = 0; k < 3; k++) document.getElementById('nextHole').click();
      await wait(300); const at300 = W().length - n0;
      await wait(1000); const after = W();
      return {at300, at1300: after.length - n0, same: after.length > 0 && after[after.length - 1].options.data === localStorage.getItem('azura.gps.v1'), hole: window.__azura.state.ui.hole};
    });
    ok(deb.at300 === 0 && deb.at1300 === 1 && deb.same && deb.hole === 4, `(ii) 다음 홀 3번 연달아 저장 → 0.3초엔 미러 쓰기 0회, 1.3초엔 마지막 값(4번홀)으로 1회 ${JSON.stringify(deb)}`);

    // (e) 같은 값이면 다시 쓰지 않음
    const same = await page.evaluate(async () => { const n0 = window.__dataWrites().length; window.__azura.save(); window.__azura.save(); await new Promise(r => setTimeout(r, 1200)); return window.__dataWrites().length - n0; });
    ok(same === 0, `(e) 같은 상태를 다시 저장 → 미러 쓰기 없음 (${same}회)`);

    // (ii) App pause → 디바운스를 기다리지 않고 바로 1회, 뒤따르는 중복 쓰기 없음
    const pz = await page.evaluate(async () => {
      const W = window.__dataWrites, n0 = W().length, wait = ms => new Promise(r => setTimeout(r, ms));
      document.getElementById('nextHole').click();     // 저장 → 0.8초 타이머
      window.__listeners['App:pause']();                // 앱이 백그라운드로
      await wait(50); const at50 = W().length - n0, last = W()[W().length - 1];
      await wait(1200);
      return {at50, at1250: W().length - n0, same: !!last && last.options.data === localStorage.getItem('azura.gps.v1')};
    });
    ok(pz.at50 === 1 && pz.at1250 === 1 && pz.same, `(ii) 저장 직후 App pause 리스너 호출 → 0.05초 안에 미러 1회(최신 값), 디바운스 뒤 추가 쓰기 없음 ${JSON.stringify(pz)}`);

    // (d) 화면 숨김(visibilitychange hidden) → 바로 1회
    const vh = await page.evaluate(async () => {
      const W = window.__dataWrites, n0 = W().length, wait = ms => new Promise(r => setTimeout(r, ms));
      document.getElementById('nextHole').click();
      Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
      document.dispatchEvent(new Event('visibilitychange'));
      await wait(50); const at50 = W().length - n0, last = W()[W().length - 1];
      delete document.visibilityState;                  // 원래 값(visible)으로
      await wait(1200);
      return {at50, at1250: W().length - n0, same: !!last && last.options.data === localStorage.getItem('azura.gps.v1'), vis: document.visibilityState};
    });
    ok(vh.at50 === 1 && vh.at1250 === 1 && vh.same && vh.vis === 'visible', `(d) 화면 숨김(visibilitychange hidden) → 바로 미러 1회 ${JSON.stringify(vh)}`);

    // localStorage의 'azura.gps.v1'만 가로챈다: sessionStorage의 같은 키, localStorage의 다른 키는 미러로 안 감. 명명 속성 'setItem' 없음
    const other = await page.evaluate(async () => {
      const n0 = window.__dataWrites().length;
      sessionStorage.setItem('azura.gps.v1', '{"settings":{}}'); localStorage.setItem('azura.other', 'x');
      await new Promise(r => setTimeout(r, 1200));
      const r = {n: window.__dataWrites().length - n0, ss: sessionStorage.getItem('azura.gps.v1'), other: localStorage.getItem('azura.other'),
        own: Object.prototype.hasOwnProperty.call(localStorage, 'setItem'), named: localStorage.getItem('setItem'), keys: Object.keys(localStorage).join()};
      sessionStorage.removeItem('azura.gps.v1'); localStorage.removeItem('azura.other');
      return r;
    });
    ok(other.n === 0 && other.ss === '{"settings":{}}' && other.other === 'x' && !other.own && other.named === null,
      `Storage.prototype.setItem 감싸기: sessionStorage·다른 키는 그대로 저장되고 미러로 안 감, localStorage에 'setItem' 항목 없음 (키: ${other.keys})`);

    // (f) 미러 쓰기 실패 → console.warn 한 줄, 앱은 계속. 다음 기회(App pause)에 다시 써서 따라잡음
    await page.evaluate(() => sessionStorage.setItem('__fsFail', '1'));
    const wBefore = I.warnings('저장 미러 쓰기 실패'), nBefore = (await I.mirrorWrites()).length;
    await page.locator('#nextHole').click(); await sleep(1300);
    ok((await I.mirrorWrites()).length === nBefore + 1 && I.warnings('저장 미러 쓰기 실패') === wBefore + 1 && (await text('#holeBtn')).startsWith('7번홀') && I.errors.length === 0,
      `(f) 미러 쓰기 실패 → console.warn 1줄, 페이지 오류 없음, 앱 계속 (경고 ${I.warnings('저장 미러 쓰기 실패') - wBefore}회)`);
    await page.evaluate(() => { sessionStorage.removeItem('__fsFail'); window.__listeners['App:pause'](); }); await sleep(200);
    const mwF = await I.mirrorWrites();
    ok(mwF.length === nBefore + 2 && mwF[mwF.length - 1].options.data === await I.local() && (await I.mirrorFile()) === await I.local(), '(f) 실패한 값은 들고 있다가 다음 App pause에서 다시 써서 미러 = localStorage');

    // iOS 위치 오류: 일시 오류는 워처를 버리지 않고(플러그인이 계속 위치를 보냄) 다음 위치로 회복
    const a0 = await count('BackgroundGeolocation', 'addWatcher'), r0 = await count('BackgroundGeolocation', 'removeWatcher');
    await pushErr(w2.id, {message: 'The operation couldn’t be completed. (kCLErrorDomain error 2.)'}); await sleep(300);
    ok(/GPS 신호 없음/.test(await text('#gpsText')), `iOS 일시 위치 오류 → 상태줄 'GPS 신호 없음' (${await text('#gpsText')})`);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(300);   // app.js가 startGeo를 다시 불러도
    ok((await count('BackgroundGeolocation', 'addWatcher')) === a0 && (await count('BackgroundGeolocation', 'removeWatcher')) === r0 && (await watcherIds()).join() === w2.id, 'iOS 일시 오류 → 같은 bg 워처 유지(새로 만들거나 지우지 않음)');
    await pushLoc(w2.id, P2, 5); await sleep(300);
    ok(/^GPS ±5 m/.test(await text('#gpsText')), `iOS 같은 워처의 다음 위치로 회복 (${await text('#gpsText')})`);
    // 권한 거부: 플러그인 메시지 'Permission denied.' → 설정 열기 토스트, 워처 유지(권한이 바뀌면 플러그인이 다시 시작)
    await pushErr(w2.id, {code: 'NOT_AUTHORIZED', message: 'Permission denied.'}); await sleep(300);
    ok(/위치 권한이 필요합니다/.test(await text('#toast')) && /권한/.test(await text('#gpsText')), 'iOS 권한 거부 → 상태줄 권한 문구 + 토스트');
    await page.locator('#toast').getByRole('button', {name: '설정 열기', exact: true}).click(); await sleep(200);
    ok((await count('BackgroundGeolocation', 'openSettings')) === 1 && (await watcherIds()).join() === w2.id, "iOS '설정 열기' → openSettings, 워처 유지");

    // iOS 내보내기: 캐시에 쓰고 공유 시트
    await page.locator('#menuBtn').click(); await page.getByRole('button', {name: '라운드 기록', exact: true}).click(); await sleep(300);
    await page.locator('#roundsBody .card').getByRole('button', {name: 'CSV', exact: true}).click(); await sleep(400);
    const wfI = (await callsOf('Filesystem', 'writeFile')).filter(c => c.options.directory === 'CACHE'), shI = await callsOf('Share', 'share');
    ok(wfI.length === 1 && /^azura_round_.*\.csv$/.test(wfI[0].options.path) && shI.length === 1 && shI[0].options.files[0] === 'file:///cache/' + wfI[0].options.path, 'iOS CSV 내보내기 → writeFile(CACHE) → Share.share(files)');
    await page.locator('#s-rounds [data-nav="play"]').click(); await sleep(200);

    // (i) 콘솔 표식은 끝까지 각각 정확히 한 번 (위치 여러 번, 워처 교체 뒤에도)
    ok(I.logCount('AzuraNative ready ios') === 1 && I.logs.filter(m => m.text.startsWith('AzuraNative ready')).length === 1, "(i) 'AzuraNative ready ios' 정확히 1회");
    ok(I.logCount('AzuraNative first fix ±4 m') === 1 && I.logs.filter(m => m.text.startsWith('AzuraNative first fix')).length === 1, "(i) 'AzuraNative first fix ±4 m' 정확히 1회 (위치를 여러 번, 두 워처에서 받은 뒤)");
    ok((await count('App', 'minimizeApp')) === 0 && (await I.loads()) === 1, 'iOS: minimizeApp 호출 없음, 리로드 없음');

    // (vii) 노치·홈 바 흉내(safe-area inset 위 47, 아래 34): 본문·토스트·창이 그만큼 비켜남
    const cdp = await I.ctx.newCDPSession(page);
    let insetOk = true;
    try { await cdp.send('Emulation.setSafeAreaInsetsOverride', {insets: {top: 47, bottom: 34, left: 0, right: 0}}); } catch (e) { insetOk = false; console.log('  (이 Chromium은 Emulation.setSafeAreaInsetsOverride를 지원하지 않음: ' + e.message + ')'); }
    await sleep(200);
    await page.locator('#menuBtn').click(); await sleep(200);
    const sa = await page.evaluate(() => {
      const b = getComputedStyle(document.body), act = document.querySelector('#s-play .actions').getBoundingClientRect(), top = document.querySelector('#s-play .topbar').getBoundingClientRect();
      const sheet = document.querySelector('#modal .sheet').getBoundingClientRect();
      return {pt: b.paddingTop, pb: b.paddingBottom, toast: getComputedStyle(document.getElementById('toast')).bottom, modal: getComputedStyle(document.getElementById('modal')).paddingBottom,
        topbar: Math.round(top.top), actions: Math.round(act.bottom), sheet: Math.round(sheet.bottom), h: innerHeight, scroll: document.documentElement.scrollHeight};
    });
    await page.getByRole('button', {name: '닫기', exact: true}).click(); await sleep(150);
    if (!insetOk) console.log('SKIP  (vii) inset 배치 검사: 이 Chromium에는 Emulation.setSafeAreaInsetsOverride가 없음 (www/index.html 스타일 검사는 아래에서 따로 함)');
    else {
      ok(sa.pt === '47px' && sa.pb === '34px' && sa.topbar === 47 && sa.actions === sa.h - 34 && sa.scroll === sa.h,
        `(vii) inset(위 47, 아래 34): body 패딩, 상단바는 노치 아래, 하단 버튼은 홈 바 위, 세로 스크롤 없음 ${JSON.stringify(sa)}`);
      ok(sa.toast === '124px' && sa.modal === '46px' && sa.sheet === sa.h - 46, `(vii) 토스트 bottom 90+34=124px, 창 아래 여백 12+34=46px`);
    }
    ok(I.errors.length === 0, `iOS 페이지 오류 없음 ${I.errors.length ? JSON.stringify(I.errors) : ''}`);
    await I.ctx.close();
  }

  /* ==================== 저장소 미러 복원 ==================== */
  console.log('\n# 저장소 미러 복원');
  // (iii) localStorage 비어 있음 + 미러 있음 → 정확히 한 번 리로드, 미러 데이터가 화면에
  {
    const R = await openApp({platform: 'ios', file: MIRROR_A});
    await R.page.goto(base, {waitUntil: 'commit'});          // 곧 스스로 다시 읽으므로 load를 기다리지 않는다
    const n = await settle(R, 2);
    ok(n === 2, `(iii) localStorage 비어 있고 미러 있음 → 정확히 한 번 리로드, 두 번째 리로드 없음 (로드 ${n}회)`);
    const st = await R.stateSummary();
    ok(st.local === MIRROR_A, '(iii) 미러 내용이 그대로 localStorage에 들어감');
    ok(st.units === 'yd' && (await R.text('#unitBtn')) === 'yd' && (await R.text('#holeBtn')).startsWith('3번홀'), `(iii) 화면에 미러 데이터: 단위 yd, 3번홀 (${await R.text('#unitBtn')}, ${await R.text('#holeBtn')})`);
    await R.page.locator('#menuBtn').click(); await R.page.getByRole('button', {name: '라운드 기록', exact: true}).click(); await sleep(300);
    ok(st.roundIds === 'mirror-round' && (await R.page.locator('#roundsBody .card').count()) === 1 && /2026-10-01/.test(await R.text('#roundsBody .card')), `(iii) 라운드 기록 화면에 미러의 라운드 1개 (${st.roundIds})`);
    await R.page.locator('#s-rounds [data-nav="play"]').click(); await sleep(150);
    const log = await R.plog();
    ok(readsIn(log) === 1 && writesIn(log) === 0 && (await R.mirrorFile()) === MIRROR_A, `(iii) 미러는 첫 로드에서 한 번만 읽고, 복원하면서 쓰지 않음 (읽기 ${readsIn(log)}, 쓰기 ${writesIn(log)})`);
    const added1 = log.filter(x => x.load === 1 && x.op === 'addWatcher').length;
    ok(added1 === 0 && leaked(log, 1).length === 0, `(iii) 복원 판정 전에는 위치 워처를 만들지 않아 다시 읽은 뒤 네이티브에 남는 워처 없음 (추가 ${added1}, 남음 ${leaked(log, 1).join() || '없음'})`);
    ok(R.logCount('AzuraNative ready ios') === 2, `콘솔 표식 ready는 로드마다 1회 (로드 2회 → ${R.logCount('AzuraNative ready ios')})`);
    await R.page.locator('#unitBtn').click();                  // 복원 뒤 저장은 다시 미러로 간다
    await waitFor(async () => (await R.mirrorWrites()).length >= 1, 3000); await sleep(300);
    const mw = await R.mirrorWrites();
    ok(mw.length === 1 && mw[0].options.data === await R.local() && JSON.parse(mw[0].options.data).settings.units === 'm' && (await R.mirrorFile()) === await R.local(), '(iii) 복원 뒤 저장(단위 m) → 미러 갱신');
    ok(R.errors.length === 0, `(iii) 페이지 오류 없음 ${R.errors.length ? JSON.stringify(R.errors) : ''}`);
    await R.ctx.close();
  }
  // (iv) 경합: readFile 0.5초 지연 중 클럽 탭 → 판정 전 미러 쓰기 없음 → 미러로 복원
  {
    const RC = await openApp({platform: 'ios', file: MIRROR_A, readDelay: 500});
    await RC.page.goto(base, {waitUntil: 'domcontentloaded'});
    await RC.page.getByRole('button', {name: '드라이버', exact: true}).click();
    const mid = await RC.ev(async () => {
      window.__listeners['App:pause']();                  // 판정 중 앱 전환: 바로 쓰는 경로도 막혀 있어야 한다
      Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.visibilityState;
      await new Promise(r => setTimeout(r, 50));
      return {read: window.__readDone, local: localStorage.getItem('azura.gps.v1'), writes: window.__dataWrites().length};
    });
    const midLocal = mid && mid.local ? JSON.parse(mid.local) : null;
    ok(!!mid && mid.read === false && !!midLocal && midLocal.rounds.length === 1 && midLocal.settings.units === 'm' && mid.writes === 0,
      `(iv) readFile 응답 전 클럽 탭 + App pause + 화면 숨김 → app.js는 기본 상태+새 라운드를 localStorage에 저장했지만 미러 writeFile 없음 ${mid ? JSON.stringify({read: mid.read, writes: mid.writes, rounds: midLocal && midLocal.rounds.length}) : ''}`);
    const n = await settle(RC, 2);
    const st = await RC.stateSummary();
    ok(n === 2 && st.local === MIRROR_A && st.units === 'yd' && st.roundIds === 'mirror-round', `(iv) 판정 뒤 미러 데이터로 복원(탭으로 만든 라운드가 아니라 미러의 라운드), 리로드 1회 (로드 ${n}회, 라운드 ${st.roundIds})`);
    const log = await RC.plog();
    ok(writesIn(log) === 0 && (await RC.mirrorFile()) === MIRROR_A, `(iv) 두 로드 내내 미러 writeFile 없음, 미러 파일 그대로 (쓰기 ${writesIn(log)})`);
    const bg1 = log.filter(x => x.load === 1 && x.op === 'addWatcher' && x.bg).length;
    ok(bg1 === 0 && leaked(log, 1).length === 0, `(iv) 판정 중 탭으로 켜려던 라운드용(bg) 워처도 판정 전에는 만들지 않음, 남는 워처 없음 (bg ${bg1}, 남음 ${leaked(log, 1).join() || '없음'})`);
    ok(RC.errors.length === 0, `(iv) 페이지 오류 없음 ${RC.errors.length ? JSON.stringify(RC.errors) : ''}`);
    await RC.ctx.close();
  }
  // (iv) 경합, 미러 없음, readFile이 디바운스(0.8초)보다 느림(2초): 판정 중 들어온 값은 들고만 있다가
  //      복원 안 하기로 정해지면 마지막 값만 1회
  {
    const RN = await openApp({platform: 'ios', readDelay: 2000});
    await RN.page.goto(base, {waitUntil: 'domcontentloaded'});
    await RN.page.getByRole('button', {name: '드라이버', exact: true}).click();
    await RN.page.getByRole('button', {name: '7번 아이언', exact: true}).click();
    await sleep(1000);                                          // 마지막 저장 뒤 디바운스(0.8초)가 지나도
    const mid = await RN.ev(async () => { window.__listeners['App:pause'](); await new Promise(r => setTimeout(r, 50)); return {read: window.__readDone, writes: window.__dataWrites().length}; });
    ok(!!mid && mid.read === false && mid.writes === 0, `(iv) 미러 없음 + readFile 응답 전 두 번 탭, 1초 대기, App pause → 판정 전 미러 쓰기 없음 ${JSON.stringify(mid)}`);
    await waitFor(() => RN.ev(() => window.__readDone), 4000); await sleep(1500);   // 판정 + 디바운스 0.8초 + 여유
    const mw = await RN.mirrorWrites(), lv = await RN.local();
    ok(mw.length === 1 && mw[0].options.data === lv && JSON.parse(lv).rounds[0].events.length === 2 && (await RN.loads()) === 1,
      `(iv) 복원하지 않기로 정해진 뒤 마지막 값(샷 2개)만 1회 쓰기, 리로드 없음 (쓰기 ${mw.length}회)`);
    ok(RN.errors.length === 0, `(iv) 페이지 오류 없음 ${RN.errors.length ? JSON.stringify(RN.errors) : ''}`);
    await RN.ctx.close();
  }
  // (v) localStorage에 이미 데이터가 있으면 미러가 달라도 복원·리로드 없음, 미러 쓰기는 바로 허용
  {
    const L = await openApp({platform: 'ios', local: LOCAL_B, file: MIRROR_A});
    await L.page.goto(base); await sleep(1200);
    const st = await L.stateSummary();
    ok((await L.loads()) === 1 && st.local === LOCAL_B && st.units === 'm' && st.roundIds === '' && (await L.text('#holeBtn')).startsWith('5번홀'),
      `(v) localStorage 데이터(단위 m, 5번홀) 그대로, 미러(yd, 라운드 1개)로 복원·리로드 없음 (로드 ${await L.loads()}회, 미러 읽기 ${readsIn(await L.plog())}회)`);
    ok(writesIn(await L.plog()) === 0 && (await L.mirrorFile()) === MIRROR_A, '(v) 저장 전에는 미러 파일 그대로');
    await L.page.locator('#nextHole').click();
    await waitFor(async () => (await L.mirrorWrites()).length >= 1, 3000); await sleep(300);
    const mw = await L.mirrorWrites();
    ok(mw.length === 1 && mw[0].options.data === await L.local() && JSON.parse(mw[0].options.data).ui.hole === 6 && (await L.mirrorFile()) === await L.local(), '(v) 판정 없이 미러 쓰기 바로 허용: 다음 홀 저장 → 미러 = localStorage');
    ok(L.errors.length === 0, `(v) 페이지 오류 없음 ${L.errors.length ? JSON.stringify(L.errors) : ''}`);
    await L.ctx.close();
  }
  // (b) 미러가 올바른 상태가 아님(settings 없는 JSON, 잘린 JSON) → 복원·리로드 없이 진행, 다음 저장이 미러를 고쳐 씀
  for (const [label, bad] of [['settings 없는 JSON', '{"schema":1,"rounds":[{"id":"x","events":[]}]}'], ['잘린 JSON', MIRROR_A.slice(0, 120)]]) {
    const B = await openApp({platform: 'ios', file: bad});
    await B.page.goto(base); await sleep(1000);
    const st = await B.stateSummary();
    ok((await B.loads()) === 1 && st.local === null && st.units === 'm' && st.roundIds === '' && readsIn(await B.plog()) === 1, `(b) 미러가 ${label} → 읽기만 하고 복원·리로드 없이 기본 상태로 진행`);
    await B.page.locator('#nextHole').click();
    await waitFor(async () => (await B.mirrorWrites()).length >= 1, 3000); await sleep(300);
    ok((await B.mirrorWrites()).length === 1 && (await B.mirrorFile()) === await B.local() && JSON.parse(await B.mirrorFile()).ui.hole === 2 && B.errors.length === 0,
      `(b) ${label} 미러는 다음 저장(2번홀)에서 올바른 상태로 바뀜, 페이지 오류 없음 ${B.errors.length ? JSON.stringify(B.errors) : ''}`);
    await B.ctx.close();
  }
  // 복원 실패 1: 미러가 localStorage 용량을 넘음 → 리로드 없음, 이번 실행은 저장을 멈춰 미러를 지킴, 알림
  {
    const Q = await openApp({platform: 'ios', bigFile: true});
    await Q.page.goto(base); await sleep(1500);
    ok((await Q.loads()) === 1 && Q.warnings('저장 미러 복원 실패') === 1 && /이전 기록을 되살리지 못했습니다/.test(await Q.text('#toast')),
      `복원 실패(용량 초과) → 리로드 없음, console.warn 1줄, 토스트 안내 (경고 ${Q.warnings('저장 미러 복원 실패')}회)`);
    await Q.page.getByRole('button', {name: '드라이버', exact: true}).click(); await sleep(1200);
    ok((await Q.local()) === null && (await Q.mirrorWrites()).length === 0 && (await Q.text('#score')).includes('이 홀 1타') && Q.errors.length === 0,
      `복원 실패 뒤 이번 실행은 localStorage·미러 저장을 멈춤(다음 실행이 다시 복원), 화면은 동작, 페이지 오류 없음 ${Q.errors.length ? JSON.stringify(Q.errors) : ''}`);
    await Q.ctx.close();
  }
  // 복원 실패 2: 되살린 값이 리로드 뒤 사라짐 → sessionStorage 표시로 두 번째 리로드 없음(무한 리로드 방지)
  {
    const G = await openApp({platform: 'ios', file: MIRROR_A, wipeLocalOnLoad: 2});
    await G.page.goto(base, {waitUntil: 'commit'});
    const n = await settle(G, 2, 2000);
    const log = await G.plog();
    ok(n === 2 && readsIn(log) === 1 && G.warnings('저장 미러 복원 실패') === 1, `리로드 뒤에도 localStorage가 비어 있으면 다시 리로드하지 않음 (로드 ${n}회, 미러 읽기 ${readsIn(log)}회)`);
    await G.page.getByRole('button', {name: '드라이버', exact: true}).click(); await sleep(1200);
    ok((await G.local()) === null && writesIn(await G.plog()) === 0 && (await G.mirrorFile()) === MIRROR_A && G.errors.length === 0, '그 실행에서 탭해도 미러 파일은 그대로(덮어쓰지 않음)');
    await G.ctx.close();
  }

  /* ==================== (vii) 웹 파일: 앱용 www/index.html에만 safe-area 스타일 ==================== */
  console.log('\n# www/index.html');
  {
    const wwwHtml = fs.readFileSync(path.join(www, 'index.html'), 'utf8'), rootHtml = fs.readFileSync(path.join(apk, '..', 'index.html'), 'utf8');
    const m = wwwHtml.match(/<style id="native-safe-area">\n([\s\S]*?)<\/style>\n<\/head>/);
    const css = m ? m[1] : '';
    ok(!!m && css.includes('body{padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}') &&
      css.includes('#toast{bottom:calc(90px + env(safe-area-inset-bottom))}') && css.includes('#modal{padding-bottom:calc(12px + env(safe-area-inset-bottom))}'),
      '(vii) www/index.html: </head> 바로 앞에 <style id="native-safe-area"> (body 패딩, #toast, #modal)');
    ok(!rootHtml.includes('native-safe-area') && !rootHtml.includes('safe-area-inset'), '(vii) 루트 index.html에는 safe-area 스타일 없음(웹앱 그대로)');
    const scripts = '<script src="./capacitor.js"></script>\n<script src="./native.js"></script>\n<script src="./app.js"></script>';
    ok(wwwHtml.includes(scripts), '(vii) 기존 스크립트 삽입 유지: capacitor.js → native.js → app.js');
    ok(m && wwwHtml.replace(m[0], '</head>').replace(scripts, '<script src="./app.js"></script>') === rootHtml, '(vii) 끼워 넣은 두 곳을 빼면 www/index.html = 루트 index.html');
  }

  await browser.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
