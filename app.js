'use strict';
/* Azura Golf GPS — 개인용 거리·샷 기록 앱. 외부 라이브러리 없음. */
const STORE_KEY = 'azura.gps.v1';
const CLUBS_DEFAULT = ['드라이버','5번 우드','4번 유틸','5번 유틸(D)','5번 아이언','7번 아이언','8번 아이언','9번 아이언','43도','45도(D)','49도','56도','퍼터'];
const YD = 1.0936133;
const $ = s => document.querySelector(s);

/* ---------- 상태 ---------- */
function defaultState(){
  return {
    schema: 1,
    settings: {
      units: 'm', keepAwake: false, clubs: CLUBS_DEFAULT.slice(), testPos: null,
      course: { name: 'Azura Golf Resort', holes: Array.from({length: 18}, (_, i) => ({no: i + 1, par: null, center: null, front: null, back: null})) }
    },
    rounds: [], activeRoundId: null, ui: {hole: 1}
  };
}
let state = load();
function load(){
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw); const d = defaultState();
    s.settings = Object.assign(d.settings, s.settings || {});
    if (!s.settings.course || !Array.isArray(s.settings.course.holes) || s.settings.course.holes.length !== 18) s.settings.course = d.settings.course;
    if (!Array.isArray(s.settings.clubs) || !s.settings.clubs.length) s.settings.clubs = CLUBS_DEFAULT.slice();
    s.rounds = Array.isArray(s.rounds) ? s.rounds : [];
    s.ui = Object.assign(d.ui, s.ui || {});
    for (const r of s.rounds) for (const ev of (r.events || [])) if (ev.pending) { ev.pending = false; if (ev.lat == null) ev.noPos = true; }
    return s;
  } catch (e) { console.error(e); return defaultState(); }
}
function save(){ try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { console.error(e); toast('저장 실패: 저장공간을 확인하세요'); } }
function uid(){ return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10)); }
function pad(n){ return String(n).padStart(2, '0'); }
function fmtDate(d){ return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtTime(d){ return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function today(){ return fmtDate(new Date()); }
function median(a){ const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/* ---------- 거리 ---------- */
function distM(a, b){
  const R = 6371008.8, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function unitLabel(){ return state.settings.units === 'yd' ? 'yd' : 'm'; }
function fmtNum(m){ return state.settings.units === 'yd' ? Math.round(m * YD) : Math.round(m); }
function fmtDist(m){ if (m == null || !isFinite(m)) return '—'; return `${fmtNum(m)} ${unitLabel()}`; }

/* ---------- GPS ---------- */
let watchId = null, lastFix = null, geoError = null, testTimer = null;
function startGeo(){
  stopGeo();
  const tp = state.settings.testPos;
  if (tp) {
    const push = () => onFix({coords: {latitude: tp.lat, longitude: tp.lon, accuracy: 3}, timestamp: Date.now()});
    push(); testTimer = setInterval(push, 1000); return;
  }
  if (!navigator.geolocation) { geoError = '이 브라우저는 위치를 지원하지 않습니다'; renderGps(); return; }
  watchId = navigator.geolocation.watchPosition(onFix, onGeoErr, {enableHighAccuracy: true, maximumAge: 0, timeout: 30000});
}
function stopGeo(){
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (testTimer) { clearInterval(testTimer); testTimer = null; }
}
function onFix(p){
  geoError = null;
  const t = Math.min(p.timestamp || Date.now(), Date.now());
  lastFix = {lat: p.coords.latitude, lon: p.coords.longitude, acc: (p.coords.accuracy == null ? 99 : p.coords.accuracy), t};
  if (capture) considerFix(lastFix);
  renderGps();
}
function onGeoErr(e){
  geoError = e.code === 1 ? '위치 권한이 거부됨. 브라우저 설정에서 위치를 허용하세요' : e.code === 2 ? 'GPS 신호 없음' : 'GPS 응답 지연';
  renderGps();
}
function fixAge(){ return lastFix ? Math.max(0, Date.now() - lastFix.t) : Infinity; }
function freshFix(maxAge){ return (lastFix && fixAge() <= (maxAge || 6000)) ? lastFix : null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { startGeo(); requestWake(); } });

let wakeLock = null;
async function requestWake(){
  if (!state.settings.keepAwake || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 무시 */ }
}
function releaseWake(){ if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
function vibrate(p){ try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* 무시 */ } }

/* ---------- 위치 캡처: 탭 즉시 기록, 몇 초간 가장 좋은 위치값을 붙임 ---------- */
let capture = null;
function startCapture(ev){
  finalizeCapture();
  capture = {id: ev.id, t0: Date.now(), best: null, timer: setTimeout(() => finalizeCapture(true), 6000)};
  if (lastFix && Date.now() - lastFix.t < 5000) considerFix(lastFix);
  renderPlay();
}
function considerFix(f){
  if (!capture) return;
  if (f.t < capture.t0 - 3000) return;
  if (!capture.best || f.acc < capture.best.acc) { capture.best = {lat: f.lat, lon: f.lon, acc: f.acc, t: f.t}; applyBest(); }
  if (capture.best && capture.best.acc <= 5) finalizeCapture();
}
function findEvent(id){ const r = activeRound(); return r ? r.events.find(e => e.id === id) : null; }
function applyBest(){
  const ev = findEvent(capture.id); if (!ev) return;
  ev.lat = capture.best.lat; ev.lon = capture.best.lon; ev.acc = Math.round(capture.best.acc * 10) / 10; ev.fixT = new Date(capture.best.t).toISOString();
  ev.fixAge = Math.max(0, Math.round((capture.t0 - capture.best.t) / 100) / 10); // 탭 시점 기준 위치값의 나이(초)
  const c = holeCenter(ev.hole); ev.dtg = c ? Math.round(distM(ev, c) * 10) / 10 : null;
  delete ev.noPos; save();
}
function finalizeCapture(timedOut){
  if (!capture) return;
  clearTimeout(capture.timer);
  // 6초 동안 새 수신이 없으면 30초 이내의 마지막 값이라도 붙인다 (나이는 fixAge에 남음)
  if (timedOut && !capture.best && lastFix && Date.now() - lastFix.t < 30000) { capture.best = {lat: lastFix.lat, lon: lastFix.lon, acc: lastFix.acc, t: lastFix.t}; applyBest(); }
  const ev = findEvent(capture.id); capture = null;
  if (ev) { ev.pending = false; if (ev.lat == null) ev.noPos = true; save(); vibrate(ev.lat != null ? [40] : [30, 60, 30]); }
  renderPlay();
}

/* ---------- 라운드/홀 ---------- */
function activeRound(){ return state.rounds.find(r => r.id === state.activeRoundId) || null; }
function ensureRound(){
  let r = activeRound(); if (r) return r;
  r = {id: uid(), startedAt: new Date().toISOString(), endedAt: null, startHole: state.ui.hole, events: []};
  state.rounds.push(r); state.activeRoundId = r.id; save(); toast('새 라운드 시작'); return r;
}
function hole(no){ return state.settings.course.holes[no - 1]; }
function holeCenter(no){ const h = hole(no); return h && h.center ? h.center : null; }
function isPutter(c){ return !!c && /퍼터|putter|^pt$/i.test(c); }
function isStroke(ev){ return ev.type === 'shot' || ev.type === 'missed' || ev.type === 'penalty'; }
function holeStats(round){
  const m = {}; for (let h = 1; h <= 18; h++) m[h] = {strokes: 0, putts: 0, done: false, events: []};
  for (const ev of round.events) { const s = m[ev.hole]; if (!s) continue; s.events.push(ev); if (isStroke(ev)) s.strokes++; if (ev.type === 'shot' && isPutter(ev.club)) s.putts++; if (ev.type === 'holeout') s.done = true; }
  return m;
}
function roundTotals(round){
  const st = holeStats(round); let strokes = 0, par = 0, vs = null, done = 0, played = 0, putts = 0;
  for (let h = 1; h <= 18; h++) {
    const s = st[h]; if (s.strokes > 0 || s.done) played++; strokes += s.strokes; putts += s.putts;
    if (s.done) { done++; const p = hole(h).par; if (p != null) { par += p; vs = (vs || 0) + (s.strokes - p); } }
  }
  return {strokes, par, vs, done, played, putts, st};
}
/* 샷 거리 = 같은 홀의 다음 위치 이벤트까지. 사이에 벌타/빠진 샷이 있으면 없음. 퍼터는 계산 안 함. */
function shotDistance(round, ev){
  const none = {dist: null, endDtg: null, note: ''};
  if (ev.type !== 'shot' || ev.lat == null) return none;
  if (isPutter(ev.club)) return {dist: null, endDtg: null, note: '퍼트'};
  const evs = round.events; const i = evs.indexOf(ev);
  for (let j = i + 1; j < evs.length; j++) {
    const n = evs[j]; if (n.hole !== ev.hole) continue;
    if (n.type === 'penalty') return {dist: null, endDtg: null, note: '다음 벌타'};
    if (n.type === 'missed') return {dist: null, endDtg: null, note: '다음 샷 위치 없음'};
    if (n.type === 'shot' || n.type === 'holeout') {
      if (n.lat == null) return {dist: null, endDtg: null, note: '다음 위치 없음'};
      const c = holeCenter(ev.hole); return {dist: distM(ev, n), endDtg: c ? distM(n, c) : null, note: ''};
    }
  }
  return none;
}
function evLabel(ev){ return ev.type === 'shot' ? `${ev.hole}번홀 ${ev.club}` : ev.type === 'penalty' ? `${ev.hole}번홀 벌타` : ev.type === 'missed' ? `${ev.hole}번홀 빠진 샷` : `${ev.hole}번홀 홀아웃`; }

/* ---------- 동작 ---------- */
let lastTap = null, redo = null;
function tapClub(club){
  const now = Date.now();
  if (lastTap && lastTap.club === club && now - lastTap.t < 700) return; // 더블탭 방지
  lastTap = {club, t: now};
  const round = ensureRound(); const h = state.ui.hole;
  const prev = round.events.slice().reverse().find(e => e.hole === h);
  const c = holeCenter(h); const f = freshFix(10000);
  if (prev && prev.type === 'shot' && isPutter(prev.club) && !isPutter(club) && f && c && distM(f, c) > 100) {
    const nh = h % 18 + 1;
    ask({title: '홀아웃을 안 누른 것 같습니다',
         body: `${h}번홀 마지막 기록이 퍼터인데, 지금 위치는 ${h}번홀 그린에서 ${fmtDist(distM(f, c))} 떨어져 있습니다.`,
         buttons: [{label: `${h}번홀 홀아웃하고 ${nh}번홀에 기록`, value: 'ho', kind: 'primary'}, {label: `그래도 ${h}번홀에 기록`, value: 'same'}, {label: '취소', value: null}]})
      .then(v => { if (v === 'ho') { holeOut({force: true, noPosition: true, silent: true}); recordShot(club); } else if (v === 'same') recordShot(club); });
    return;
  }
  recordShot(club);
}
function recordShot(club){
  const round = ensureRound();
  const ev = {id: uid(), t: new Date().toISOString(), hole: state.ui.hole, type: 'shot', club, lat: null, lon: null, acc: null, fixT: null, dtg: null, pending: true};
  round.events.push(ev); redo = null; save(); vibrate(15); flashClub(club); startCapture(ev);
}
function addPenalty(){
  const round = ensureRound();
  round.events.push({id: uid(), t: new Date().toISOString(), hole: state.ui.hole, type: 'penalty'});
  redo = null; save(); vibrate(15); renderPlay(); toast('벌타 +1');
}
function addMissed(){
  pickClub({title: '빠진 샷 추가', body: '치기 전에 누르는 걸 잊은 샷을 위치 없이 1타로 넣습니다.\n지금 칠 샷의 클럽을 누르기 전에 추가하세요.'}).then(club => {
    if (club === null) return;
    const round = ensureRound();
    round.events.push({id: uid(), t: new Date().toISOString(), hole: state.ui.hole, type: 'missed', club: club || null, noPos: true});
    redo = null; save(); renderPlay(); toast('빠진 샷 +1');
  });
}
function holeOut(opts){
  opts = opts || {};
  const round = activeRound(); if (!round) { toast('진행 중인 라운드가 없습니다'); return; }
  const h = state.ui.hole; const n = holeStats(round)[h].strokes;
  if (n === 0 && !opts.force) {
    ask({title: `${h}번홀 타수가 0입니다`, body: '그래도 홀아웃 처리할까요?', buttons: [{label: '홀아웃', value: true, kind: 'primary'}, {label: '취소', value: null}]}).then(v => { if (v) holeOut({force: true}); });
    return;
  }
  const ev = {id: uid(), t: new Date().toISOString(), hole: h, type: 'holeout', lat: null, lon: null, acc: null, fixT: null, dtg: null, pending: !opts.noPosition};
  if (opts.noPosition) ev.noPos = true;
  round.events.push(ev); redo = null; state.ui.hole = h % 18 + 1; save();
  if (!opts.noPosition) startCapture(ev);
  renderPlay();
  if (!opts.silent) {
    toast(`${h}번홀 ${n}타 홀아웃`);
    if (roundTotals(round).done >= 18) setTimeout(() => toast('18홀 완료. 메뉴에서 라운드를 종료하세요'), 2600);
  }
}
function undo(){
  const round = activeRound(); if (!round || !round.events.length) { toast('되돌릴 기록이 없습니다'); return; }
  const ev = round.events.pop();
  if (capture && capture.id === ev.id) { clearTimeout(capture.timer); capture = null; }
  if (ev.type === 'holeout') state.ui.hole = ev.hole;
  redo = ev; save(); renderPlay();
  toast(`되돌림: ${evLabel(ev)}`, {label: '복구', fn: () => {
    if (!redo) return; const r = activeRound(); if (!r) return;
    r.events.push(redo); if (redo.type === 'holeout') state.ui.hole = redo.hole % 18 + 1; redo = null; save(); renderPlay();
  }});
}
function replaceGreen(){
  const h = state.ui.hole; const f = freshFix(6000);
  if (!f) { toast('GPS 위치가 아직 없습니다'); return; }
  if (f.acc > 10) { toast(`GPS 정확도 ±${Math.round(f.acc)} m. 더 좋아질 때까지 기다리세요`); return; }
  const c = holeCenter(h); const d = c ? distM(f, c) : null;
  let body = `그린 중앙에 서 있을 때만 하세요.\n현재 표시 거리: ${c ? fmtDist(d) : '좌표 없음'}\nGPS 정확도: ±${Math.round(f.acc)} m`;
  if (c && d <= f.acc) body += '\n\n표시 거리가 GPS 정확도 안이라 지금 좌표도 충분히 맞습니다.';
  ask({title: `${h}번홀 그린 중앙 교체`, body, buttons: [{label: c ? '현재 위치로 교체' : '현재 위치로 설정', value: true, kind: 'primary'}, {label: '취소', value: null}]}).then(v => {
    if (!v) return;
    hole(h).center = {lat: f.lat, lon: f.lon, src: 'gps', t: new Date().toISOString(), prev: c ? {lat: c.lat, lon: c.lon} : null};
    save(); renderPlay(); toast(`${h}번홀 그린 중앙을 ${c ? '교체' : '설정'}했습니다`);
  });
}
function endRound(){
  const r = activeRound(); if (!r) { toast('진행 중인 라운드가 없습니다'); return; }
  const t = roundTotals(r);
  ask({title: '라운드 종료', body: `${t.played}홀 기록, ${t.strokes}타.\n종료 후에도 라운드 기록에서 CSV를 내보낼 수 있습니다.`,
       buttons: [{label: '종료하고 CSV 내보내기', value: 'export', kind: 'primary'}, {label: '종료만', value: 'end'}, {label: '취소', value: null}]}).then(v => {
    if (!v) return;
    finalizeCapture(); r.endedAt = new Date().toISOString(); state.activeRoundId = null; save(); nav('rounds');
    if (v === 'export') exportRoundCsv(r);
  });
}
function deleteRound(r){
  ask({title: '라운드 삭제', body: `${fmtDate(new Date(r.startedAt))} 라운드를 삭제합니다. 되돌릴 수 없습니다.`, buttons: [{label: '삭제', value: true, kind: 'danger'}, {label: '취소', value: null}]}).then(v => {
    if (!v) return;
    if (state.activeRoundId === r.id) { finalizeCapture(); state.activeRoundId = null; }
    state.rounds = state.rounds.filter(x => x.id !== r.id); save(); renderRounds();
  });
}

/* ---------- 모달/토스트 ---------- */
function ask(o){
  return new Promise(res => {
    const m = $('#modal'); m.innerHTML = '';
    const sh = document.createElement('div'); sh.className = 'sheet';
    const close = () => { m.classList.remove('show'); m.innerHTML = ''; m.onclick = null; };
    const done = v => { close(); res(v); };
    if (o.title) { const h = document.createElement('h3'); h.textContent = o.title; sh.appendChild(h); }
    if (o.body) { const p = document.createElement('p'); p.textContent = o.body; sh.appendChild(p); }
    if (o.content) sh.appendChild(o.content(done));
    const bs = document.createElement('div'); bs.className = 'btns';
    (o.buttons || []).forEach(b => { const bt = document.createElement('button'); bt.textContent = b.label; if (b.kind) bt.className = b.kind; bt.onclick = () => done(b.value); bs.appendChild(bt); });
    sh.appendChild(bs); m.appendChild(sh); m.classList.add('show');
    m.onclick = e => { if (e.target === m) done(null); };
  });
}
function pickHole(){
  ask({title: '홀 선택', content: done => {
    const g = document.createElement('div'); g.className = 'grid18';
    for (let i = 1; i <= 18; i++) { const b = document.createElement('button'); b.textContent = i; if (i === state.ui.hole) b.classList.add('cur'); b.onclick = () => done(i); g.appendChild(b); }
    return g;
  }, buttons: [{label: '닫기', value: null}]}).then(v => { if (v) { state.ui.hole = v; save(); renderPlay(); } });
}
/* 취소 → null, 클럽 모름 → '' */
function pickClub(o){
  return ask({title: o.title, body: o.body, content: done => {
    const g = document.createElement('div'); g.className = 'clubpick';
    state.settings.clubs.forEach(c => { const b = document.createElement('button'); b.textContent = c; b.onclick = () => done(c); g.appendChild(b); });
    return g;
  }, buttons: [{label: '클럽 모름', value: ''}, {label: '취소', value: null}]});
}
let toastTimer = null;
function toast(msg, action){
  const t = $('#toast'); t.innerHTML = '';
  const s = document.createElement('span'); s.textContent = msg; t.appendChild(s);
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { action.fn(); hideToast(); }; t.appendChild(b); }
  t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, action ? 5000 : 2500);
}
function hideToast(){ $('#toast').classList.remove('show'); }

/* ---------- 좌표 파서: 십진수, 도분초, 도분, 반구 문자, KML(경도,위도,고도) ---------- */
function parseCoord(input, box){
  if (input == null) return {error: '빈 값'};
  const s = String(input).trim().replace(/[’′`´]/g, "'").replace(/[”″]/g, '"').replace(/[，、]/g, ',');
  if (!s) return {error: '빈 값'};
  const re = /([NSEWnsew])(?![A-Za-z])|(-?\d+(?:\.\d+)?)/g;
  const nums = [], hemi = []; let m;
  while ((m = re.exec(s))) {
    if (m[1]) hemi.push({c: m[1].toUpperCase(), i: m.index});
    else nums.push({v: parseFloat(m[2]), neg: m[2].startsWith('-'), i: m.index, len: m[2].length});
  }
  let note = '';
  if (nums.length === 3 && hemi.length === 0 && /,/.test(s)) { // KML: 경도,위도,고도
    const lon = nums[0], lat = nums[1]; nums.length = 0; nums.push(lat, lon); note = 'KML 순서(경도,위도)로 보고 바꿨습니다';
  }
  if (![2, 4, 6].includes(nums.length)) return {error: `숫자 ${nums.length}개 인식. "위도, 경도" 형식으로 넣으세요`};
  const half = nums.length / 2; const g1 = nums.slice(0, half), g2 = nums.slice(half);
  const toDeg = g => {
    const sign = g[0].neg ? -1 : 1; let d = Math.abs(g[0].v);
    if (g[1]) { if (g[1].v >= 60) return NaN; d += Math.abs(g[1].v) / 60; }
    if (g[2]) { if (g[2].v >= 60) return NaN; d += Math.abs(g[2].v) / 3600; }
    return sign * d;
  };
  let a = toDeg(g1), b = toDeg(g2);
  if (isNaN(a) || isNaN(b)) return {error: '분·초는 60 미만이어야 합니다'};
  const g1end = g1[g1.length - 1].i + g1[g1.length - 1].len, g2start = g2[0].i;
  const L1 = [], L2 = [];
  for (const h of hemi) {
    if (h.i < g1[0].i) L1.push(h.c);
    else if (h.i >= g1end && h.i < g2start) { const d1 = h.i - g1end, d2 = g2start - h.i - 1; (d1 <= d2 ? L1 : L2).push(h.c); }
    else L2.push(h.c);
  }
  const apply = (v, letters) => {
    const l = letters.find(c => 'NSEW'.includes(c)); if (!l) return {v, kind: null};
    return {v: Math.abs(v) * ((l === 'S' || l === 'W') ? -1 : 1), kind: (l === 'N' || l === 'S') ? 'lat' : 'lon'};
  };
  const A = apply(a, L1), B = apply(b, L2);
  let lat, lon;
  if (A.kind === 'lon' || B.kind === 'lat') { lat = B.v; lon = A.v; } else { lat = A.v; lon = B.v; }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return {error: '범위를 벗어난 값'};
  if (box) {
    const inBox = (la, lo) => la >= box.latMin && la <= box.latMax && lo >= box.lonMin && lo <= box.lonMax;
    if (!inBox(lat, lon)) {
      if (inBox(lon, lat)) { const t = lat; lat = lon; lon = t; note = '위도·경도 순서가 바뀐 것으로 보여 교정했습니다'; }
      else if (lat > 0 && inBox(-lat, lon)) note = '경고: 위도가 양수입니다. 남반구 코스면 음수여야 합니다';
      else note = '경고: 좌표가 코스 지역을 벗어났습니다';
    }
  }
  return {lat, lon, note};
}
function regionBox(){
  const cs = state.settings.course.holes.filter(h => h.center).map(h => h.center);
  if (cs.length >= 3) { const la = median(cs.map(c => c.lat)), lo = median(cs.map(c => c.lon)); return {latMin: la - 0.1, latMax: la + 0.1, lonMin: lo - 0.1, lonMax: lo + 0.1}; }
  return {latMin: -26, latMax: -11, lonMin: 42, lonMax: 51}; // 마다가스카르
}
function courseWarnings(){
  const holes = state.settings.course.holes; const centers = holes.filter(h => h.center); const w = {};
  const add = (no, msg) => { (w[no] = w[no] || []).push(msg); };
  if (centers.length >= 3) {
    const med = {lat: median(centers.map(h => h.center.lat)), lon: median(centers.map(h => h.center.lon))};
    for (const h of centers) { const d = distM(h.center, med); if (d > 3000) add(h.no, `다른 홀들과 ${(d / 1000).toFixed(1)} km 떨어짐. 부호·숫자 확인`); }
  }
  for (const h of holes) {
    if (!h.center) continue;
    if (h.center.lat > 0) add(h.no, '위도가 양수. 남반구 코스면 음수여야 함');
    for (const k of ['front', 'back']) { if (h[k]) { const d = distM(h[k], h.center); if (d > 120) add(h.no, `${k === 'front' ? '앞' : '뒤'} 좌표가 중앙에서 ${Math.round(d)} m. 확인 필요`); } }
  }
  return w;
}

/* ---------- 내보내기/가져오기 ---------- */
function csvEscape(v){ v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }
const n1 = v => v == null ? '' : String(Math.round(v * 10) / 10);
const n6 = v => v == null ? '' : v.toFixed(6);
function csvRows(round){
  const stats = holeStats(round); const rows = []; const strokeNo = {};
  for (const ev of round.events) {
    const h = ev.hole; const H = hole(h); let no = '';
    if (ev.type !== 'holeout') { strokeNo[h] = (strokeNo[h] || 0) + 1; no = strokeNo[h]; }
    const d = new Date(ev.t);
    const type = {shot: '샷', missed: '빠진샷', penalty: '벌타', holeout: '홀아웃'}[ev.type] || ev.type;
    const sd = shotDistance(round, ev); const notes = [];
    if ((ev.type === 'shot' || ev.type === 'holeout') && ev.lat == null) notes.push('위치없음');
    if (sd.note) notes.push(sd.note);
    if (ev.acc != null && ev.acc > 10) notes.push('정확도낮음');
    if (ev.fixAge != null && ev.fixAge > 5) notes.push(`위치 ${Math.round(ev.fixAge)}초 전 값`);
    rows.push([fmtDate(d), fmtTime(d), h, H.par == null ? '' : H.par, stats[h].strokes, no, type, ev.club || '', n6(ev.lat), n6(ev.lon), n1(ev.acc), n1(ev.dtg), n1(sd.dist), n1(sd.endDtg), notes.join(' ')]);
  }
  return rows;
}
function csvText(rounds){
  const head = ['날짜', '시각', '홀', '파', '홀타수', '샷번호', '종류', '클럽', '위도', '경도', '정확도m', '칠때그린거리m', '샷거리m', '끝난뒤그린거리m', '비고'];
  const lines = [head.join(',')];
  for (const r of rounds) for (const row of csvRows(r)) lines.push(row.map(csvEscape).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
async function exportFile(name, text, mime){
  const blob = new Blob([text], {type: mime});
  try {
    const file = new File([blob], name, {type: mime});
    if (navigator.canShare && navigator.canShare({files: [file]})) { await navigator.share({files: [file], title: name}); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function exportRoundCsv(r){ exportFile(`azura_round_${fmtDate(new Date(r.startedAt))}.csv`, csvText([r]), 'text/csv;charset=utf-8'); }
function exportAllCsv(){ const rs = state.rounds.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt)); exportFile(`azura_all_shots_${today()}.csv`, csvText(rs), 'text/csv;charset=utf-8'); }
function backupJson(){ return JSON.stringify({app: 'azura-gps', schema: 1, exportedAt: new Date().toISOString(), settings: state.settings, rounds: state.rounds}, null, 1); }
function exportBackup(){ exportFile(`azura_backup_${today()}.json`, backupJson(), 'application/json'); }
function importData(data, mode){
  if (!data || data.app !== 'azura-gps' || !Array.isArray(data.rounds)) return null;
  let added = 0, replaced = 0;
  for (const r of data.rounds) {
    if (!r || !r.id || !Array.isArray(r.events)) continue;
    const i = state.rounds.findIndex(x => x.id === r.id);
    if (i < 0) { state.rounds.push(r); added++; } else if (r.events.length > state.rounds[i].events.length) { state.rounds[i] = r; replaced++; }
  }
  if (mode === 'all' && data.settings) {
    const d = defaultState().settings; state.settings = Object.assign(d, data.settings);
    if (!state.settings.course || !Array.isArray(state.settings.course.holes) || state.settings.course.holes.length !== 18) state.settings.course = d.course;
    if (!Array.isArray(state.settings.clubs) || !state.settings.clubs.length) state.settings.clubs = CLUBS_DEFAULT.slice();
  }
  save(); return {added, replaced};
}
function onImportFile(e){
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  const rd = new FileReader();
  rd.onload = () => {
    let data; try { data = JSON.parse(rd.result); } catch (err) { toast('JSON을 읽을 수 없습니다'); return; }
    if (!data || data.app !== 'azura-gps' || !Array.isArray(data.rounds)) { toast('이 앱의 백업 파일이 아닙니다'); return; }
    ask({title: '가져오기', body: `라운드 ${data.rounds.length}개가 있습니다.\n같은 라운드는 기록이 더 많은 쪽을 남깁니다.`,
         buttons: [{label: '라운드 + 설정(코스·클럽) 모두', value: 'all', kind: 'primary'}, {label: '라운드만', value: 'rounds'}, {label: '취소', value: null}]}).then(v => {
      if (!v) return; const r = importData(data, v); renderSettings(); startGeo(); toast(`가져옴: 새 라운드 ${r.added}, 갱신 ${r.replaced}`);
    });
  };
  rd.readAsText(file);
}

/* ---------- 화면: 플레이 ---------- */
function nav(screen){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('#s-' + screen).classList.add('active');
  if (screen === 'settings') renderSettings();
  if (screen === 'rounds') renderRounds();
  if (screen === 'play') renderPlay();
  window.scrollTo(0, 0);
}
function renderPlay(){
  const h = state.ui.hole; const H = hole(h);
  $('#holeBtn').textContent = `${h}번홀${H.par ? ` · 파${H.par}` : ''}`;
  $('#unitBtn').textContent = unitLabel();
  renderClubs(); renderGps(); renderScore();
}
function setHtml(el, html){ if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } }
function renderGps(){
  const h = state.ui.hole; const H = hole(h); const c = H.center; const f = lastFix; const age = fixAge(); const fresh = age <= 6000;
  const db = $('#distblock'); db.classList.toggle('stale', !fresh);
  if (!c) {
    setHtml(db, `<div class="nocoord">${h}번홀 그린 좌표가 없습니다<br><button id="goSet" style="margin-top:10px">설정에서 입력</button></div>`);
    $('#goSet').onclick = () => nav('settings');
  } else if (!f) {
    setHtml(db, `<div class="label">그린 중앙</div><div class="num">—</div>`);
  } else {
    const parts = [];
    if (H.front) parts.push(`앞 ${fmtNum(distM(f, H.front))}`);
    if (H.back) parts.push(`뒤 ${fmtNum(distM(f, H.back))}`);
    const fb = parts.length ? `<div class="fb">${parts.join(' · ')}</div>` : '';
    setHtml(db, `<div class="label">그린 중앙${state.settings.testPos ? ' <span class="badge">테스트 위치</span>' : ''}</div><div class="num">${fmtNum(distM(f, c))}<small>${unitLabel()}</small></div>${fb}`);
  }
  const g = $('#gps'); g.classList.remove('ok', 'warn', 'bad'); let txt;
  if (!f) txt = geoError || 'GPS 대기 중…';
  else {
    const cls = f.acc <= 5 ? 'ok' : f.acc <= 10 ? 'warn' : 'bad'; g.classList.add(cls);
    const ageS = Math.round(age / 1000);
    txt = `GPS ±${Math.round(f.acc)} m · ${fresh ? (ageS <= 1 ? '지금' : `${ageS}초 전`) : `${ageS}초 전 · 갱신 대기`}`;
    if (geoError) txt += ` · ${geoError}`;
  }
  $('#gpsText').textContent = txt;
}
function vsText(vs){ return vs == null ? '' : vs === 0 ? 'E' : (vs > 0 ? '+' : '') + vs; }
function renderScore(){
  const r = activeRound(); const h = state.ui.hole; const el = $('#score'); const last = $('#last');
  if (!r) { el.innerHTML = '<span>라운드 없음 · 클럽을 누르면 시작</span><span></span>'; last.textContent = ''; return; }
  const t = roundTotals(r); const s = t.st[h];
  el.innerHTML = `<span>이 홀 <b>${s.strokes}</b>타${s.putts ? ` · 퍼트 ${s.putts}` : ''}${s.done ? ' · 완료' : ''}</span><span>합계 <b>${t.strokes}</b>타${t.vs == null ? '' : ` (${vsText(t.vs)})`} · ${t.done}홀</span>`;
  const evs = s.events; let txt = '';
  const le = evs[evs.length - 1];
  if (le && le.pending) txt = `${le.type === 'holeout' ? '홀아웃' : le.club} 위치 기록 중…`;
  else {
    for (let i = evs.length - 1; i >= 0; i--) { const ev = evs[i]; if (ev.type !== 'shot') continue; const sd = shotDistance(r, ev); if (sd.dist != null) { txt = `직전 ${ev.club} ${fmtDist(sd.dist)}`; break; } }
    if (!txt && le && le.type === 'shot') txt = le.noPos ? `${le.club} 기록됨 · 위치 없음` : `${le.club} 기록됨${le.acc != null ? ` · ±${Math.round(le.acc)} m` : ''}`;
  }
  last.textContent = txt;
}
function renderClubs(){
  const el = $('#clubs'); const clubs = state.settings.clubs; const sig = clubs.join('|');
  if (el.dataset.sig === sig) return; el.dataset.sig = sig; el.innerHTML = '';
  clubs.forEach(c => { const b = document.createElement('button'); b.textContent = c; b.dataset.club = c; if (isPutter(c)) b.classList.add('full'); b.addEventListener('click', () => tapClub(c)); el.appendChild(b); });
}
function flashClub(c){
  const b = Array.from(document.querySelectorAll('#clubs button')).find(x => x.dataset.club === c); if (!b) return;
  b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 600);
}
function openMenu(){
  const r = activeRound();
  ask({title: '메뉴', buttons: [
    {label: '빠진 샷 추가', value: 'missed'},
    {label: '이 홀 그린 중앙을 현재 위치로 교체', value: 'green'},
    {label: '스코어카드', value: 'card'},
    {label: `화면 켜두기: ${state.settings.keepAwake ? '켬' : '끔'}`, value: 'wake'},
    {label: r ? '라운드 종료' : '새 라운드 시작', value: 'round'},
    {label: '라운드 기록', value: 'rounds'},
    {label: '설정', value: 'settings'},
    {label: '닫기', value: null}]}).then(v => {
    switch (v) {
      case 'missed': addMissed(); break;
      case 'green': replaceGreen(); break;
      case 'card': showCard(r ? r.id : null, 'play'); break;
      case 'wake': state.settings.keepAwake = !state.settings.keepAwake; save(); if (state.settings.keepAwake) requestWake(); else releaseWake(); toast(`화면 켜두기 ${state.settings.keepAwake ? '켬' : '끔'}`); break;
      case 'round': if (r) endRound(); else { ensureRound(); renderPlay(); } break;
      case 'rounds': nav('rounds'); break;
      case 'settings': nav('settings'); break;
    }
  });
}

/* ---------- 화면: 스코어카드/라운드 ---------- */
let cardFrom = 'play';
function showCard(roundId, from){
  cardFrom = from || 'play';
  const r = state.rounds.find(x => x.id === roundId) || activeRound(); const body = $('#cardBody');
  if (!r) { body.innerHTML = '<div class="hint">라운드가 없습니다.</div>'; nav('card'); return; }
  const t = roundTotals(r);
  let html = `<div class="hint">${fmtDate(new Date(r.startedAt))}${r.endedAt ? '' : ' · 진행 중'}</div><table><tr><th>홀</th><th>파</th><th>타수</th><th>±</th><th>퍼트</th></tr>`;
  for (let h = 1; h <= 18; h++) {
    const s = t.st[h]; const p = hole(h).par; const played = s.strokes > 0 || s.done; const vs = (played && p != null) ? s.strokes - p : null;
    html += `<tr><td>${h}</td><td>${p == null ? '' : p}</td><td>${played ? s.strokes : ''}</td><td>${vsText(vs)}</td><td>${played ? s.putts : ''}</td></tr>`;
  }
  html += `<tr class="tot"><td>합계</td><td>${t.par || ''}</td><td>${t.strokes}</td><td>${vsText(t.vs)}</td><td>${t.putts}</td></tr></table>`;
  body.innerHTML = html; nav('card');
}
function renderRounds(){
  const body = $('#roundsBody'); body.innerHTML = '';
  const rounds = state.rounds.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const top = document.createElement('div'); top.className = 'rowbtns';
  const b1 = document.createElement('button'); b1.textContent = '전체 샷 CSV'; b1.onclick = exportAllCsv;
  const b2 = document.createElement('button'); b2.textContent = '전체 백업 JSON'; b2.onclick = exportBackup;
  top.append(b1, b2); body.appendChild(top);
  if (!rounds.length) { const p = document.createElement('div'); p.className = 'hint'; p.textContent = '아직 라운드 기록이 없습니다.'; body.appendChild(p); return; }
  for (const r of rounds) {
    const t = roundTotals(r); const c = document.createElement('div'); c.className = 'card';
    const title = document.createElement('div'); title.className = 't';
    title.innerHTML = `<span>${fmtDate(new Date(r.startedAt))}${r.id === state.activeRoundId ? ' <span class="badge">진행 중</span>' : ''}</span><span>${t.strokes}타${t.vs == null ? '' : ` (${vsText(t.vs)})`} · ${t.done}홀</span>`;
    const bs = document.createElement('div'); bs.className = 'rowbtns';
    const s1 = document.createElement('button'); s1.textContent = '스코어카드'; s1.onclick = () => showCard(r.id, 'rounds');
    const s2 = document.createElement('button'); s2.textContent = 'CSV'; s2.onclick = () => exportRoundCsv(r);
    const s3 = document.createElement('button'); s3.textContent = '삭제'; s3.className = 'danger'; s3.onclick = () => deleteRound(r);
    bs.append(s1, s2, s3); c.append(title, bs); body.appendChild(c);
  }
}

/* ---------- 화면: 설정 ---------- */
function coordInputText(c){ return c ? `${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}` : ''; }
function renderSettings(){
  const s = state.settings; const body = $('#settingsBody'); body.innerHTML = '';
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  // 코스 좌표
  const sec = el('div', 'section', `<h2>코스 좌표</h2><div class="hint">구글 지도에서 그린 중앙을 우클릭해 좌표를 복사한 뒤 붙여넣고 다른 칸을 누르면 저장됩니다. 십진수(-17.68xx, 49.50xx)와 도분초(17°40'52"S 49°30'12"E) 모두 됩니다. 앞·뒤는 선택이고, 비워도 됩니다.</div><div id="holes"></div>`);
  body.appendChild(sec); const holesEl = sec.querySelector('#holes'); const warns = courseWarnings();
  s.course.holes.forEach(H => {
    const row = el('div', 'holerow');
    row.innerHTML = `<div class="hn">${H.no}번</div><div class="fields">
      <div class="parrow"><input type="number" inputmode="numeric" min="3" max="6" placeholder="파" data-f="par"><div class="src" data-src></div></div>
      <input type="text" placeholder="그린 중앙 좌표 붙여넣기" data-f="center" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="row2"><input type="text" placeholder="앞 (선택)" data-f="front" autocomplete="off" autocapitalize="off" spellcheck="false"><input type="text" placeholder="뒤 (선택)" data-f="back" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="warnmsg" data-w></div></div>`;
    row.querySelector('[data-f="par"]').value = H.par == null ? '' : H.par;
    row.querySelector('[data-f="center"]').value = coordInputText(H.center);
    row.querySelector('[data-f="front"]').value = coordInputText(H.front);
    row.querySelector('[data-f="back"]').value = coordInputText(H.back);
    row.querySelector('[data-src]').textContent = H.center && H.center.src === 'gps' ? `중앙: GPS로 교체 ${fmtDate(new Date(H.center.t))}` : '';
    row.querySelector('[data-w]').textContent = (warns[H.no] || []).join(' · ');
    row.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => onHoleInput(H.no, inp, row)));
    holesEl.appendChild(row);
  });

  // 클럽
  const cs = el('div', 'section', `<h2>클럽 목록</h2><div class="hint">한 줄에 하나. 화면의 버튼 순서와 같습니다. 이름에 "퍼터"가 들어간 클럽은 거리 계산에서 빠집니다.</div><textarea id="clubsTa"></textarea><div class="rowbtns"><button id="clubsReset">기본 목록으로</button></div>`);
  body.appendChild(cs); const ta = cs.querySelector('#clubsTa'); ta.value = s.clubs.join('\n');
  ta.addEventListener('change', () => {
    const list = Array.from(new Set(ta.value.split('\n').map(x => x.trim()).filter(Boolean)));
    if (!list.length) { toast('클럽이 하나 이상 필요합니다'); ta.value = s.clubs.join('\n'); return; }
    s.clubs = list; save(); toast('클럽 목록 저장');
  });
  cs.querySelector('#clubsReset').onclick = () => { s.clubs = CLUBS_DEFAULT.slice(); ta.value = s.clubs.join('\n'); save(); toast('기본 목록으로 복원'); };

  // 표시
  const us = el('div', 'section', `<h2>표시</h2><div class="switch"><span>거리 단위</span><button id="unitsBtn"></button></div><div class="switch"><span>화면 켜두기<br><span class="hint">앱이 열려 있는 동안 화면이 꺼지지 않음. 주머니에 넣을 땐 전원 버튼으로 끄세요.</span></span><button id="awakeBtn"></button></div>`);
  body.appendChild(us);
  const ub = us.querySelector('#unitsBtn'), ab = us.querySelector('#awakeBtn');
  const paint = () => { ub.textContent = s.units === 'yd' ? '야드' : '미터'; ab.textContent = s.keepAwake ? '켬' : '끔'; };
  ub.onclick = () => { s.units = s.units === 'm' ? 'yd' : 'm'; save(); paint(); };
  ab.onclick = () => { s.keepAwake = !s.keepAwake; save(); paint(); if (s.keepAwake) requestWake(); else releaseWake(); };
  paint();

  // 테스트 위치
  const ts = el('div', 'section', `<h2>테스트 위치</h2><div class="hint">코스 밖에서 시험할 때 GPS 대신 쓸 좌표. 비우면 실제 GPS를 씁니다.</div><input id="testPos" placeholder="-17.68xxxx, 49.50xxxx" autocomplete="off"><div class="warnmsg" id="testPosW"></div>`);
  body.appendChild(ts); const tp = ts.querySelector('#testPos'); tp.value = coordInputText(s.testPos);
  tp.addEventListener('change', () => {
    const raw = tp.value.trim(); const w = ts.querySelector('#testPosW');
    if (!raw) { s.testPos = null; w.textContent = ''; save(); startGeo(); toast('실제 GPS 사용'); return; }
    const p = parseCoord(raw); if (p.error) { w.textContent = p.error; return; }
    s.testPos = {lat: p.lat, lon: p.lon}; tp.value = coordInputText(s.testPos); w.textContent = ''; save(); startGeo(); toast('테스트 위치 사용 중');
  });

  // 데이터
  const ds = el('div', 'section', `<h2>데이터</h2><div class="hint">코스 좌표는 다시 넣을 수 있지만 라운드 기록은 되살릴 수 없습니다. 라운드가 끝나면 백업을 내보내세요.</div><div class="rowbtns"><button id="bkBtn">전체 백업 JSON</button><button id="imBtn">JSON 가져오기</button><button id="csvAllBtn">전체 샷 CSV</button></div><div class="rowbtns"><button id="wipeBtn" class="danger">모든 데이터 삭제</button></div>`);
  body.appendChild(ds);
  ds.querySelector('#bkBtn').onclick = exportBackup;
  ds.querySelector('#imBtn').onclick = () => $('#importFile').click();
  ds.querySelector('#csvAllBtn').onclick = exportAllCsv;
  ds.querySelector('#wipeBtn').onclick = () => ask({title: '모든 데이터 삭제', body: '코스 좌표, 클럽, 모든 라운드 기록을 지웁니다. 되돌릴 수 없습니다. 먼저 백업을 내보내세요.', buttons: [{label: '모두 삭제', value: true, kind: 'danger'}, {label: '취소', value: null}]}).then(v => {
    if (!v) return; finalizeCapture(); state = defaultState(); save(); startGeo(); renderSettings(); toast('모든 데이터를 지웠습니다');
  });

  // 기록 규칙
  body.appendChild(el('div', 'section', `<h2>기록 규칙</h2><div class="hint">· 공 앞에 서서 치기 전에 클럽을 누릅니다. 그 한 번이 위치 기록이고 1타입니다.<br>· 첫 퍼트는 공 옆에서 퍼터를 누르세요. 어프로치 샷의 끝점이 됩니다. 나머지 퍼트는 어디서 눌러도 됩니다.<br>· 홀아웃은 타수를 더하지 않습니다. 컨시드 퍼트도 퍼터를 눌러야 타수에 들어갑니다.<br>· OB·워터·언플레이어블은 벌타 버튼. 직전 샷 거리는 비워집니다.<br>· 치기 전 누르는 걸 잊었으면 메뉴의 "빠진 샷 추가"를 지금 샷의 클럽을 누르기 전에 넣습니다.<br>· 그린 좌표 검증: 그린 중앙에 서서 표시 거리가 GPS 정확도보다 크게 나오면 메뉴의 "그린 중앙 교체"로 고칩니다.</div>`));
}
function onHoleInput(no, inp, row){
  const H = hole(no); const f = inp.dataset.f; const w = row.querySelector('[data-w]');
  if (f === 'par') { const v = parseInt(inp.value, 10); H.par = (v >= 1 && v <= 9) ? v : null; inp.value = H.par == null ? '' : H.par; save(); return; }
  const raw = inp.value.trim();
  if (!raw) { H[f] = null; save(); refreshWarns(); return; }
  const p = parseCoord(raw, regionBox());
  const label = f === 'center' ? '중앙' : f === 'front' ? '앞' : '뒤';
  if (p.error) { w.textContent = `${label} 좌표 인식 불가: ${p.error}`; return; }
  H[f] = {lat: p.lat, lon: p.lon, src: 'manual', t: new Date().toISOString()};
  inp.value = coordInputText(H[f]); save();
  if (f === 'center') row.querySelector('[data-src]').textContent = '';
  refreshWarns(p.note ? {no, msg: `${label}: ${p.note}`} : null);
}
function refreshWarns(extra){
  const warns = courseWarnings();
  document.querySelectorAll('#holes .holerow').forEach((row, i) => {
    const no = i + 1; const list = (warns[no] || []).slice();
    if (extra && extra.no === no) list.unshift(extra.msg);
    row.querySelector('[data-w]').textContent = list.join(' · ');
  });
}

/* ---------- 시작 ---------- */
function boot(){
  $('#prevHole').onclick = () => { state.ui.hole = (state.ui.hole + 16) % 18 + 1; save(); renderPlay(); };
  $('#nextHole').onclick = () => { state.ui.hole = state.ui.hole % 18 + 1; save(); renderPlay(); };
  $('#holeBtn').onclick = pickHole;
  $('#unitBtn').onclick = () => { state.settings.units = state.settings.units === 'm' ? 'yd' : 'm'; save(); renderPlay(); };
  $('#menuBtn').onclick = openMenu;
  $('#undoBtn').onclick = undo;
  $('#penBtn').onclick = addPenalty;
  $('#holeoutBtn').onclick = () => holeOut();
  document.querySelectorAll('[data-nav]').forEach(b => { b.onclick = () => nav(b.dataset.nav); });
  $('#cardBack').onclick = () => nav(cardFrom || 'play');
  $('#importFile').addEventListener('change', onImportFile);
  renderPlay(); startGeo(); requestWake();
  setInterval(renderGps, 500);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
window.__azura = {get state(){ return state; }, set state(v){ state = v; }, save, load, parseCoord, csvText, distM, holeStats, roundTotals, shotDistance, importData, backupJson, renderPlay, startGeo};
boot();
