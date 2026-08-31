# PushFlow Android SDK

SDK ligero para recibir notificaciones push de PushFlow en una aplicación
Android (APK). Sin OkHttp, sin Retrofit y sin Gson: la única dependencia real
es `firebase-messaging`, el transporte que exige Google.

- **minSdk 21** (Android 5.0) · **compileSdk 35**
- Notificaciones con **título, texto, emojis, imagen grande, icono grande,
  hasta 3 botones y deep link**
- **Analítica completa**: recepción confirmada, clic, clic por botón y descarte
- Tags, `external_user_id`, conversiones y usuarios de prueba

---

## 1. Firebase (solo una vez)

FCM es el único canal por el que Google permite entregar push en Android.

1. Crea un proyecto en <https://console.firebase.google.com>.
2. **Añadir app → Android**, escribe el `applicationId` de tu APK y descarga
   `google-services.json` en la carpeta `app/` de tu proyecto.
3. En **Configuración del proyecto → Cuentas de servicio → Generar nueva clave
   privada**, descarga el JSON y pégalo en el panel de PushFlow
   (*Instalación → App Android → Paso 1*).

## 2. Añade el SDK

```kotlin
// settings.gradle.kts — si usas el módulo directamente
include(":pushflow")
project(":pushflow").projectDir = file("../pushflow-android/pushflow")
```

```kotlin
// build.gradle.kts (módulo :app)
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")   // necesario para google-services.json
}

dependencies {
    implementation(project(":pushflow"))
    // o, si publicas el AAR en tu repositorio Maven:
    // implementation("com.pushflow:pushflow-android:1.0.0")
}
```

Para publicar el AAR en tu Maven local:

```bash
./gradlew :pushflow:publishToMavenLocal
```

## 3. Inicializa

```kotlin
class MiApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        PushFlow.init(
            context = this,
            appId   = "TU-APP-ID",                    // lo ves en Ajustes del panel
            apiUrl  = "https://push.tudominio.com",
        )
    }
}
```

Declara la clase en el manifiesto:

```xml
<application android:name=".MiApplication" …>
```

Eso es todo: el SDK obtiene el token de FCM, registra el dispositivo, muestra
las notificaciones y reporta la analítica.

## 4. Permiso en Android 13+

Desde Android 13 hay que pedir `POST_NOTIFICATIONS` de forma explícita:

```kotlin
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
}
```

## API

```kotlin
// Identidad
PushFlow.setExternalUserId("usuario-123")

// Tags para segmentar (null borra el tag)
PushFlow.sendTag("plan", "pro")
PushFlow.sendTags(mapOf("ciudad" to "CDMX", "nivel" to "12"))
PushFlow.getTags()
PushFlow.deleteTag("nivel")

// Preferencias del usuario
PushFlow.setSubscription(false)     // desactivar sin borrar el historial
PushFlow.isSubscribed()
PushFlow.getSubscriptionId()
PushFlow.setTestUser(true)          // recibirá los envíos de prueba

// Analítica
PushFlow.addOutcome("compra", 49.90)
PushFlow.trackEvent("carrito_abandonado", mapOf("importe" to 120))

// Personalización visual
PushFlow.smallIconResId = R.drawable.ic_notificacion   // icono monocromo 24dp
PushFlow.accentColor = Color.parseColor("#2a78d6")
PushFlow.defaultChannelName = "Ofertas"

// Callbacks
PushFlow.setNotificationOpenedHandler { data -> abrir(data["pf_url"]) }
PushFlow.setNotificationReceivedHandler { data -> Log.d("app", data.toString()) }
```

## Deep links

Al enviar la notificación, el campo **Deep link (APK)** admite un esquema
propio. Declara el filtro en tu actividad:

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="miapp" />
</intent-filter>
```

Con `miapp://producto/42` la app se abre directamente en esa pantalla; el clic
queda registrado en la analítica antes de abrirla.

## Cómo funciona por dentro

El servidor envía mensajes **data-only** a FCM. El sistema no los muestra por su
cuenta: los entrega a `PushFlowMessagingService`, que construye la notificación.
Esto permite tres cosas que los mensajes `notification` de FCM no dan:

1. Registrar la **recepción real** en el dispositivo (tasa de entrega verdadera).
2. Descargar y mostrar la **imagen grande** y los **botones**.
3. Interceptar el clic para **atribuir conversiones** antes de abrir la pantalla.

## App de ejemplo

`sample-app/` es una aplicación completa y funcional. Para probarla, pon tu
`appId` y `apiUrl` en `sample-app/build.gradle.kts`, añade tu
`google-services.json` y descomenta el plugin `com.google.gms.google-services`.

```bash
./gradlew :sample-app:installDebug
```
