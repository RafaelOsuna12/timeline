package com.pushflow.sdk

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import java.net.URL
import kotlin.math.absoluteValue

/**
 * Construye y muestra la notificación a partir del payload de PushFlow.
 * Soporta: título, texto, emojis, subtítulo, imagen grande, icono grande,
 * hasta 3 botones, deep link, canal, color, vibración y agrupación.
 */
internal object NotificationPresenter {

    private const val TAG = "PushFlow"
    private val scope = CoroutineScope(Dispatchers.IO)

    fun show(context: Context, data: Map<String, String>) {
        scope.launch {
            runCatching { build(context, data) }
                .onFailure { Log.e(TAG, "no se pudo mostrar la notificación", it) }
        }
    }

    private fun build(context: Context, data: Map<String, String>) {
        val notificationId = data["pf_id"] ?: return
        val channelId = data["pf_channel"] ?: PushFlow.DEFAULT_CHANNEL_ID
        ensureChannel(context, channelId)

        val androidId = notificationId.hashCode().absoluteValue
        val title = data["pf_title"].orEmpty()
        val body = data["pf_body"].orEmpty()

        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(PushFlow.resolveSmallIcon())
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setContentIntent(openIntent(context, data, androidId, actionId = null))
            .setDeleteIntent(dismissIntent(context, data, androidId))

        data["pf_subtitle"]?.let { builder.setSubText(it) }
        data["pf_group"]?.let { builder.setGroup(it) }
        data["pf_collapse"]?.let { builder.setGroup(it) }
        data["pf_visibility"]?.toIntOrNull()?.let { builder.setVisibility(it) }

        (data["pf_color"] ?: PushFlow.accentColor?.let { String.format("#%06X", 0xFFFFFF and it) })
            ?.let { color -> runCatching { builder.setColor(Color.parseColor(color)) } }

        data["pf_vibrate"]?.let { pattern ->
            val values = pattern.split(",").mapNotNull { it.trim().toLongOrNull() }
            if (values.isNotEmpty()) builder.setVibrate(values.toLongArray())
        }

        // Icono grande (avatar / logo) e imagen grande (big picture).
        data["pf_large_icon"]?.let { url -> downloadBitmap(url)?.let { builder.setLargeIcon(it) } }
        val bigPicture = data["pf_image"]?.let { downloadBitmap(it) }
        if (bigPicture != null) {
            builder.setStyle(
                NotificationCompat.BigPictureStyle()
                    .bigPicture(bigPicture)
                    .setBigContentTitle(title)
                    .setSummaryText(body)
                    .also { style ->
                        // Al desplegar, la imagen sustituye al icono grande.
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) style.bigLargeIcon(null as Bitmap?)
                    })
        } else if (body.length > 45) {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(body))
        }

        // Botones de acción (máximo 3, como en la mayoría de lanzadores).
        data["pf_buttons"]?.let { raw ->
            runCatching {
                val buttons = JSONArray(raw)
                for (index in 0 until minOf(buttons.length(), 3)) {
                    val button = buttons.getJSONObject(index)
                    val actionId = button.optString("id", "btn$index")
                    builder.addAction(
                        0,
                        button.optString("text"),
                        openIntent(context, data, androidId, actionId,
                            overrideUrl = button.optString("url").takeIf { it.isNotBlank() }))
                }
            }.onFailure { Log.w(TAG, "botones con formato inválido: ${it.message}") }
        }

        if (!hasPermission(context)) {
            Log.w(TAG, "falta el permiso POST_NOTIFICATIONS: la notificación no se mostrará")
            return
        }
        NotificationManagerCompat.from(context).notify(androidId, builder.build())
    }

    /** Intent que abre la app registrando el clic (trampolín). */
    private fun openIntent(
        context: Context,
        data: Map<String, String>,
        androidId: Int,
        actionId: String?,
        overrideUrl: String? = null,
    ): PendingIntent {
        val intent = Intent(context, NotificationOpenActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(NotificationOpenActivity.EXTRA_NOTIFICATION_ID, data["pf_id"])
            putExtra(NotificationOpenActivity.EXTRA_DELIVERY_ID, data["pf_delivery"])
            putExtra(NotificationOpenActivity.EXTRA_URL, overrideUrl ?: data["pf_url"])
            putExtra(NotificationOpenActivity.EXTRA_ACTION_ID, actionId)
            putExtra(NotificationOpenActivity.EXTRA_ANDROID_ID, androidId)
            putExtra(NotificationOpenActivity.EXTRA_ACTIVITY, data["pf_activity"])
            putExtra(NotificationOpenActivity.EXTRA_DATA, data["pf_data"])
            // Un requestCode distinto por acción evita que se reutilice el PendingIntent.
            action = "pushflow.open.${data["pf_id"]}.${actionId ?: "main"}"
        }
        return PendingIntent.getActivity(
            context, (androidId + (actionId?.hashCode() ?: 0)), intent, flags())
    }

    private fun dismissIntent(context: Context, data: Map<String, String>, androidId: Int): PendingIntent {
        val intent = Intent(context, NotificationActionReceiver::class.java).apply {
            action = NotificationActionReceiver.ACTION_DISMISS
            putExtra(NotificationOpenActivity.EXTRA_NOTIFICATION_ID, data["pf_id"])
            putExtra(NotificationOpenActivity.EXTRA_DELIVERY_ID, data["pf_delivery"])
        }
        return PendingIntent.getBroadcast(context, androidId + 99_000, intent, flags())
    }

    private fun flags(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }

    private fun downloadBitmap(url: String): Bitmap? = runCatching {
        URL(url).openStream().use { BitmapFactory.decodeStream(it) }
    }.onFailure { Log.w(TAG, "no se pudo descargar la imagen $url") }.getOrNull()

    private fun ensureChannel(context: Context, channelId: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(channelId) != null) return
        manager.createNotificationChannel(
            android.app.NotificationChannel(channelId, channelId,
                NotificationManager.IMPORTANCE_HIGH))
    }

    private fun hasPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            NotificationManagerCompat.from(context).areNotificationsEnabled()
}
