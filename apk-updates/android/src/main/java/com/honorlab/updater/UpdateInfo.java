package com.honorlab.updater;

import org.json.JSONException;
import org.json.JSONObject;

/** Contenido de latest.json. */
public final class UpdateInfo {

    public final long versionCode;
    public final String versionName;
    public final String url;
    public final String sha256;
    public final long sizeBytes;
    public final int minSdk;
    public final boolean mandatory;
    public final String changelog;
    public final String releasedAt;

    private UpdateInfo(long versionCode, String versionName, String url, String sha256,
                       long sizeBytes, int minSdk, boolean mandatory,
                       String changelog, String releasedAt) {
        this.versionCode = versionCode;
        this.versionName = versionName;
        this.url = url;
        this.sha256 = sha256;
        this.sizeBytes = sizeBytes;
        this.minSdk = minSdk;
        this.mandatory = mandatory;
        this.changelog = changelog;
        this.releasedAt = releasedAt;
    }

    /** Analiza el manifiesto y rechaza lo que no sirva para instalar. */
    public static UpdateInfo fromJson(String body) throws JSONException {
        JSONObject json = new JSONObject(body);

        long versionCode = json.getLong("versionCode");
        String url = json.getString("url");
        String sha256 = json.optString("sha256", "");

        if (versionCode <= 0) {
            throw new JSONException("versionCode inválido: " + versionCode);
        }
        // Solo HTTPS: un APK por HTTP admite manipulación en tránsito.
        if (!url.startsWith("https://")) {
            throw new JSONException("La URL del APK debe ser https, no: " + url);
        }
        // Sin hash no hay forma de saber si lo descargado es lo publicado.
        if (sha256.length() != 64) {
            throw new JSONException("El manifiesto no trae un sha256 de 64 caracteres");
        }

        return new UpdateInfo(
                versionCode,
                json.optString("versionName", String.valueOf(versionCode)),
                url,
                sha256.toLowerCase(),
                json.optLong("sizeBytes", 0L),
                json.optInt("minSdk", 0),
                json.optBoolean("mandatory", false),
                json.optString("changelog", ""),
                json.optString("releasedAt", ""));
    }

    /** Nombre del fichero local, con el versionCode para no mezclar descargas. */
    public String fileName(String appId) {
        return appId + "-" + versionCode + ".apk";
    }

    @Override
    public String toString() {
        return "UpdateInfo{" + versionName + " (code " + versionCode + ")}";
    }
}
