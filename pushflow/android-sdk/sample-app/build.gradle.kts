plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // Descomenta cuando añadas tu google-services.json:
    // id("com.google.gms.google-services")
}

android {
    namespace = "com.pushflow.sample"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pushflow.sample"
        minSdk = 21
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        // Sustituye estos dos valores por los de tu instalación.
        buildConfigField("String", "PUSHFLOW_APP_ID", "\"00000000-0000-0000-0000-000000000000\"")
        buildConfigField("String", "PUSHFLOW_API_URL", "\"https://push.tudominio.com\"")
    }
    buildFeatures { buildConfig = true }
    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(project(":pushflow"))
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
