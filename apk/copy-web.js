/* 저장소 루트의 웹앱 파일을 www/로 복사하고, APK에서만 필요한 capacitor.js와 native.js를 index.html에 끼워 넣는다.
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
html = html.replace(tag, '<script src="./capacitor.js"></script>\n<script src="./native.js"></script>\n' + tag);
fs.writeFileSync(path.join(www, 'index.html'), html);
console.log('www/ 준비 완료: ' + fs.readdirSync(www).join(', '));
