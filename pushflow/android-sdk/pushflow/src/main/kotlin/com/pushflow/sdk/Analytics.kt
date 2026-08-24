package com.pushflow.sdk

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Envío de eventos de analítica al servidor (recepción, clic, descarte, outcomes). */
internal object Analytics {

    private val scope = CoroutineScope(Dispatchers.IO)

    /** Añade `app_id` y `subscription_id` y envía el evento sin bloquear. */
    fun track(event: JSONObject) {
        val storage = PushFlow.storage
        val apiUrl = storage.apiUrl ?: return
        scope.launch {
            val body = event
                .put("app_id", storage.appId)
                .put("channel", "android")
            storage.subscriptionId?.let { body.put("subscription_id", it) }
            ApiClient.post("$apiUrl/api/v1/events", body)
        }
    }

    /** Eventos originados por una notificación concreta. */
    fun trackNotification(
        type: String,
        notificationId: String?,
        deliveryId: String? = null,
        actionId: String? = null,
        url: String? = null,
    ) {
        if (notificationId.isNullOrBlank()) return
        track(JSONObject().apply {
            put("type", type)
            put("notification_id", notificationId)
            deliveryId?.let { put("delivery_id", it) }
            actionId?.let { put("action_id", it) }
            url?.let { put("url", it) }
        })
    }
}
