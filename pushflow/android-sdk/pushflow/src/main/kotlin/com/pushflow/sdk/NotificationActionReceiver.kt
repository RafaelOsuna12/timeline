package com.pushflow.sdk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Registra los descartes de notificación (deslizar para cerrar). */
class NotificationActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DISMISS) return
        if (!PushFlow.ensureInitialized(context)) return
        Analytics.trackNotification(
            type = "dismissed",
            notificationId = intent.getStringExtra(NotificationOpenActivity.EXTRA_NOTIFICATION_ID),
            deliveryId = intent.getStringExtra(NotificationOpenActivity.EXTRA_DELIVERY_ID))
    }

    companion object {
        const val ACTION_DISMISS = "com.pushflow.sdk.DISMISS"
    }
}
