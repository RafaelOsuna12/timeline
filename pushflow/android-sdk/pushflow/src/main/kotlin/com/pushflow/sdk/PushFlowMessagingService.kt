package com.pushflow.sdk

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Recibe los mensajes de FCM.
 *
 * El servidor envía mensajes *data-only* para que sea el SDK quien construya la
 * notificación. Así se pueden mostrar imágenes grandes, botones y deep links,
 * y además se puede registrar la recepción real en la analítica (algo imposible
 * con los mensajes `notification` que gestiona el propio sistema).
 */
class PushFlowMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        if (!PushFlow.ensureInitialized(this)) return
        Log.i(TAG, "token de FCM renovado")
        PushFlow.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (!data.containsKey("pf_id")) {
            // No es un mensaje de PushFlow: lo dejamos pasar por si la app lo gestiona.
            super.onMessageReceived(message)
            return
        }
        if (!PushFlow.ensureInitialized(this)) {
            Log.w(TAG, "mensaje recibido pero el SDK no está configurado")
            return
        }
        if (PushFlow.storage.optedOut) return

        PushFlow.notifyReceived(data)

        // Recepción confirmada: alimenta la tasa de entrega real del panel.
        Analytics.trackNotification("displayed", data["pf_id"], data["pf_delivery"])

        NotificationPresenter.show(applicationContext, data)
    }

    private companion object { const val TAG = "PushFlow" }
}
