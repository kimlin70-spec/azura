/* 저장소 루트의 웹앱 파일을 www/로 복사하고, 앱(안드로이드 APK, 아이폰 IPA)에서만 필요한 것을 www/index.html에 끼워 넣는다:
   capacitor.js·native.js 스크립트 태그, 노치·홈 바를 피하는 safe-area 스타일.
   루트의 index.html/app.js는 건드리지 않는다. 실행: node copy-web.js  (npm run sync 가 이걸 먼저 돌린다) */
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..'), www = path.join(__dirname, 'www');
fs.rmSync(www, {recursive: true, force: true});
fs.mkdirSync(www, {recursive: true});
for (const f of ['app.js', 'manifest.json']) fs.copyFileSync(path.join(root, f), path.join(www, f));
fs.cpSync(path.join(root, 'icons'), path.join(www, 'icons'), {recursive: true});
fs.copyFileSync(path.join(__dirname, 'native.js'), path.join(www, 'native.js'));
fs.copyFileSync(path.join(__dirname, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'), path.join(www, 'capacitor.js'));
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const tag = '<script src="./app.js"></script>';
if (!html.includes(tag)) throw new Error('index.html에서 app.js 스크립트 태그를 찾지 못했습니다');
html = html.replace(tag, () => '<script src="./capacitor.js"></script>\n<script src="./native.js"></script>\n' + tag);
/* 앱 전용 safe-area 여백. index.html의 viewport-fit=cover 때문에 아이폰에서는 화면이 노치(상태 표시줄)와 홈 바 밑까지 그려지므로
   본문을 그만큼 안쪽으로 밀고, 아래에 고정된 토스트와 창(모달)을 홈 바 위로 올린다.
   안드로이드는 MainActivity가 시스템 바만큼 패딩을 주고 WebView에는 0 inset을 넘기므로 env(safe-area-inset-*)가 0이라 영향이 없다.
   웹앱(GitHub Pages)의 루트 index.html에는 넣지 않는다. */
const safeArea = '<style id="native-safe-area">\n' +
  'body{padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}\n' +
  '#toast{bottom:calc(90px + env(safe-area-inset-bottom))}\n' +
  '#modal{padding-bottom:calc(12px + env(safe-area-inset-bottom))}\n' +
  '</style>\n';
if (!html.includes('</head>')) throw new Error('index.html에서 </head>를 찾지 못했습니다');
html = html.replace('</head>', () => safeArea + '</head>');
fs.writeFileSync(path.join(www, 'index.html'), html);
console.log('www/ 준비 완료: ' + fs.readdirSync(www).join(', '));
