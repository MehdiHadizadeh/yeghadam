import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
}

// The repository has one version number, in package.json.
val pkg = JsonSlurper().parse(rootDir.resolve("../package.json")) as Map<*, *>
val appVersion = pkg["version"] as String
val (major, minor, patch) = appVersion.split(".").map { it.toInt() }

// Release signing comes from the environment (see .github/workflows/release.yml).
val keystore: String? = System.getenv("YEGHADAM_KEYSTORE")

android {
    namespace = "app.yeghadam"
    compileSdk = 34

    defaultConfig {
        // Kept from the first release so existing installs update in place.
        applicationId = "ir.arzanyab.app"
        minSdk = 24
        targetSdk = 34
        versionCode = major * 10000 + minor * 100 + patch
        versionName = appVersion
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storeType = "pkcs12"
                storePassword = System.getenv("YEGHADAM_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("YEGHADAM_KEY_ALIAS")
                keyPassword = System.getenv("YEGHADAM_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

// The injected script is generated from src/ by scripts/build.js.
val buildScript = tasks.register<Exec>("buildScript") {
    workingDir = rootDir.resolve("..")
    commandLine("node", "scripts/build.js")
}
tasks.named("preBuild") { dependsOn(buildScript) }
