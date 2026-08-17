import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLatestDependencyPolicy } from './latest-dependency-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await runLatestDependencyPolicy(root, {
  pnpm: {
    overrideFiles: ['pnpm-workspace.yaml'],
  },
  node: {
    installScript: 'scripts/install-current-node.sh',
    packageFiles: [
      'package.json',
      'apps/control-plane/package.json',
      'apps/engine/package.json',
    ],
    dockerFiles: [
      'apps/control-plane/Dockerfile',
      'apps/engine/Dockerfile',
      'infra/Caddy.Dockerfile',
    ],
    chainguardBuildFiles: [
      'apps/control-plane/Dockerfile',
      'apps/engine/Dockerfile',
      'infra/Caddy.Dockerfile',
    ],
    chainguardRuntimeFiles: [
      'apps/control-plane/Dockerfile',
      'apps/engine/Dockerfile',
    ],
  },
  publicImages: {
    postgresFiles: ['docker-compose.yml'],
    greenmailFiles: [
      'apps/control-plane/src/email-otp/watcher.greenmail.test.ts',
    ],
  },
  dockerfileFrontend: {
    files: [
      'apps/control-plane/Dockerfile',
      'apps/engine/Dockerfile',
      'infra/Caddy.Dockerfile',
    ],
  },
  chrome: {
    files: ['apps/engine/Dockerfile'],
  },
  rust: {
    files: ['apps/engine/Dockerfile'],
  },
  rav1e: {
    files: ['apps/engine/Dockerfile'],
    lockFile: 'apps/engine/rav1e/Cargo.lock',
    pasteyPatchCommit: 'c247d53ae43dd1312dbd90117c45e4c0ee6b06ce',
  },
  wolfi: {
    architecture: 'x86_64',
    groups: [
      {
        file: 'apps/control-plane/Dockerfile',
        packages: [],
      },
      {
        file: 'apps/engine/Dockerfile',
        packages: [
          'build-base',
          'cargo-c',
          'font-liberation',
          'font-noto-cjk',
          'font-noto-emoji',
          'font-opensans',
          'fontconfig',
          'git',
          'gtk-3',
          'icu-data-full',
          'libnss',
          'libudev',
          'mesa',
          'mesa-glx',
          'nasm',
          'nss',
          'pax-utils',
          'xdg-utils',
          'xz',
        ],
      },
      {
        file: 'infra/Caddy.Dockerfile',
        packages: [],
      },
    ],
  },
  go: {
    files: ['infra/Caddy.Dockerfile'],
  },
  caddy: {
    files: ['infra/Caddy.Dockerfile'],
    runtimeFiles: [
      'e2e/run-e2e-web.mjs',
      'e2e/run-e2e-tunnel-caddy.mjs',
    ],
  },
  python: {
    versionFile: '.python-version',
    pyproject: 'packages/sdk-py/pyproject.toml',
  },
  flutter: {
    pubspec: 'companion/pubspec.yaml',
    vendorOverrides: [
      {
        name: 'flutter_secure_storage',
        manifest: 'companion/vendor/flutter_secure_storage/pubspec.yaml',
        overridePath: 'vendor/flutter_secure_storage',
      },
      {
        name: 'jni',
        manifest: 'companion/vendor/jni/pubspec.yaml',
        overridePath: 'vendor/jni',
      },
      {
        name: 'jni_flutter',
        manifest: 'companion/vendor/jni_flutter/pubspec.yaml',
        overridePath: 'vendor/jni_flutter',
      },
      {
        name: 'mobile_scanner',
        manifest: 'companion/vendor/mobile_scanner/pubspec.yaml',
        overridePath: 'vendor/mobile_scanner',
      },
      {
        name: 'shared_preferences_android',
        manifest: 'companion/vendor/shared_preferences_android/pubspec.yaml',
        overridePath: 'vendor/shared_preferences_android',
      },
    ],
  },
  android: {
    wrapper: 'companion/android/gradle/wrapper/gradle-wrapper.properties',
    builtInKotlin: {
      properties: 'companion/android/gradle.properties',
      buildFiles: [
        'companion/android/settings.gradle.kts',
        'companion/android/app/build.gradle.kts',
        'companion/vendor/flutter_secure_storage/android/build.gradle',
        'companion/vendor/jni/android/build.gradle',
        'companion/vendor/jni_flutter/android/build.gradle',
        'companion/vendor/mobile_scanner/android/build.gradle',
        'companion/vendor/shared_preferences_android/android/build.gradle.kts',
      ],
    },
    maven: [
      {
        name: 'Android Gradle Plugin',
        metadata: 'https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml',
        files: ['companion/android/settings.gradle.kts'],
        reference: (version) => `id("com.android.application") version "${version}"`,
      },
      {
        name: 'OkHttp',
        metadata: 'https://repo1.maven.org/maven2/com/squareup/okhttp3/okhttp/maven-metadata.xml',
        files: ['companion/android/app/build.gradle.kts'],
        reference: (version) => `implementation("com.squareup.okhttp3:okhttp:${version}")`,
      },
      {
        name: 'AndroidX AppCompat',
        metadata: 'https://dl.google.com/dl/android/maven2/androidx/appcompat/appcompat/maven-metadata.xml',
        files: ['companion/android/app/build.gradle.kts'],
        reference: (version) => `implementation("androidx.appcompat:appcompat:${version}")`,
      },
      {
        name: 'JUnit',
        metadata: 'https://repo1.maven.org/maven2/junit/junit/maven-metadata.xml',
        files: ['companion/android/app/build.gradle.kts'],
        reference: (version) => `testImplementation("junit:junit:${version}")`,
      },
      {
        name: 'JSON-java',
        metadata: 'https://repo1.maven.org/maven2/org/json/json/maven-metadata.xml',
        files: ['companion/android/app/build.gradle.kts'],
        reference: (version) => `testImplementation("org.json:json:${version}")`,
      },
    ],
  },
  java: {
    versionFile: '.java-version',
  },
  osv: {
    version: 'v2.5.1',
  },
});
