package com.pushflow.sample

import android.app.Application
import android.util.Log
import com.pushflow.sdk.PushFlow

/**
 * Toda la integración cabe en `onCreate`. A partir de aquí el dispositivo queda
 * registrado y las notificaciones se muestran solas.
 */
class SampleApplication : Application() {

    override fun onCreate() {
        super.onCreate()

        PushFlow.defaultChannelName = "Ofertas y novedades"
        PushFlow.init(
            context = this,
            appId = BuildConfig.PUSHFLOW_APP_ID,
            apiUrl = BuildConfig.PUSHFLOW_API_URL,
        )

        // Opcional: reaccionar cuando el usuario abre una notificación.
        PushFlow.setNotificationOpenedHandler { data ->
            Log.i("Sample", "notificación abierta: ${data["pf_url"]}")
        }
    }
}
