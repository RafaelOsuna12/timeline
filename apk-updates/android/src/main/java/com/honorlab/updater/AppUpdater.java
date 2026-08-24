package com.honorlab.updater;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Actualizador de APK para apps distribuidas fuera de Google Play.
 *
 * Flujo: consulta el manifiesto → compara versionCode → descarga el APK →
 * verifica el SHA-256 → instala con PackageInstaller.
 *
 * Uso:
 * <pre>
 * AppUpdater updater = new AppUpdater.Builder(this)
 *         .manifestUrl("https://updates.honorlab.dev/miapp/latest.json")
 *         .appId("miapp")
 *         .listener(miListener)
 *         .build();
 * updater.check();
 * </pre>
 *
 * En un teléfono normal Android exige confirmación del usuario en cada
 * instalación. No se puede evitar sin ser propietario del dispositivo.
 */
public final class AppUpdater {

    private static final String TAG = "AppUpdater";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    private static final int BUFFER_SIZE = 64 * 1024;

    /** Eventos del proceso. Todos llegan en el hilo principal. */
    public interface Listener {
        /** Ya está en la última versión. */
        default void onUpToDate(long currentVersionCode) { }

        /** Hay una versión nueva. Aquí decides si pides confirmación o descargas. */
        void onUpdateAvailable(UpdateInfo info);

        /** Progreso de descarga. */
        default void onProgress(int percent, long downloadedBytes, long totalBytes) { }

        /** APK descargado y verificado; a punto de lanzarse el instalador. */
        default void onReadyToInstall(File apk) { }

        /** Falta el permiso «instalar apps desconocidas». */
        default void onPermissionRequired() { }

        void onError(String message, Exception cause);
    }

    private final Context context;
    private final String manifestUrl;
    private final String appId;
    private final Listener listener;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private AppUpdater(Builder builder) {
        this.context = builder.context.getApplicationContext();
        this.manifestUrl = builder.manifestUrl;
        this.appId = builder.appId;
        this.listener = builder.listener;
    }

    public static final class Builder {
        private final Context context;
        private String manifestUrl;
        private String appId = "app";
        private Listener listener;

        public Builder(Context context) {
            this.context = context;
        }

        public Builder manifestUrl(String value) { this.manifestUrl = value; return this; }
        public Builder appId(String value) { this.appId = value; return this; }
        public Builder listener(Listener value) { this.listener = value; return this; }

        public AppUpdater build() {
            if (manifestUrl == null || !manifestUrl.startsWith("https://")) {
                throw new IllegalArgumentException("manifestUrl debe ser una URL https");
            }
            if (listener == null) {
                throw new IllegalArgumentException("Falta el listener");
            }
            return new AppUpdater(this);
        }
    }

    // -----------------------------------------------------------------------
    // 1. Comprobar
    // -----------------------------------------------------------------------

    /** Descarga el manifiesto y compara con la versión instalada. */
    public void check() {
        executor.execute(() -> {
            try {
                String body = httpGet(manifestUrl);
                UpdateInfo info = UpdateInfo.fromJson(body);
                long current = currentVersionCode(context);

                if (info.minSdk > Build.VERSION.SDK_INT) {
                    post(() -> listener.onError(
                            "La versión " + info.versionName + " requiere Android API "
                                    + info.minSdk + " y este dispositivo tiene "
                                    + Build.VERSION.SDK_INT, null));
                    return;
                }
                if (info.versionCode <= current) {
                    post(() -> listener.onUpToDate(current));
                    return;
                }
                post(() -> listener.onUpdateAvailable(info));
            } catch (Exception error) {
                Log.w(TAG, "No se pudo comprobar la actualización", error);
                post(() -> listener.onError("No se pudo comprobar si hay actualizaciones", error));
            }
        });
    }

    // -----------------------------------------------------------------------
    // 2. Descargar y verificar
    // -----------------------------------------------------------------------

    /** Descarga el APK, comprueba su hash y lanza el instalador. */
    public void downloadAndInstall(UpdateInfo info) {
        executor.execute(() -> {
            File target = new File(downloadDir(), info.fileName(appId));
            try {
                // Si ya se descargó antes y el hash cuadra, no se vuelve a bajar.
                if (target.exists() && info.sha256.equals(sha256Of(target))) {
                    Log.i(TAG, "El APK ya estaba descargado y verificado");
                } else {
                    download(info, target);
                    String actual = sha256Of(target);
                    if (!info.sha256.equals(actual)) {
                        // Descarga corrupta, truncada o manipulada: no se instala.
                        boolean ignored = target.delete();
                        post(() -> listener.onError(
                                "La descarga no coincide con la firma publicada; se ha descartado",
                                null));
                        return;
                    }
                }
                cleanOldDownloads(target);

                post(() -> {
                    listener.onReadyToInstall(target);
                    install(target);
                });
            } catch (Exception error) {
                Log.w(TAG, "Fallo al descargar la actualización", error);
                if (target.exists()) {
                    boolean ignored = target.delete();
                }
                post(() -> listener.onError("No se pudo descargar la actualización", error));
            }
        });
    }

    private void download(UpdateInfo info, File target) throws IOException {
        HttpURLConnection connection = open(info.url);
        try {
            int code = connection.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new IOException("El servidor respondió " + code + " al pedir el APK");
            }
            long total = connection.getContentLengthLong();
            if (total <= 0) {
                total = info.sizeBytes;
            }

            File partial = new File(target.getPath() + ".part");
            try (InputStream in = new BufferedInputStream(connection.getInputStream());
                 OutputStream out = new FileOutputStream(partial)) {

                byte[] buffer = new byte[BUFFER_SIZE];
                long downloaded = 0;
                int lastPercent = -1;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    downloaded += read;

                    if (total > 0) {
                        int percent = (int) (downloaded * 100 / total);
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            final int p = percent;
                            final long d = downloaded, t = total;
                            post(() -> listener.onProgress(p, d, t));
                        }
                    }
                }
                out.flush();
            }
            // Renombrado al final: nunca queda un fichero a medias con el nombre bueno.
            if (!partial.renameTo(target)) {
                throw new IOException("No se pudo mover el fichero descargado");
            }
        } finally {
            connection.disconnect();
        }
    }

    // -----------------------------------------------------------------------
    // 3. Instalar
    // -----------------------------------------------------------------------

    /** Lanza la instalación. Requiere el permiso de orígenes desconocidos. */
    public void install(File apk) {
        if (!canInstallPackages()) {
            listener.onPermissionRequired();
            return;
        }
        try {
            PackageInstaller installer = context.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                    PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(context.getPackageName());

            int sessionId = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                try (InputStream in = new FileInputStream(apk);
                     OutputStream out = session.openWrite("update", 0, apk.length())) {
                    byte[] buffer = new byte[BUFFER_SIZE];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                    }
                    session.fsync(out);
                }

                Intent intent = new Intent(context, UpdateInstallReceiver.class)
                        .setAction(UpdateInstallReceiver.ACTION);
                // FLAG_MUTABLE es obligatorio: el sistema añade extras al intent.
                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    flags |= PendingIntent.FLAG_MUTABLE;
                }
                PendingIntent pending = PendingIntent.getBroadcast(
                        context, sessionId, intent, flags);
                session.commit(pending.getIntentSender());
            }
        } catch (Exception error) {
            Log.e(TAG, "No se pudo iniciar la instalación", error);
            listener.onError("No se pudo iniciar la instalación", error);
        }
    }

    /** ¿El usuario nos ha dado permiso para instalar aplicaciones? */
    public boolean canInstallPackages() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return true;
        }
        return context.getPackageManager().canRequestPackageInstalls();
    }

    /**
     * Abre los ajustes donde el usuario concede ese permiso.
     * Solo hay que hacerlo una vez por instalación de la app.
     */
    public void openInstallPermissionSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + context.getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    // -----------------------------------------------------------------------
    // Utilidades
    // -----------------------------------------------------------------------

    /** versionCode de la app instalada. */
    public static long currentVersionCode(Context context) {
        try {
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return info.getLongVersionCode();
            }
            return info.versionCode;
        } catch (PackageManager.NameNotFoundException error) {
            return 0L;
        }
    }

    public static String currentVersionName(Context context) {
        try {
            String name = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).versionName;
            return name != null ? name : "";
        } catch (PackageManager.NameNotFoundException error) {
            return "";
        }
    }

    /** Carpeta propia de la app: no necesita permisos de almacenamiento. */
    private File downloadDir() {
        File dir = new File(context.getExternalFilesDir(null), "updates");
        if (!dir.exists()) {
            boolean ignored = dir.mkdirs();
        }
        return dir;
    }

    /** Borra descargas de versiones anteriores para no acumular APK. */
    private void cleanOldDownloads(File keep) {
        File[] files = downloadDir().listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            if (!file.equals(keep) && file.getName().endsWith(".apk")) {
                boolean ignored = file.delete();
            }
        }
    }

    private static String sha256Of(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = in.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte b : digest.digest()) {
            hex.append(Character.forDigit((b >> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        return hex.toString();
    }

    private String httpGet(String url) throws IOException {
        HttpURLConnection connection = open(url);
        try {
            int code = connection.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new IOException("El servidor respondió " + code);
            }
            try (InputStream in = new BufferedInputStream(connection.getInputStream())) {
                java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int read;
                while ((read = in.read(chunk)) != -1) {
                    buffer.write(chunk, 0, read);
                    if (buffer.size() > 512 * 1024) {
                        throw new IOException("El manifiesto es sospechosamente grande");
                    }
                }
                return buffer.toString("UTF-8");
            }
        } finally {
            connection.disconnect();
        }
    }

    private HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestProperty("Accept-Encoding", "identity"); // no romper Content-Length
        connection.setInstanceFollowRedirects(true);
        return connection;
    }

    private void post(Runnable action) {
        main.post(action);
    }

    /** Libera el hilo de trabajo. Llámalo si el actualizador ya no se va a usar. */
    public void shutdown() {
        executor.shutdown();
    }
}
