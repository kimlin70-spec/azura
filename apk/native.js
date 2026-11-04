/* Azura GPS — 안드로이드 APK 안에서만 쓰는 연결 코드.
   copy-web.js가 www/로 복사하면서 index.html의 app.js 앞에 capacitor.js와 함께 끼워 넣는다.
   GitHub Pages 웹앱에는 이 파일이 없고, 혹시 브라우저에서 로드되더라도 아래 첫 검사에서 바로 끝난다.
   app.js와의 약속: window.AzuraNative = { isNative, geo.start(onFix, onErr, {background}), geo.stop(),
   exportFile(name, text, mime), keepAwake(on) }. onFix/onErr는 브라우저 Geolocation API와 같은 모양을 받는다. */
(function () {
  'use strict';
  const C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform() || typeof C.registerPlugin !== 'function') return;
  const plugin = name => (C.Plugins && C.Plugins[name]) || C.registerPlugin(name);
  const BG = plugin('BackgroundGeolocation');
  const Filesystem = plugin('Filesystem');
  const Share = plugin('Share');
  const App = plugin('App');
  const KeepAwake = plugin('KeepAwake');
  const Notif = plugin('LocalNotifications');
  const say = (msg, action) => { if (typeof window.toast === 'function') window.toast(msg, action); else console.log(msg); };

  /* ---------- GPS ----------
     라운드 중(background: true)에는 알림을 띄우는 포그라운드 서비스로 돌아 화면이 꺼져도 위치가 계속 온다.
     app.js는 startGeo() 때마다 stop() 뒤 start()를 부르므로, 같은 모드면 워처를 유지하고(알림 깜빡임 방지)
     모드가 바뀔 때만 워처를 바꾼다. */
  let cb = {onFix: null, onErr: null};
  let current = null;      // 활성 워처의 id를 돌려주는 Promise
  let currentMode = null;  // 'bg' | 'fg'
  let gen = 0;             // 워처 세대. 오래된 콜백은 무시
  let stopTimer = null;
  let notifAsked = false;

  async function ensureNotificationPermission(){
    if (notifAsked) return; notifAsked = true;
    try { const st = await Notif.checkPermissions(); if (st.display !== 'granted') await Notif.requestPermissions(); } catch (e) { /* 알림 없이도 서비스는 돈다 */ }
  }
  function reallyStop(){
    clearTimeout(stopTimer); stopTimer = null;
    if (!current) return;
    gen++; const p = current; current = null; currentMode = null;
    p.then(id => { if (id) return BG.removeWatcher({id}); }).catch(() => {});
  }
  const geo = {
    start(onFix, onErr, opts) {
      const background = !!(opts && opts.background);
      const mode = background ? 'bg' : 'fg';
      cb = {onFix, onErr};
      if (current && currentMode === mode) { clearTimeout(stopTimer); stopTimer = null; return; }
      reallyStop();
      const myGen = ++gen; currentMode = mode;
      const options = {requestPermissions: true, stale: false, distanceFilter: 0};
      if (background) { options.backgroundTitle = 'Azura GPS'; options.backgroundMessage = '라운드 중이라 GPS를 켜 두고 있습니다'; }
      current = (async () => {
        if (background) await ensureNotificationPermission();
        const id = await BG.addWatcher(options, (loc, err) => {
          if (myGen !== gen) return;
          if (err) {
            const msg = err.message || String(err);
            const servicesOff = /disabled/i.test(msg);                 // 플러그인은 위치(GPS) 꺼짐도 NOT_AUTHORIZED로 보냄
            const denied = err.code === 'NOT_AUTHORIZED' && !servicesOff;
            if (cb.onErr) cb.onErr({code: denied ? 1 : 2, message: msg});
            if (denied) say('위치 권한이 필요합니다', {label: '설정 열기', fn: () => BG.openSettings().catch(() => {})});
            else if (servicesOff) say('휴대폰의 위치(GPS)를 켜 주세요');
            // 권한/위치 꺼짐은 플러그인이 워처를 유지하고 켜지면 스스로 복구한다. 그 외 오류는 워처를 버려 다음 startGeo가 다시 만들게 한다.
            if (err.code !== 'NOT_AUTHORIZED' && myGen === gen) { gen++; current = null; currentMode = null; }
            return;
          }
          if (!loc || cb.onFix == null) return;
          cb.onFix({coords: {latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy == null ? 99 : loc.accuracy}, timestamp: loc.time || Date.now()});
        });
        if (myGen !== gen) { BG.removeWatcher({id}).catch(() => {}); return null; } // 시작 중에 다른 start/stop이 와서 밀려남
        return id;
      })().catch(e => {
        if (cb.onErr) cb.onErr({code: 2, message: (e && e.message) || String(e)});
        if (myGen === gen) { gen++; current = null; currentMode = null; } // 다음 startGeo(화면 복귀, 라운드 시작)에서 재시도
        return null;
      });
    },
    stop() { if (!current) return; clearTimeout(stopTimer); stopTimer = setTimeout(reallyStop, 50); }
  };

  /* ---------- 내보내기: 캐시 폴더에 쓰고 안드로이드 공유창 ---------- */
  async function exportFile(name, text, mime){
    const res = await Filesystem.writeFile({path: name, data: text, directory: 'CACHE', encoding: 'utf8'});
    try { await Share.share({title: name, dialogTitle: '내보내기', files: [res.uri]}); }
    catch (e) { if (e && /cancel/i.test(e.message || '')) return; throw e; } // 공유창을 그냥 닫은 것은 실패가 아님
  }

  /* ---------- 화면 켜두기 ---------- */
  function keepAwake(on){ return (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(() => {}); }

  /* ---------- 안드로이드 뒤로 가기: 창 닫기 → 플레이 화면 → 앱 숨기기(종료 아님, GPS 서비스 유지) ---------- */
  App.addListener('backButton', () => {
    const modal = document.getElementById('modal');
    if (modal && modal.classList.contains('show')) { modal.click(); return; }
    const active = document.querySelector('.screen.active');
    if (active && active.id !== 's-play' && typeof window.nav === 'function') { window.nav('play'); return; }
    App.minimizeApp().catch(() => {});
  });

  window.AzuraNative = {isNative: true, platform: C.getPlatform(), geo, exportFile, keepAwake};
})();
