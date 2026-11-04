/* 브라우저에서 GPS를 흉내 내어 거리 표시, 샷 기록, CSV, 좌표 파서를 검증한다.
   실행: node tests/e2e.cjs  (Chromium + Playwright 필요) */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png'};
const shotDir = process.env.SHOT_DIR || '';
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    fs.readFile(path.join(root, p), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, {'content-type': types[path.extname(p)] || 'application/octet-stream'}); res.end(d); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const G = {lat: -17.68, lon: 49.5};                 // 1번홀 그린 중앙
  const TEE = {lat: -17.683, lon: 49.5};              // 약 333.6 m
  const P2 = {lat: -17.6815, lon: 49.5};              // 드라이버 끝 ≈ 166.8 m
  const P3 = {lat: -17.68055, lon: 49.5};             // 벌타 뒤 드롭
  const P4 = {lat: -17.68002, lon: 49.50001};         // 첫 퍼트 위치
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 360, height: 740}, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    geolocation: {latitude: TEE.lat, longitude: TEE.lon, accuracy: 4}, permissions: ['geolocation'], serviceWorkers: 'block', locale: 'ko-KR'});
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const setPos = async (p, acc = 4) => { await ctx.setGeolocation({latitude: p.lat, longitude: p.lon, accuracy: acc}); await sleep(250); };
  const text = sel => page.locator(sel).innerText();
  const num = async sel => parseFloat((await text(sel)).replace(/[^\d.]/g, ''));
  const hav = (a, b) => page.evaluate(([a, b]) => window.__azura.distM(a, b), [a, b]);

  await page.goto(base);
  // 코스 데이터 심기: 1번홀 파4, 2번홀 좌표
  await page.evaluate(([G]) => { const s = window.__azura.state; s.settings.course.holes[0].par = 4; s.settings.course.holes[0].center = {lat: G.lat, lon: G.lon, src: 'manual', t: 'x'};
    s.settings.course.holes[0].front = {lat: G.lat - 0.0001, lon: G.lon, src: 'manual', t: 'x'}; s.settings.course.holes[1].par = 3; s.settings.course.holes[1].center = {lat: -17.676, lon: 49.502, src: 'manual', t: 'x'}; window.__azura.save(); }, [G]);
  await page.reload(); await sleep(600);

  // 1) 거리 표시
  const d0 = await hav(TEE, G);
  ok(near(await num('#distblock .num'), Math.round(d0), 1), `티에서 그린 거리 표시 ${Math.round(d0)} m`);
  ok((await text('#gpsText')).includes('±4 m'), 'GPS 정확도 표시');
  ok((await text('#distblock .fb')).startsWith('앞 '), '앞 거리 표시');
  if (shotDir) await page.screenshot({path: path.join(shotDir, 'play-before.png')});

  // 2) 샷 기록 흐름
  await page.getByRole('button', {name: '드라이버', exact: true}).click(); await sleep(300);
  ok((await text('#score')).includes('이 홀 1타'), '드라이버 탭 → 1타');
  ok((await text('#last')).startsWith('드라이버 기록됨'), '첫 샷은 기록됨 표시');
  await setPos(P2);
  await page.getByRole('button', {name: '7번 아이언', exact: true}).click(); await sleep(300);
  const d1 = await hav(TEE, P2);
  ok((await text('#last')) === `직전 드라이버 ${Math.round(d1)} m`, `직전 샷 거리 표시 (${Math.round(d1)} m)`);
  await page.getByRole('button', {name: '벌타', exact: true}).click(); await sleep(200);
  ok((await text('#score')).includes('이 홀 3타'), '벌타 → 3타');
  await setPos(P3);
  await page.getByRole('button', {name: '49도', exact: true}).click(); await sleep(300);
  ok((await text('#last')) === `직전 드라이버 ${Math.round(d1)} m`, '벌타 뒤 샷은 7번 아이언 거리를 만들지 않음');
  await setPos(P4);
  await page.getByRole('button', {name: '퍼터', exact: true}).click(); await sleep(300);
  const d3 = await hav(P3, P4);
  ok((await text('#last')) === `직전 49도 ${Math.round(d3)} m`, `첫 퍼트 위치가 어프로치 끝점 (${Math.round(d3)} m)`);
  await page.getByRole('button', {name: '퍼터', exact: true}).click(); await sleep(100);
  ok((await text('#score')).includes('이 홀 5타'), '0.7초 안 같은 클럽 재탭은 무시');
  await sleep(800);
  await page.getByRole('button', {name: '퍼터', exact: true}).click(); await sleep(300);
  ok((await text('#score')).includes('이 홀 6타 · 퍼트 2'), '두 번째 퍼트 → 6타, 퍼트 2');
  if (shotDir) await page.screenshot({path: path.join(shotDir, 'play-mid.png')});
  await setPos(G);
  await page.getByRole('button', {name: '홀아웃', exact: true}).click(); await sleep(400);
  ok((await text('#holeBtn')).startsWith('2번홀'), '홀아웃 → 2번홀로 이동');
  ok((await text('#score')).includes('합계 6타 (+2) · 1홀'), '합계 6타, +2');

  // 3) 되돌리기와 복구
  await page.getByRole('button', {name: '되돌리기', exact: true}).click(); await sleep(200);
  ok((await text('#holeBtn')).startsWith('1번홀'), '홀아웃 되돌리기 → 1번홀');
  await page.getByRole('button', {name: '복구', exact: true}).click(); await sleep(200);
  ok((await text('#holeBtn')).startsWith('2번홀'), '복구 → 2번홀');

  // 4) 홀아웃 누락 확인창: 2번홀에서 퍼터 뒤 멀리서 드라이버
  await page.getByRole('button', {name: '퍼터', exact: true}).click(); await sleep(300);
  await setPos({lat: -17.6745, lon: 49.502}); // 2번홀 그린에서 약 167 m
  await page.getByRole('button', {name: '드라이버', exact: true}).click(); await sleep(300);
  ok((await text('#modal')).includes('홀아웃을 안 누른 것 같습니다'), '홀아웃 누락 확인창');
  await page.getByRole('button', {name: /2번홀 홀아웃하고 3번홀에 기록/}).click(); await sleep(300);
  ok((await text('#holeBtn')).startsWith('3번홀'), '확인 → 2번홀 홀아웃, 3번홀에 기록');
  ok((await text('#score')).includes('이 홀 1타'), '3번홀 1타');

  // 4b) 모든 위치 이벤트가 완료되고 위치를 가짐 (누락 확인으로 만든 홀아웃 제외)
  await sleep(300);
  const bad = await page.evaluate(() => window.__azura.state.rounds.flatMap(r => r.events).filter(e => (e.type === 'shot' || e.type === 'holeout') && (e.pending || (e.lat == null && !(e.type === 'holeout' && e.noPos)))).map(e => `${e.hole}:${e.type}:${e.club || ''}`));
  ok(bad.length === 0, `모든 샷·홀아웃에 위치 기록됨 ${bad.length ? JSON.stringify(bad) : ''}`);

  // 5) CSV
  const csv = await page.evaluate(() => window.__azura.csvText(window.__azura.state.rounds));
  const rows = csv.replace(/^﻿/, '').trim().split('\r\n').map(l => l.split(','));
  ok(rows[0].length === 15 && rows[0][12] === '샷거리m', 'CSV 머리글');
  const r = rows.slice(1);
  const col = (row, name) => row[rows[0].indexOf(name)];
  ok(col(r[0], '클럽') === '드라이버' && near(parseFloat(col(r[0], '샷거리m')), d1, 0.2) && near(parseFloat(col(r[0], '칠때그린거리m')), d0, 0.2), 'CSV 드라이버: 샷거리·칠때그린거리');
  ok(near(parseFloat(col(r[0], '끝난뒤그린거리m')), await hav(P2, G), 0.2), 'CSV 드라이버: 끝난뒤그린거리');
  ok(col(r[1], '클럽') === '7번 아이언' && col(r[1], '샷거리m') === '' && col(r[1], '비고') === '다음 벌타', 'CSV 7번 아이언: 벌타로 거리 없음');
  ok(col(r[2], '종류') === '벌타' && col(r[2], '샷번호') === '3', 'CSV 벌타 행, 샷번호 3');
  ok(col(r[3], '클럽') === '49도' && near(parseFloat(col(r[3], '샷거리m')), d3, 0.2), 'CSV 49도 거리');
  ok(col(r[4], '클럽') === '퍼터' && col(r[4], '샷거리m') === '' && col(r[4], '비고') === '퍼트', 'CSV 퍼터: 거리 비움');
  ok(col(r[6], '종류') === '홀아웃' && col(r[6], '홀타수') === '6' && col(r[6], '샷번호') === '', 'CSV 홀아웃 행');
  ok(col(r[8], '종류') === '홀아웃' && col(r[8], '비고') === '위치없음', 'CSV 누락 확인으로 만든 홀아웃은 위치없음');
  ok(r.every(x => x.length === 15), 'CSV 모든 행 15열');

  // 6) 좌표 파서
  const P = async (s, box) => page.evaluate(([s, box]) => window.__azura.parseCoord(s, box), [s, box || null]);
  const box = {latMin: -26, latMax: -11, lonMin: 42, lonMax: 51};
  const exp = {lat: -17.6812333, lon: 49.5034556};
  const cases = [['-17.6812333, 49.5034556', 0], ['17°40\'52.44"S 49°30\'12.44"E', 0.00001], ['17 40 52.44 S, 49 30 12.44 E', 0.00001], ['S17°40.874\' E49°30.207\'', 0.0001], ['-17.6812333 49.5034556', 0], ['49.5034556,-17.6812333,0', 0], ['17.6812333°S, 49.5034556°E', 0], ['49.5034556, -17.6812333', 0]];
  for (const [s, tol] of cases) { const p = await P(s, box); ok(!p.error && near(p.lat, exp.lat, tol || 1e-9) && near(p.lon, exp.lon, tol || 1e-9), `파서: ${s} → ${p.error || p.lat.toFixed(6) + ', ' + p.lon.toFixed(6)}${p.note ? ' [' + p.note + ']' : ''}`); }
  let p = await P('17.6812333, 49.5034556', box); ok(!p.error && p.lat > 0 && /위도가 양수/.test(p.note), '파서: 부호 빠진 위도는 경고');
  p = await P('abc', box); ok(!!p.error, '파서: 쓸모없는 입력은 오류');
  p = await P('17 70 10 S 49 30 10 E', box); ok(!!p.error, '파서: 분이 60 이상이면 오류');

  // 7) 설정 화면 입력과 오타 검사
  await page.locator('#menuBtn').click(); await page.getByRole('button', {name: '설정', exact: true}).click(); await sleep(300);
  const rowsEl = page.locator('#holes .holerow');
  await rowsEl.nth(2).locator('[data-f="center"]').fill('17°40\'48.0"S 49°30\'00.0"E'); await rowsEl.nth(2).locator('[data-f="par"]').focus(); await sleep(150);
  ok((await rowsEl.nth(2).locator('[data-f="center"]').inputValue()) === '-17.680000, 49.500000', '설정: 도분초 입력이 십진수로 저장');
  await rowsEl.nth(3).locator('[data-f="center"]').fill('-17.90, 49.50'); await rowsEl.nth(3).locator('[data-f="par"]').focus(); await sleep(150);
  ok(/떨어짐/.test(await rowsEl.nth(3).locator('[data-w]').innerText()), '설정: 동떨어진 좌표 경고');
  await rowsEl.nth(3).locator('[data-f="center"]').fill(''); await rowsEl.nth(3).locator('[data-f="par"]').focus(); await sleep(150);
  ok((await rowsEl.nth(3).locator('[data-w]').innerText()) === '', '설정: 비우면 경고 사라짐');
  // 7b) 설정의 📍 버튼: 현재 위치를 칸에 넣고, 토스트로 되돌리기
  const PF = {lat: -17.7075, lon: 49.5102};
  await setPos(PF, 4);
  await rowsEl.nth(2).locator('[data-gps="front"]').click(); await sleep(250);
  ok((await rowsEl.nth(2).locator('[data-f="front"]').inputValue()) === '-17.707500, 49.510200', '📍 앞: 현재 위치가 칸에 들어감');
  ok(/앞 GPS/.test(await rowsEl.nth(2).locator('[data-src]').innerText()), '📍 앞: 출처 표시');
  ok(/3번홀 그린 앞 기록 ±4 m/.test(await text('#toast')), '📍 앞: 토스트');
  await page.getByRole('button', {name: '이전 값으로', exact: true}).click(); await sleep(200);
  ok((await rowsEl.nth(2).locator('[data-f="front"]').inputValue()) === '', '📍 되돌리기 → 빈 칸');
  await setPos(PF, 20);
  await rowsEl.nth(2).locator('[data-gps="back"]').click(); await sleep(250);
  ok((await rowsEl.nth(2).locator('[data-f="back"]').inputValue()) === '' && /정확도 ±20 m/.test(await text('#toast')), '📍 정확도 20 m면 거부');
  ok(/±20 m/.test(await text('#gpsSetText')), '설정 화면 GPS 상태줄');
  if (shotDir) await page.screenshot({path: path.join(shotDir, 'settings.png')});

  // 7c) 플레이 메뉴에서 앞·중앙·뒤 선택 기록
  await page.locator('#s-settings [data-nav="play"]').click(); await sleep(200);
  await setPos(PF, 3);
  await page.locator('#menuBtn').click(); await page.getByRole('button', {name: '그린 앞·중앙·뒤를 현재 위치로 기록', exact: true}).click(); await sleep(200);
  ok(/GPS 정확도 ±3 m/.test(await text('#modal')) && /뒤 · 아직 없음/.test(await text('#modal')), '메뉴 기록창: 정확도와 현재 값 표시');
  await page.getByRole('button', {name: /^뒤 · /}).click(); await sleep(250);
  const back3 = await page.evaluate(() => window.__azura.state.settings.course.holes[2].back);
  ok(back3 && near(back3.lat, PF.lat, 1e-9) && near(back3.lon, PF.lon, 1e-9) && back3.src === 'gps', '메뉴 기록: 3번홀 뒤 좌표 저장');
  ok(/뒤 \d+/.test(await text('#distblock .fb')), '플레이 화면에 뒤 거리 표시');

  // 8) 백업 JSON 가져오기 병합
  const bk = await page.evaluate(() => JSON.parse(window.__azura.backupJson()));
  const res = await page.evaluate(([bk]) => { bk.rounds.push({id: 'other', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T04:00:00Z', startHole: 1, events: []}); return window.__azura.importData(bk, 'rounds'); }, [bk]);
  ok(res && res.added === 1 && res.replaced === 0, '가져오기: 새 라운드 1 추가, 기존 유지');

  // 9) 새로고침 뒤 유지
  await page.reload(); await sleep(500);
  ok((await text('#holeBtn')).startsWith('3번홀') && (await text('#score')).includes('이 홀 1타'), '새로고침 뒤 라운드·홀 유지');
  if (shotDir) { await page.locator('#menuBtn').click(); await page.getByRole('button', {name: '스코어카드', exact: true}).click(); await sleep(300); await page.screenshot({path: path.join(shotDir, 'scorecard.png')}); }

  ok(errors.length === 0, `페이지 오류 없음 ${errors.length ? JSON.stringify(errors) : ''}`);
  await browser.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
