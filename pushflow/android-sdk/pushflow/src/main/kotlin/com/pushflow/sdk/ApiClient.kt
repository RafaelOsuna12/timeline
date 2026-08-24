package com.pushflow.sdk

import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Cliente HTTP mínimo sobre HttpURLConnection.
 * Evita añadir OkHttp o Retrofit al APK del cliente: el SDK pesa unos pocos KB.
 */
internal object ApiClient {

    private const val TIMEOUT_MS = 15_000

    fun post(url: String, body: JSONObject): JSONObject? = request("POST", url, body)

    fun get(url: String): JSONObject? = request("GET", url, null)

    private fun request(method: String, url: String, body: JSONObject?): JSONObject? {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", "PushFlow-Android/${BuildConfig.SDK_VERSION}")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
            }
            body?.let {
                connection.outputStream.use { output ->
                    output.write(it.toString().toByteArray(Charsets.UTF_8))
                }
            }

            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()

            if (code !in 200..299) {
                Log.w(TAG, "$method $url → HTTP $code ${text.take(200)}")
                return null
            }
            if (text.isBlank()) JSONObject() else JSONObject(text)
        } catch (error: Exception) {
            Log.w(TAG, "$method $url falló: ${error.message}")
            null
        } finally {
            connection?.disconnect()
        }
    }

    private const val TAG = "PushFlow"
}
