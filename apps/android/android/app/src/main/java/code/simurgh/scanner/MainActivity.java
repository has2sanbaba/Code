package code.simurgh.scanner;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

/**
 * سیمرغ‌کد's single activity.
 *
 * Capacitor's WebView grants `getUserMedia` camera requests through its own
 * WebChromeClient, but only after the OS-level permission has been given; asking
 * for it here, on first launch, means the user meets the Android dialog before
 * they meet a silent camera failure inside the page.
 */
public class MainActivity extends BridgeActivity {

    private static final int CAMERA_PERMISSION_CODE = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestCameraIfNeeded();
    }

    private void requestCameraIfNeeded() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this, new String[] { Manifest.permission.CAMERA }, CAMERA_PERMISSION_CODE);
        }
    }
}
