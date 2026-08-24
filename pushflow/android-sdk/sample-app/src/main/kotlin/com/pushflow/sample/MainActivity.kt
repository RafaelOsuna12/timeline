package com.pushflow.sample

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.pushflow.sdk.PushFlow

/** Pantalla de ejemplo: permiso, identidad, tags y conversiones. */
class MainActivity : AppCompatActivity() {

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()) { granted ->
        Toast.makeText(this,
            if (granted) "Notificaciones activadas" else "Permiso denegado",
            Toast.LENGTH_SHORT).show()
        refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        askNotificationPermission()

        findViewById<TextView>(R.id.btn_identify).setOnClickListener {
            PushFlow.setExternalUserId("usuario-demo-42")
            Toast.makeText(this, "Usuario identificado", Toast.LENGTH_SHORT).show()
        }
        findViewById<TextView>(R.id.btn_tag).setOnClickListener {
            PushFlow.sendTags(mapOf("plan" to "pro", "ciudad" to "CDMX"))
            Toast.makeText(this, "Tags enviados", Toast.LENGTH_SHORT).show()
        }
        findViewById<TextView>(R.id.btn_outcome).setOnClickListener {
            PushFlow.addOutcome("compra", 49.90)
            Toast.makeText(this, "Conversión registrada", Toast.LENGTH_SHORT).show()
        }
        findViewById<TextView>(R.id.btn_test).setOnClickListener {
            PushFlow.setTestUser(true)
            Toast.makeText(this, "Marcado como dispositivo de prueba", Toast.LENGTH_SHORT).show()
        }

        // Si la app se abrió desde un deep link (miapp://…), lo mostramos.
        intent?.data?.let {
            Toast.makeText(this, "Abierto desde: $it", Toast.LENGTH_LONG).show()
        }
        refresh()
    }

    private fun refresh() {
        findViewById<TextView>(R.id.status).text = buildString {
            append("Suscripción: ")
            append(PushFlow.getSubscriptionId() ?: "(registrando…)")
            append("\nActivo: ")
            append(if (PushFlow.isSubscribed()) "sí" else "no")
        }
    }

    /** Android 13+ requiere pedir POST_NOTIFICATIONS de forma explícita. */
    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
        if (granted != PackageManager.PERMISSION_GRANTED) {
            requestPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
