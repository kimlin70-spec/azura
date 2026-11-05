# apk — 안드로이드 APK·아이폰 앱 래퍼

루트의 웹앱(`index.html`, `app.js`)을 Capacitor로 그대로 감싼 앱 프로젝트입니다. 폴더 이름은 `apk`이지만 안드로이드와 아이폰 프로젝트가 함께 들어 있고, 웹 파일 준비와 연결 코드는 두 플랫폼이 같이 씁니다. 받는 법, 서명, 폰 설정은 루트 `README.md`의 "안드로이드 APK"와 "아이폰 앱" 절을 보세요.

- `copy-web.js`: 루트의 웹 파일을 `www/`로 복사하고 `index.html`에 `capacitor.js`, `native.js` 스크립트 태그와 노치·홈 바를 피하는 safe-area 스타일을 끼워 넣습니다. `www/`는 생성물이라 git에 없습니다.
- `native.js`: 앱 안에서만 도는 연결 코드. 라운드 중 백그라운드 GPS, 파일 공유, 화면 켜두기, 저장소 미러(`azura-state.json`). 뒤로 가기와 알림 권한은 안드로이드에서만 씁니다.
- `capacitor.config.json`: 두 플랫폼 공용 설정. 앱 ID `io.github.kimlin70spec.azura`, 앱 이름 `Azura GPS`. `plugins.SystemBars`의 `style`은 아이폰에도 적용되고, `insetsHandling`은 안드로이드만 읽습니다.
- `android/`: 안드로이드 네이티브 프로젝트. 서명은 `android/keystore.properties`로 하며 git에서 제외됩니다.
- `ios/`: 아이폰 네이티브 프로젝트. Xcode 프로젝트는 `ios/App/App.xcodeproj`, 타깃과 스킴은 `App`이고 Swift Package Manager를 씁니다. 위치 권한 문구와 백그라운드 위치는 `ios/App/App/Info.plist`에 있습니다. `ios/App/CapApp-SPM/Package.swift`는 Capacitor CLI가 관리하니 직접 고치지 않습니다. Debug 빌드는 `ios/debug.xcconfig`의 `CAPACITOR_DEBUG = true`로 앱 로그를 찍고, CI 시뮬레이터 점검이 이 로그를 봅니다. `cap sync`가 만드는 `ios/App/App/public`과 빌드 산출물은 git에서 제외됩니다.
- 자동 빌드: 워크플로는 저장소 루트의 `.github/workflows/`에 있습니다. 안드로이드는 `apk.yml`, 아이폰은 `ios.yml`입니다. `ios.yml`은 서명 없는 `azura-gps.ipa`를 만들어 릴리스 `ios-latest`에 올립니다.

```bash
npm install
npm run sync    # node copy-web.js && npx cap sync android
npm run open    # Android Studio로 android/ 열기
node copy-web.js && npx cap sync ios    # 아이폰 프로젝트에 반영
```

`npm run sync`는 안드로이드에만 반영합니다. 아이폰 빌드에는 맥과 Xcode 26 이상이 필요해서, 맥이 없으면 `ios.yml`이 GitHub의 맥 러너에서 빌드합니다. 맥이 있으면 위 마지막 줄 다음에 `npx cap open ios`로 Xcode를 엽니다.
