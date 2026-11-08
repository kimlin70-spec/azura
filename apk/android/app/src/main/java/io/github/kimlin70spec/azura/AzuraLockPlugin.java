package io.github.kimlin70spec.azura;

import android.app.Activity;
import android.os.Build;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 거리만 보기 모드용. setShowWhenLocked(true)면 앱을 켠 채 화면을 껐다가 전원 버튼을 누를 때
 * 잠금 해제 없이 앱 화면이 바로 보인다(알람·시계 앱이 쓰는 표준 동작). 권한은 필요 없다.
 */
@CapacitorPlugin(name = "AzuraLock")
public class AzuraLockPlugin extends Plugin {

    @PluginMethod
    public void setShowWhenLocked(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        final Activity activity = getActivity();
        if (activity == null) { call.reject("No activity"); return; }
        activity.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                activity.setShowWhenLocked(on);
            } else {
                if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
                else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
            }
            call.resolve();
        });
    }
}
