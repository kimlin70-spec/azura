# apk — 안드로이드 APK 래퍼

루트의 웹앱(`index.html`, `app.js`)을 Capacitor로 그대로 감싼 안드로이드 프로젝트입니다. 받는 법, 서명, 폰 설정은 루트 `README.md`의 "안드로이드 APK" 절을 보세요.

- `copy-web.js`: 루트의 웹 파일을 `www/`로 복사하고 `index.html`에 `capacitor.js`, `native.js`를 끼워 넣습니다. `www/`는 생성물이라 git에 없습니다.
- `native.js`: APK 안에서만 도는 연결 코드. 라운드 중 백그라운드 GPS, 파일 공유, 뒤로 가기, 화면 켜두기.
- `android/`: 네이티브 프로젝트. 서명은 `android/keystore.properties`로 하며 git에서 제외됩니다.

```bash
npm install
npm run sync    # node copy-web.js && npx cap sync android
npm run open    # Android Studio로 android/ 열기
```
