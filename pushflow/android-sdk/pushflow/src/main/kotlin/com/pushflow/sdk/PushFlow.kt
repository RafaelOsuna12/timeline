package com.pushflow.sdk

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.TimeZone

/**
 * API pública del SDK de PushFlow para Android.
 *
 * Uso mínimo, en `Application.onCreate()`:
 * ```
 * PushFlow.init(this, appId = "TU-APP-ID", apiUrl = "https://push.tudominio.com")
 * ```
 * A partir de ahí el SDK registra el dispositivo, muestra las notificaciones
 * (con imagen, botones y deep link) y reporta la analítica por su cuenta.
 */
object PushFlow {

    const val VERSION = "1.0.0"
    const val DEFAULT_CHANNEL_ID = "pushflow_default"

    private const val TAG = "PushFlow"

    internal lateinit var appContext: Context
        private set
    internal lateinit var storage: Storage
        private set

    private var initialized = false
    private var openedHandler: ((Map<String, String>) -> Unit)? = null
    private var receivedHandler: ((Map<String, String>) -> Unit)? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    /** Nombre visible del canal de notificaciones por defecto. */
    var defaultChannelName: String = "Notificaciones"

    /** Icono pequeño de la barra de estado. Por defecto, el icono de la app. */
    var smallIconResId: Int = 0

    /** Color de acento de la notificación (ARGB). */
    var accentColor: Int? = null

    // -----------------------------------------------------------------------
    // Inicialización
    // -----------------------------------------------------------------------

    @JvmStatic
    @JvmOverloads
    fun init(context: Context, appId: String, apiUrl: String, autoRegister: Boolean = true) {
        appContext = context.applicationContext
        storage = Storage(appContext)
        storage.appId = appId
        storage.apiUrl = apiUrl.trimEnd('/')
        initialized = true

        createDefaultChannel()
        if (autoRegister) register()
        trackSessionStart()
        Log.i(TAG, "PushFlow $VERSION inicializado (app $appId)")
    }

    /** Pide el token de FCM y da de alta el dispositivo en el servidor. */
    @JvmStatic
    fun register() {
        requireInit()
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token -> onNewToken(token) }
            .addOnFailureListener { error -> Log.w(TAG, "no se pudo obtener el token FCM", error) }
    }

    /** Registra o actualiza la suscripción con el token recibido. */
    internal fun onNewToken(token: String) {
        if (!initialized) return
        storage.fcmToken = token
        scope.launch {
            val body = JSONObject().apply {
                put("app_id", storage.appId)
                put("channel", "android")
                put("fcm_token", token)
                put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}")
                put("device_os", "android")
                put("os_version", Build.VERSION.RELEASE)
                put("sdk_version", VERSION)
                put("app_version", appVersionName())
                put("language", java.util.Locale.getDefault().toLanguageTag().lowercase())
                put("timezone", TimeZone.getDefault().id)
                // getOffset(now) incluye el horario de verano; rawOffset no.
                put("timezone_offset",
                    TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000)
                storage.externalUserId?.let { put("external_user_id", it) }
                if (storage.tags.length() > 0) put("tags", storage.tags)
            }
            val response = ApiClient.post("${storage.apiUrl}/sdk/v1/subscribe", body)
            response?.optString("subscription_id")?.takeIf { it.isNotBlank() }?.let {
                val isFirstRegistration = storage.subscriptionId == null
                storage.subscriptionId = it
                Log.i(TAG, "dispositivo registrado: $it")
                // En el primer arranque la sesión no pudo enviarse: se envía ahora.
                if (isFirstRegistration) trackSessionStart()
            }
        }
    }

    // -----------------------------------------------------------------------
    // Identidad, tags y preferencias
    // -----------------------------------------------------------------------

    /** Asocia este dispositivo a un usuario de tu sistema. */
    @JvmStatic
    fun setExternalUserId(externalUserId: String?) {
        requireInit()
        storage.externalUserId = externalUserId
        patchSubscription(JSONObject().put("external_user_id", externalUserId ?: JSONObject.NULL))
    }

    /** Añade o actualiza un tag. Un valor `null` lo elimina. */
    @JvmStatic
    fun sendTag(key: String, value: String?) = sendTags(mapOf(key to value))

    /** Añade o actualiza varios tags de una vez. */
    @JvmStatic
    fun sendTags(tags: Map<String, String?>) {
        requireInit()
        storage.mergeTags(tags)
        val payload = JSONObject()
        tags.forEach { (key, value) -> payload.put(key, value ?: JSONObject.NULL) }
        patchSubscription(JSONObject().put("tags", payload))
    }

    /** Tags guardados localmente. */
    @JvmStatic
    fun getTags(): Map<String, String> {
        requireInit()
        val tags = storage.tags
        return tags.keys().asSequence().associateWith { tags.optString(it) }
    }

    @JvmStatic
    fun deleteTag(key: String) = sendTags(mapOf(key to null))

    /** Desactiva o reactiva las notificaciones para este dispositivo. */
    @JvmStatic
    fun setSubscription(enabled: Boolean) {
        requireInit()
        storage.optedOut = !enabled
        patchSubscription(JSONObject().put("subscribed", enabled))
    }

    @JvmStatic
    fun isSubscribed(): Boolean =
        initialized && storage.subscriptionId != null && !storage.optedOut

    @JvmStatic
    fun getSubscriptionId(): String? = if (initialized) storage.subscriptionId else null

    /** Marca el dispositivo como usuario de prueba (test_type = 2). */
    @JvmStatic
    fun setTestUser(isTestUser: Boolean) {
        requireInit()
        patchSubscription(JSONObject().put("test_type", if (isTestUser) 2 else JSONObject.NULL))
    }

    // -----------------------------------------------------------------------
    // Analítica
    // -----------------------------------------------------------------------

    /** Registra una conversión atribuible a la última notificación recibida. */
    @JvmStatic
    @JvmOverloads
    fun addOutcome(name: String, value: Double = 1.0) {
        requireInit()
        Analytics.track(JSONObject().apply {
            put("type", "outcome")
            put("name", name)
            put("value", value)
        })
    }

    /** Evento personalizado (puede disparar automatizaciones en el servidor). */
    @JvmStatic
    @JvmOverloads
    fun trackEvent(name: String, properties: Map<String, Any>? = null) {
        requireInit()
        Analytics.track(JSONObject().apply {
            put("type", "custom")
            put("name", name)
            properties?.let { put("properties", JSONObject(it)) }
        })
    }

    internal fun trackSessionStart() {
        val subscriptionId = storage.subscriptionId ?: return
        scope.launch {
            ApiClient.post("${storage.apiUrl}/sdk/v1/session", JSONObject().apply {
                put("app_id", storage.appId)
                put("subscription_id", subscriptionId)
                put("start", true)
            })
        }
    }

    // -----------------------------------------------------------------------
    // Callbacks
    // -----------------------------------------------------------------------

    /** Se invoca cuando el usuario pulsa una notificación. */
    @JvmStatic
    fun setNotificationOpenedHandler(handler: ((Map<String, String>) -> Unit)?) {
        openedHandler = handler
    }

    /** Se invoca al recibir una notificación, antes de mostrarla. */
    @JvmStatic
    fun setNotificationReceivedHandler(handler: ((Map<String, String>) -> Unit)?) {
        receivedHandler = handler
    }

    internal fun notifyOpened(data: Map<String, String>) = openedHandler?.invoke(data)
    internal fun notifyReceived(data: Map<String, String>) = receivedHandler?.invoke(data)

    // -----------------------------------------------------------------------
    // Interno
    // -----------------------------------------------------------------------

    /** Rehidrata la configuración cuando el proceso arranca por un push. */
    internal fun ensureInitialized(context: Context): Boolean {
        if (initialized) return true
        appContext = context.applicationContext
        storage = Storage(appContext)
        initialized = storage.appId != null && storage.apiUrl != null
        return initialized
    }

    private fun patchSubscription(body: JSONObject) {
        val subscriptionId = storage.subscriptionId ?: return
        scope.launch {
            ApiClient.post(
                "${storage.apiUrl}/sdk/v1/subscription/$subscriptionId/update",
                body.put("app_id", storage.appId))
        }
    }

    private fun createDefaultChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = appContext.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(DEFAULT_CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(DEFAULT_CHANNEL_ID, defaultChannelName,
                NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Avisos y novedades"
                enableLights(true)
                enableVibration(true)
            })
    }

    private fun appVersionName(): String = runCatching {
        appContext.packageManager.getPackageInfo(appContext.packageName, 0).versionName ?: "?"
    }.getOrDefault("?")

    internal fun resolveSmallIcon(): Int {
        if (smallIconResId != 0) return smallIconResId
        return runCatching {
            appContext.packageManager.getApplicationInfo(
                appContext.packageName, PackageManager.GET_META_DATA).icon
        }.getOrDefault(android.R.drawable.ic_dialog_info)
    }

    private fun requireInit() {
        check(initialized) { "Llama antes a PushFlow.init(context, appId, apiUrl)" }
    }
}
