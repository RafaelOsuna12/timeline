/*
 * Ejemplo de integración. Copia lo que necesites en tu actividad.
 *
 * Con PushFlow puedes avisar de la nueva versión: manda una notificación con
 * app_url = "miapp://actualizar" filtrando por app_version, y abre esta
 * pantalla desde el deep link.
 */
package com.honorlab.miapp;

import android.app.AlertDialog;
import android.os.Bundle;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import com.honorlab.updater.AppUpdater;
import com.honorlab.updater.UpdateInfo;
import com.honorlab.updater.UpdateInstallReceiver;

import java.io.File;

public class ActualizacionActivity extends AppCompatActivity {

    private static final String MANIFIESTO =
            "https://updates.honorlab.dev/miapp/latest.json";

    private AppUpdater updater;
    private UpdateInfo pendiente;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        updater = new AppUpdater.Builder(this)
                .manifestUrl(MANIFIESTO)
                .appId("miapp")
                .listener(new AppUpdater.Listener() {

                    @Override
                    public void onUpToDate(long currentVersionCode) {
                        // Silencio en el arranque normal: no molestes al usuario.
                    }

                    @Override
                    public void onUpdateAvailable(UpdateInfo info) {
                        pendiente = info;
                        mostrarDialogo(info);
                    }

                    @Override
                    public void onProgress(int percent, long descargado, long total) {
                        // Actualiza aquí tu ProgressBar.
                    }

                    @Override
                    public void onReadyToInstall(File apk) {
                        Toast.makeText(ActualizacionActivity.this,
                                "Descarga completa, iniciando instalación…",
                                Toast.LENGTH_SHORT).show();
                    }

                    @Override
                    public void onPermissionRequired() {
                        new AlertDialog.Builder(ActualizacionActivity.this)
                                .setTitle("Permiso necesario")
                                .setMessage("Para actualizar la app, activa «Instalar apps "
                                        + "desconocidas». Solo hay que hacerlo una vez.")
                                .setPositiveButton("Ir a Ajustes",
                                        (d, w) -> updater.openInstallPermissionSettings())
                                .setNegativeButton("Ahora no", null)
                                .show();
                    }

                    @Override
                    public void onError(String mensaje, Exception causa) {
                        Toast.makeText(ActualizacionActivity.this, mensaje,
                                Toast.LENGTH_LONG).show();
                    }
                })
                .build();

        // Resultado de la instalación
        UpdateInstallReceiver.setResultListener((exito, mensaje) ->
                runOnUiThread(() -> Toast.makeText(this, mensaje, Toast.LENGTH_LONG).show()));

        updater.check();
    }

    private void mostrarDialogo(UpdateInfo info) {
        AlertDialog.Builder dialogo = new AlertDialog.Builder(this)
                .setTitle("Versión " + info.versionName + " disponible")
                .setMessage(info.changelog.isEmpty()
                        ? "Hay una versión nueva de la aplicación."
                        : info.changelog)
                .setPositiveButton("Actualizar", (d, w) -> updater.downloadAndInstall(info));

        // Una actualización obligatoria no se puede posponer.
        if (info.mandatory) {
            dialogo.setCancelable(false);
        } else {
            dialogo.setNegativeButton("Más tarde", null);
        }
        dialogo.show();
    }

    @Override
    protected void onDestroy() {
        UpdateInstallReceiver.setResultListener(null);
        if (updater != null) {
            updater.shutdown();
        }
        super.onDestroy();
    }
}
