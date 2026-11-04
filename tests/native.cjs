/* 안드로이드 기기 없이 APK 연결 코드(apk/native.js)와 app.js의 네이티브 분기를 검증한다.
   apk/copy-web.js로 www/를 만들어 서빙하고, 페이지 스크립트보다 먼저 가짜 안드로이드 브리지
   (window.androidBridge + window.Capacitor{PluginHeaders, nativePromise, nativeCallback})를 심는다.
   복사된 실제 capacitor.js가 그 위에 합쳐져 registerPlugin 프록시가 가짜 브리지를 부르는지가 핵심이다.
   실행: node tests/native.cjs  (Chromium + Playwright 필요) */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const apk = path.resolve(__dirname, '..', 'apk'), www = path.join(apk, 'www');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png'};
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(50); } };

/* 페이지 스크립트보다 먼저 실행되는 가짜 네이티브 브리지. native=false면 서비스 워커 스파이만 둔다(브라우저 모드 대조용). */
function fakeBridge({native}) {
  window.__swRegister = 0;
  // Playwright의 serviceWorkers:'block'이 navigator.serviceWorker 인스턴스에 자체 register를 얹으므로 인스턴스에 직접 스파이를 둔다
  const spy = function () { window.__swRegister++; return Promise.reject(new Error('test: blocked')); };
  if (window.ServiceWorkerContainer) ServiceWorkerContainer.prototype.register = spy;
  if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'register', {value: spy, configurable: true, writable: true});
  if (!native) return;
  window.androidBridge = {postMessage() {}};                   // capacitor.js의 getPlatformId → 'android'
  window.__calls = []; window.__watchers = {}; window.__listeners = {};
  let seq = 100;
  const H = (name, m) => ({name, methods: Object.entries(m).map(([n, rtype]) => ({name: n, rtype}))});
  window.Capacitor = {
    PluginHeaders: [
      H('BackgroundGeolocation', {addWatcher: 'callback', removeWatcher: 'promise', openSettings: 'promise'}),
      H('Filesystem', {writeFile: 'promise'}),
      H('Share', {share: 'promise'}),
      H('App', {addListener: 'callback', removeListener: 'promise', minimizeApp: 'promise', exitApp: 'promise'}),
      H('KeepAwake', {keepAwake: 'promise', allowSleep: 'promise'}),
      H('LocalNotifications', {checkPermissions: 'promise', requestPermissions: 'promise'})],
    nativePromise(plugin, method, options) {
      window.__calls.push({plugin, method, options: options == null ? null : options});
      const key = plugin + '.' + method;
      if (key === 'BackgroundGeolocation.removeWatcher') delete window.__watchers[options && options.id];
      if (key === 'App.removeListener') delete window.__listeners[plugin + ':' + (options && options.eventName)];
      if (key === 'Filesystem.writeFile') return Promise.resolve({uri: 'file:///cache/' + options.path});
      if (key === 'LocalNotifications.checkPermissions') return Promise.resolve({display: 'prompt'});   // 아직 안 물어봄 → requestPermissions까지 가게
      if (key === 'LocalNotifications.requestPermissions') return Promise.resolve({display: 'granted'});
      return Promise.resolve({});
    },
    nativeCallback(plugin, method, options, cb) {
      const id = String(++seq);                                 // 실제 브리지처럼 콜백 id 문자열을 동기로 돌려준다
      window.__calls.push({plugin, method, options: options == null ? null : options, id});
      if (plugin === 'BackgroundGeolocation' && method === 'addWatcher') window.__watchers[id] = cb;
      else if (method === 'addListener') window.__listeners[plugin + ':' + (options && options.eventName)] = cb;
      return id;
    }
  };
}

(async () => {
  execFileSync(process.execPath, [path.join(apk, 'copy-web.js')], {stdio: 'inherit'});
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    fs.readFile(path.join(www, p), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, {'content-type': types[path.extname(p)] || 'application/octet-stream'}); res.end(d); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/`;  // localhost여야 app.js의 서비스 워커 등록 조건이 참이 된다

  const HOLE1 = null;                                          // COURSE_DEFAULT[0]에서 읽는다
  const TEE = {lat: -17.6830, lon: 49.5};
  const P2 = {lat: -17.6815, lon: 49.5};
  const browser = await chromium.launch();
  const ctxOpts = {viewport: {width: 360, height: 740}, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'ko-KR'};

  // 대조: 브라우저 모드(androidBridge 없음)에서는 같은 스파이가 서비스 워커 등록 1회를 본다 → 스파이가 실제로 동작함
  const ctx0 = await browser.newContext(ctxOpts);
  await ctx0.addInitScript(fakeBridge, {native: false});
  const page0 = await ctx0.newPage(); await page0.goto(base); await sleep(400);
  const ctl = await page0.evaluate(() => ({sw: window.__swRegister, native: !!window.AzuraNative, cap: !!window.Capacitor, plat: window.Capacitor && window.Capacitor.getPlatform()}));
  ok(ctl.sw === 1 && !ctl.native && ctl.plat === 'web', `대조(브라우저 모드): 서비스 워커 등록 1회, AzuraNative 없음, 플랫폼 web ${JSON.stringify(ctl)}`);
  await ctx0.close();

  const ctx = await browser.newContext(ctxOpts);               // 위치 권한 없음: 네이티브 경로가 아니면 거리가 나올 수 없다
  await ctx.addInitScript(fakeBridge, {native: true});
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const text = sel => page.locator(sel).innerText();
  const num = async sel => parseFloat((await text(sel)).replace(/[^\d.]/g, ''));
  const hav = (a, b) => page.evaluate(([a, b]) => window.__azura.distM(a, b), [a, b]);
  const calls = () => page.evaluate(() => window.__calls.map((c, i) => Object.assign({i}, c)));
  const callsOf = async (plugin, method) => (await calls()).filter(c => c.plugin === plugin && c.method === method);
  const count = async (plugin, method) => (await callsOf(plugin, method)).length;
  const watcherIds = () => page.evaluate(() => Object.keys(window.__watchers));
  const pushLoc = (id, p, acc = 4) => page.evaluate(([id, p, acc]) => window.__watchers[id]({latitude: p.lat, longitude: p.lon, accuracy: acc, altitude: null, altitudeAccuracy: null, simulated: false, bearing: null, speed: null, time: Date.now()}), [id, p, acc]);
  const pushErr = (id, err) => page.evaluate(([id, err]) => window.__watchers[id](null, err), [id, err]);
  const back = () => page.evaluate(() => window.__listeners['App:backButton']({canGoBack: false}));
  const active = () => page.evaluate(() => (document.querySelector('.screen.active') || {}).id);
  const modalShown = () => page.evaluate(() => document.getElementById('modal').classList.contains('show'));

  await page.goto(base); await sleep(600);

  // 1) 네이티브 판정
  const info = await page.evaluate(() => ({has: !!window.AzuraNative, isNative: window.AzuraNative && window.AzuraNative.isNative, plat: window.Capacitor.getPlatform(), nplat: window.AzuraNative && window.AzuraNative.platform, isNP: window.Capacitor.isNativePlatform()}));
  ok(info.has && info.isNative === true, `window.AzuraNative 존재, isNative=true ${JSON.stringify(info)}`);
  ok(info.plat === 'android' && info.nplat === 'android' && info.isNP === true, "Capacitor.getPlatform()==='android', AzuraNative.platform='android'");

  // 2) 서비스 워커 등록 안 함
  ok((await page.evaluate(() => window.__swRegister)) === 0, '네이티브에서는 navigator.serviceWorker.register 호출 없음');

  // 3) 라운드 없음 → 포그라운드 워처, 가짜 위치로 거리 표시
  const w1 = await waitFor(async () => { const a = await callsOf('BackgroundGeolocation', 'addWatcher'); return a.length ? a[0] : null; });
  ok(!!w1 && !('backgroundMessage' in w1.options) && !('backgroundTitle' in w1.options), `라운드 없음 → addWatcher에 backgroundMessage 없음(fg) ${w1 ? JSON.stringify(w1.options) : ''}`);
  ok(!!w1 && w1.options.requestPermissions === true && w1.options.stale === false, 'addWatcher 옵션: requestPermissions=true, stale=false');
  ok((await watcherIds()).join() === (w1 ? w1.id : ''), '활성 워처 1개(fg)');
  ok((await text('#gpsText')).startsWith('GPS 대기 중'), '위치 오기 전 GPS 대기 중 표시');
  const hole1 = await page.evaluate(() => ({lat: COURSE_DEFAULT[0][1], lon: COURSE_DEFAULT[0][2], src: window.__azura.state.settings.course.holes[0].center.src}));
  ok(hole1.src === 'default', '1번홀 그린 좌표는 COURSE_DEFAULT 기본값');
  await pushLoc(w1.id, TEE); await sleep(300);
  const d0 = await hav(TEE, hole1);
  ok(near(await num('#distblock .num'), Math.round(d0), 1), `가짜 위치 → 1번홀 그린 중앙까지 ${Math.round(d0)} m 표시 (화면: ${await num('#distblock .num')})`);
  ok(/GPS ±4 m/.test(await text('#gpsText')), 'GPS 정확도 ±4 m 표시');
  ok(await page.evaluate(() => !document.getElementById('distblock').classList.contains('stale')), '위치가 신선함(stale 아님)');

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

  // 7) 라운드 기록 화면 CSV → Filesystem.writeFile → Share.share
  await page.locator('#roundsBody .card').getByRole('button', {name: 'CSV', exact: true}).click(); await sleep(400);
  const wf = await callsOf('Filesystem', 'writeFile'), sh = await callsOf('Share', 'share');
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

  // 11) 오류 없음
  ok(errors.length === 0, `페이지 오류 없음 ${errors.length ? JSON.stringify(errors) : ''}`);
  await browser.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
