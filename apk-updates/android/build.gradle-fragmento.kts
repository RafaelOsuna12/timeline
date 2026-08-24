// Publicación automática al servidor tras compilar el release.
// Añade esto al build.gradle.kts de tu módulo :app.

android {
    defaultConfig {
        versionCode = 14
        versionName = "1.4.0"
    }

    signingConfigs {
        create("release") {
            // El MISMO keystore en todas las versiones. Si cambia, los
            // dispositivos no podrán actualizar y habrá que reinstalar.
            storeFile = file(providers.gradleProperty("KEYSTORE_FILE").get())
            storePassword = providers.gradleProperty("KEYSTORE_PASSWORD").get()
            keyAlias = providers.gradleProperty("KEY_ALIAS").get()
            keyPassword = providers.gradleProperty("KEY_PASSWORD").get()
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

// ./gradlew publicarActualizacion
tasks.register<Exec>("publicarActualizacion") {
    dependsOn("assembleRelease")
    group = "distribution"
    description = "Sube la APK de release al servidor de actualizaciones"

    val apk = layout.buildDirectory.file("outputs/apk/release/app-release.apk")
    val code = android.defaultConfig.versionCode.toString()
    val name = android.defaultConfig.versionName

    commandLine(
        "ssh", "admin@217.77.2.66",
        "sudo bash /opt/apk-updates/publish-apk.sh " +
            "--apk /tmp/app-release.apk " +
            "--version-code $code --version-name $name " +
            "--app-id miapp --base-url https://updates.honorlab.dev/miapp"
    )
    doFirst {
        // Copia el APK antes de publicarlo.
        exec { commandLine("scp", apk.get().asFile.path, "admin@217.77.2.66:/tmp/app-release.apk") }
    }
}
