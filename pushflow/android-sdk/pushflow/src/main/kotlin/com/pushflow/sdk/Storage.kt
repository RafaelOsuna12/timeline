package com.pushflow.sdk

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/** Estado local del dispositivo: id de suscripción, token FCM, tags y usuario. */
internal class Storage(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("pushflow", Context.MODE_PRIVATE)

    var subscriptionId: String?
        get() = prefs.getString(KEY_SUBSCRIPTION, null)
        set(value) = prefs.edit().putString(KEY_SUBSCRIPTION, value).apply()

    var fcmToken: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var externalUserId: String?
        get() = prefs.getString(KEY_EXTERNAL_ID, null)
        set(value) = prefs.edit().putString(KEY_EXTERNAL_ID, value).apply()

    var optedOut: Boolean
        get() = prefs.getBoolean(KEY_OPTED_OUT, false)
        set(value) = prefs.edit().putBoolean(KEY_OPTED_OUT, value).apply()

    /** Configuración persistida para que los servicios en segundo plano funcionen tras un reinicio. */
    var appId: String?
        get() = prefs.getString(KEY_APP_ID, null)
        set(value) = prefs.edit().putString(KEY_APP_ID, value).apply()

    var apiUrl: String?
        get() = prefs.getString(KEY_API_URL, null)
        set(value) = prefs.edit().putString(KEY_API_URL, value).apply()

    var tags: JSONObject
        get() = runCatching { JSONObject(prefs.getString(KEY_TAGS, "{}") ?: "{}") }
            .getOrDefault(JSONObject())
        set(value) = prefs.edit().putString(KEY_TAGS, value.toString()).apply()

    fun mergeTags(newTags: Map<String, String?>): JSONObject {
        val current = tags
        newTags.forEach { (key, value) ->
            if (value == null) current.remove(key) else current.put(key, value)
        }
        tags = current
        return current
    }

    private companion object {
        const val KEY_SUBSCRIPTION = "subscription_id"
        const val KEY_TOKEN = "fcm_token"
        const val KEY_EXTERNAL_ID = "external_user_id"
        const val KEY_OPTED_OUT = "opted_out"
        const val KEY_APP_ID = "app_id"
        const val KEY_API_URL = "api_url"
        const val KEY_TAGS = "tags"
    }
}
