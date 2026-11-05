/* Azura GPS — 안드로이드 APK와 아이폰 앱(IPA) 안에서만 쓰는 연결 코드. 두 플랫폼이 같은 파일을 쓴다.
   copy-web.js가 www/로 복사하면서 index.html의 app.js 앞에 capacitor.js와 함께 끼워 넣는다.
   GitHub Pages 웹앱에는 이 파일이 없고, 혹시 브라우저에서 로드되더라도 아래 첫 검사에서 바로 끝난다.
   app.js와의 약속: window.AzuraNative = { isNative, platform('android'|'ios'), geo.start(onFix, onErr, {background}), geo.stop(),
   exportFile(name, text, mime), keepAwake(on) }. onFix/onErr는 브라우저 Geolocation API와 같은 모양을 받는다.
   플랫폼 차이
   - 안드로이드: 라운드 중 위치는 알림이 붙은 포그라운드 서비스로 돈다 → 알림 권한을 먼저 묻는다. 뒤로 가기 버튼을 처리한다.
   - iOS: backgroundMessage만 주면 화면이 꺼져도 위치가 온다(상단에 위치 사용 표시). 알림 권한이 필요 없고 뒤로 가기 버튼도 없다.
   - 공통: 저장소 미러(아래), CI 시뮬레이터 점검용 콘솔 표식 두 개
     'AzuraNative ready <platform>'(초기화 끝에 한 번), 'AzuraNative first fix ±N m'(첫 위치에서 한 번). */
(function () {
  'use strict';
  const C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform() || typeof C.registerPlugin !== 'function') return;
  const platform = C.getPlatform();   // 'android' | 'ios'
  const isAndroid = platform === 'android';
  const plugin = name => (C.Plugins && C.Plugins[name]) || C.registerPlugin(name);
  const BG = plugin('BackgroundGeolocation');
  const Filesystem = plugin('Filesystem');
  const Share = plugin('Share');
  const App = plugin('App');
  const KeepAwake = plugin('KeepAwake');
  const Notif = isAndroid ? plugin('LocalNotifications') : null;
  const say = (msg, action) => { if (typeof window.toast === 'function') window.toast(msg, action); else console.log(msg); };
  const errText = e => (e && e.message) || String(e);

  /* ---------- 저장소 미러: localStorage 'azura.gps.v1' → 파일 DATA/azura-state.json ----------
     iOS WKWebView의 localStorage는 저장공간이 부족하면 OS가 지울 수 있다. 그래서 app.js가 이 키에 쓰는 값을
     앱 데이터 폴더(iOS는 Documents, 안드로이드는 내부 저장소)의 파일에도 남기고, 시작할 때 localStorage가 비어 있으면
     파일에서 되살린다. app.js는 그대로 두고 Storage.prototype.setItem을 감싼다
     (localStorage.setItem = ... 처럼 직접 대입하면 'setItem'이라는 저장 항목이 생길 뿐이라 쓰지 않는다).
     - 시작 때 localStorage에 값이 있다 → 복원하지 않고 미러 쓰기를 바로 허용한다.
     - 비어 있다 → 파일을 읽는다. 올바른 상태(객체이고 settings가 있음)면 원래 setItem으로 localStorage에 넣고 한 번만 다시 읽는다.
       판정이 끝날 때까지 미러는 쓰지 않는다. 그 사이 app.js가 기본 상태를 저장해 좋은 미러를 덮으면 기록이 사라진다.
       판정 중에 들어온 값은 들고 있다가, 복원하지 않기로 정해지면 마지막 값만 쓴다. 파일이 없거나 못 읽으면 그대로 진행한다.
     - 쓰기는 0.8초 모아서 한 번, 앱이 뒤로 갈 때(App pause, 화면 숨김)는 바로. 같은 값은 다시 쓰지 않는다.
       쓰기 실패는 console.warn 한 줄만 남긴다(값은 들고 있다가 다음 저장이나 앱 전환 때 다시 쓴다).
     안드로이드는 localStorage가 지워지지 않지만, 같은 동작이 해가 없어 함께 쓴다. */
  const KEY = 'azura.gps.v1';
  const MIRROR = {path: 'azura-state.json', directory: 'DATA', encoding: 'utf8'};
  const RESTORED = 'azura.mirror.restored';   // sessionStorage 표시: 이번 세션에서 이미 복원하고 다시 읽었음(무한 리로드 방지)
  let phase = 'off';        // 'deciding' 복원 판정 중 | 'ready' 미러 씀 | 'restoring' 복원 리로드 직전 | 'blocked' 복원 실패 | 'off'
  let pending = null;       // 아직 파일에 쓰지 않은 최신 값
  let lastWritten = null;   // 파일에 마지막으로 쓴 값
  let timer = null;
  let writing = Promise.resolve();   // 파일 쓰기는 하나씩 순서대로
  const session = (k, v) => {   // sessionStorage 읽기/쓰기/지우기. 막혀 있으면 조용히 null
    try { const s = window.sessionStorage; if (v === undefined) return s.getItem(k); if (v === null) s.removeItem(k); else s.setItem(k, v); }
    catch (e) { /* 표시 없이 진행 */ }
    return null;
  };
  function flushMirror(){
    clearTimeout(timer); timer = null;
    if (phase !== 'ready' || pending == null) return;
    const v = pending; pending = null;
    writing = writing.then(() => {
      if (v === lastWritten) return;
      return Filesystem.writeFile(Object.assign({data: v}, MIRROR)).then(() => { lastWritten = v; });
    }).catch(e => {
      if (pending == null) pending = v;
      console.warn('AzuraNative: 저장 미러 쓰기 실패: ' + errText(e));
    });
  }
  function queueMirror(v){
    pending = v;
    if (phase === 'ready') { clearTimeout(timer); timer = setTimeout(flushMirror, 800); }
  }
  function restoreFailed(why){
    // 이번 실행에서는 이 키를 저장하지 않는다. 그래야 좋은 미러가 덮이지 않고, 다음 실행이 다시 복원을 시도한다.
    phase = 'blocked'; pending = null; clearTimeout(timer);
    console.warn('AzuraNative: 저장 미러 복원 실패: ' + why);
    const tell = () => say('이전 기록을 되살리지 못했습니다. 저장공간을 비운 뒤 앱을 다시 여세요');
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tell, {once: true}); else tell();
  }
  let store = null;
  try { store = window.localStorage; } catch (e) { /* 저장소가 없으면 미러도 없다 */ }
  if (store && typeof Storage === 'function' && typeof Storage.prototype.setItem === 'function') {
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this !== store || String(key) !== KEY) return realSetItem.apply(this, arguments);
      if (phase === 'restoring' || phase === 'blocked') return;   // 되살린 값(또는 다음 실행의 복원 기회)을 기본 상태가 덮지 않게
      realSetItem.apply(this, arguments);                          // 용량 초과 같은 예외는 그대로 app.js로 간다. 미러도 그대로
      if (phase !== 'off') queueMirror(String(value));
    };
    let saved = null, readable = true;
    try { saved = store.getItem(KEY); } catch (e) { readable = false; }
    if (!readable) phase = 'off';
    else if (saved) { phase = 'ready'; session(RESTORED, null); }
    else if (session(RESTORED)) restoreFailed('되살린 값이 다시 읽은 뒤에 없습니다');
    else {
      phase = 'deciding';
      Filesystem.readFile(Object.assign({}, MIRROR)).then(res => {
        const text = res && typeof res.data === 'string' ? res.data : '';
        let s = null;
        try { s = JSON.parse(text); } catch (e) { /* 깨진 파일은 없는 것과 같다 */ }
        if (!s || typeof s !== 'object' || Array.isArray(s) || !s.settings || typeof s.settings !== 'object') return false;
        phase = 'restoring'; pending = null; clearTimeout(timer);
        try { realSetItem.call(store, KEY, text); } catch (e) { restoreFailed(errText(e)); return true; }
        session(RESTORED, '1');
        // 다시 읽으면 브리지는 콜백을 버리지만 플러그인의 위치 워처는 계속 돈다(배터리, 안드로이드 알림).
        // 판정 중에는 워처를 만들지 않지만, 2초 안전 시간이 지나 이미 켠 워처가 있으면 먼저 지우고 다시 읽는다(최대 1초 대기).
        Promise.race([reallyStop(), new Promise(r => setTimeout(r, 1000))]).then(() => location.reload());
        return true;
      }).catch(() => false).then(done => {
        if (!done) {
          phase = 'ready';
          if (pending != null) queueMirror(pending);   // 판정 중 들어온 값 가운데 마지막 것만 쓴다
        }
        if (phase !== 'restoring') releaseGeo();       // 복원하지 않으면 미뤄 둔 위치 시작을 지금 한다
      });
      setTimeout(() => { if (phase === 'deciding') releaseGeo(); }, 2000);   // 파일 읽기가 늦어도 GPS는 2초 뒤 시작
    }
    App.addListener('pause', () => flushMirror());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushMirror(); });
  }

  /* ---------- GPS ----------
     라운드 중(background: true)에는 화면이 꺼져도 위치가 계속 오게 backgroundMessage를 준다
     (안드로이드는 그 문구로 알림이 붙은 포그라운드 서비스, iOS는 백그라운드 위치 업데이트).
     app.js는 startGeo() 때마다 stop() 뒤 start()를 부르므로, 같은 모드면 워처를 유지하고(알림 깜빡임 방지)
     모드가 바뀔 때만 워처를 바꾼다. */
  let cb = {onFix: null, onErr: null};
  let current = null;      // 활성 워처의 id를 돌려주는 Promise
  let currentMode = null;  // 'bg' | 'fg'
  let gen = 0;             // 워처 세대. 오래된 콜백은 무시
  let stopTimer = null;
  let notifAsked = false;
  let firstFix = false;
  let geoHeld = null;        // 저장소 복원 판정 중에 들어온 위치 시작 요청(마지막 것만). 판정 전에 워처를 만들면
  let geoReleased = false;   // 복원 리로드 뒤에도 네이티브 워처가 남을 수 있어서 판정이 끝날 때까지 미룬다
  function releaseGeo(){
    if (geoReleased) return; geoReleased = true;
    const h = geoHeld; geoHeld = null;
    if (h && phase !== 'restoring') geo.start(h[0], h[1], h[2]);
  }

  async function ensureNotificationPermission(){   // 안드로이드 전용: 포그라운드 서비스 알림 (iOS는 필요 없고 권한 창만 뜬다)
    if (!Notif || notifAsked) return; notifAsked = true;
    try { const st = await Notif.checkPermissions(); if (st.display !== 'granted') await Notif.requestPermissions(); } catch (e) { /* 알림 없이도 서비스는 돈다 */ }
  }
  function reallyStop(){   // 워처를 지금 멈춘다. removeWatcher가 끝나면 풀리는 Promise
    clearTimeout(stopTimer); stopTimer = null;
    if (!current) return Promise.resolve();
    gen++; const p = current; current = null; currentMode = null;
    return p.then(id => { if (id) return BG.removeWatcher({id}); }).catch(() => {});
  }
  const geo = {
    start(onFix, onErr, opts) {
      const background = !!(opts && opts.background);
      const mode = background ? 'bg' : 'fg';
      cb = {onFix, onErr};
      if (phase === 'restoring') return;   // 저장소 미러를 되살려 곧 다시 읽는다. 새 워처를 만들면 다시 읽은 뒤에도 남는다
      if (phase === 'deciding' && !geoReleased) { geoHeld = [onFix, onErr, opts]; return; }   // 복원 판정이 끝나면 releaseGeo가 시작
      if (current && currentMode === mode) { clearTimeout(stopTimer); stopTimer = null; return; }
      reallyStop();
      const myGen = ++gen; currentMode = mode;
      const options = {requestPermissions: true, stale: false, distanceFilter: 0};
      if (background) { options.backgroundTitle = 'Azura GPS'; options.backgroundMessage = '라운드 중이라 GPS를 켜 두고 있습니다'; }
      current = (async () => {
        if (background && isAndroid) await ensureNotificationPermission();
        const id = await BG.addWatcher(options, (loc, err) => {
          if (myGen !== gen) return;
          if (err) {
            const msg = errText(err);
            const servicesOff = /disabled/i.test(msg);                 // 안드로이드 플러그인은 위치(GPS) 꺼짐도 NOT_AUTHORIZED로 보냄
            const denied = err.code === 'NOT_AUTHORIZED' && !servicesOff;
            if (cb.onErr) cb.onErr({code: denied ? 1 : 2, message: msg});
            if (denied) say('위치 권한이 필요합니다', {label: '설정 열기', fn: () => BG.openSettings().catch(() => {})});
            else if (servicesOff) say('휴대폰의 위치(GPS)를 켜 주세요');
            // 권한/위치 꺼짐은 두 플랫폼 모두 플러그인이 워처를 유지하고, 켜지면 스스로 복구한다.
            // 안드로이드의 그 밖의 오류("Service not running.")는 워처가 만들어지지 않은 것이라 버리고 다음 startGeo가 다시 만든다.
            // iOS의 그 밖의 오류(일시적인 위치 실패)는 워처가 살아 있어 다음 위치가 그대로 오므로 버리지 않는다.
            if (err.code !== 'NOT_AUTHORIZED' && isAndroid && myGen === gen) { gen++; current = null; currentMode = null; }
            return;
          }
          if (!loc || cb.onFix == null) return;
          const acc = loc.accuracy == null ? 99 : loc.accuracy;
          if (!firstFix) { firstFix = true; console.log('AzuraNative first fix ±' + Math.round(acc) + ' m'); }
          cb.onFix({coords: {latitude: loc.latitude, longitude: loc.longitude, accuracy: acc}, timestamp: loc.time || Date.now()});
        });
        if (myGen !== gen) { BG.removeWatcher({id}).catch(() => {}); return null; } // 시작 중에 다른 start/stop이 와서 밀려남
        return id;
      })().catch(e => {
        if (cb.onErr) cb.onErr({code: 2, message: errText(e)});
        if (myGen === gen) { gen++; current = null; currentMode = null; } // 다음 startGeo(화면 복귀, 라운드 시작)에서 재시도
        return null;
      });
    },
    stop() { geoHeld = null; if (!current) return; clearTimeout(stopTimer); stopTimer = setTimeout(reallyStop, 50); }
  };

  /* ---------- 내보내기: 캐시 폴더에 쓰고 공유창(안드로이드 공유 시트, iOS 공유 시트) ---------- */
  async function exportFile(name, text, mime){
    const res = await Filesystem.writeFile({path: name, data: text, directory: 'CACHE', encoding: 'utf8'});
    try { await Share.share({title: name, dialogTitle: '내보내기', files: [res.uri]}); }
    catch (e) { if (e && /cancel/i.test(e.message || '')) return; throw e; } // 공유창을 그냥 닫은 것은 실패가 아님
  }

  /* ---------- 화면 켜두기 ---------- */
  function keepAwake(on){ return (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(() => {}); }

  /* ---------- 안드로이드 뒤로 가기: 창 닫기 → 플레이 화면 → 앱 숨기기(종료 아님, GPS 서비스 유지). iOS에는 이 버튼이 없다 ---------- */
  if (isAndroid) App.addListener('backButton', () => {
    const modal = document.getElementById('modal');
    if (modal && modal.classList.contains('show')) { modal.click(); return; }
    const active = document.querySelector('.screen.active');
    if (active && active.id !== 's-play' && typeof window.nav === 'function') { window.nav('play'); return; }
    App.minimizeApp().catch(() => {});
  });

  window.AzuraNative = {isNative: true, platform, geo, exportFile, keepAwake};
  console.log('AzuraNative ready ' + platform);
})();
