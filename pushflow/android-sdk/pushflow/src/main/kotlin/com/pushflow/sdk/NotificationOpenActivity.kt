package com.pushflow.sdk

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * Actividad trampolín invisible: registra el clic y abre el destino.
 *
 * Destinos admitidos, por orden de prioridad:
 *  1. `pf_url` con esquema propio (deep link: `miapp://pantalla/42`)
 *  2. `pf_url` http(s) → se intenta abrir en la app y, si no, en el navegador
 *  3. `pf_activity` → una actividad concreta de la app
 *  4. Sin destino → se abre la pantalla principal
 */
class NotificationOpenActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val extras = intent.extras
        if (extras == null) { finish(); return }

        val notificationId = extras.getString(EXTRA_NOTIFICATION_ID)
        val deliveryId = extras.getString(EXTRA_DELIVERY_ID)
        val actionId = extras.getString(EXTRA_ACTION_ID)
        val url = extras.getString(EXTRA_URL)
        val androidId = extras.getInt(EXTRA_ANDROID_ID, 0)

        if (PushFlow.ensureInitialized(this)) {
            // El servidor distingue el clic principal del de un botón por `action_id`.
            Analytics.trackNotification(
                type = "clicked",
                notificationId = notificationId,
                deliveryId = deliveryId,
                actionId = actionId,
                url = url)

            val data = mutableMapOf<String, String>()
            notificationId?.let { data["pf_id"] = it }
            url?.let { data["pf_url"] = it }
            actionId?.let { data["pf_action"] = it }
            extras.getString(EXTRA_DATA)?.let { raw ->
                runCatching {
                    val json = JSONObject(raw)
                    json.keys().forEach { key -> data[key] = json.optString(key) }
                }
            }
            PushFlow.notifyOpened(data)
        }

        if (androidId != 0) NotificationManagerCompat.from(this).cancel(androidId)
        launchTarget(url, extras.getString(EXTRA_ACTIVITY))
        finish()
    }

    private fun launchTarget(url: String?, activityName: String?) {
        val target = when {
            !url.isNullOrBlank() -> Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            !activityName.isNullOrBlank() -> runCatching {
                Intent(this, Class.forName(activityName)).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            }.getOrNull() ?: launcherIntent()
            else -> launcherIntent()
        }
        runCatching { startActivity(target) }
            .onFailure {
                Log.w("PushFlow", "no se pudo abrir el destino: ${it.message}")
                launcherIntent()?.let { fallback -> runCatching { startActivity(fallback) } }
            }
    }

    private fun launcherIntent(): Intent? =
        packageManager.getLaunchIntentForPackage(packageName)
            ?.apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP) }

    companion object {
        const val EXTRA_NOTIFICATION_ID = "pf_notification_id"
        const val EXTRA_DELIVERY_ID = "pf_delivery_id"
        const val EXTRA_ACTION_ID = "pf_action_id"
        const val EXTRA_URL = "pf_url"
        const val EXTRA_ANDROID_ID = "pf_android_id"
        const val EXTRA_ACTIVITY = "pf_activity"
        const val EXTRA_DATA = "pf_data"
    }
}
