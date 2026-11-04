package io.github.kimlin70spec.azura;

import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySystemBarInsets();
    }

    /**
     * targetSdk 35+ 에서는 앱이 강제로 edge-to-edge 로 그려진다. Capacitor 8 의 SystemBars 플러그인은
     * 페이지의 meta viewport 에 viewport-fit=cover 가 있으면(이 앱의 index.html 이 그렇다, WebView 140+)
     * WebView 를 상태바/내비게이션바 밑까지 넓히고 웹 쪽이 env(safe-area-inset-*) 로 피하길 기대하는데,
     * 이 웹앱은 safe-area CSS 를 쓰지 않는다. 그래서 capacitor.config.json 에서
     * plugins.SystemBars.insetsHandling = "disable" 로 플러그인의 inset 처리를 끄고, 여기서 항상
     * 시스템 바(+디스플레이 컷아웃, 키보드) 크기만큼 창 내용에 패딩을 준다.
     * (Capacitor SystemBars 플러그인의 viewport-fit=cover 가 아닐 때 분기와 같은 로직)
     */
    private void applySystemBarInsets() {
        final View decorView = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decorView, (view, insets) -> {
            final int barTypes = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            Insets bars = insets.getInsets(barTypes);
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, keyboardVisible ? ime.bottom : bars.bottom);
            // 패딩으로 이미 처리했으므로 자식(WebView)에는 0 으로 넘긴다.
            // (CONSUMED 를 돌려주면 WebView 의 safe-area 재계산이 깨진다: https://issues.chromium.org/issues/461332423)
            return new WindowInsetsCompat.Builder(insets).setInsets(barTypes, Insets.of(0, 0, 0, 0)).build();
        });
    }
}
