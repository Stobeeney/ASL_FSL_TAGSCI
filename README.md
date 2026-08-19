# EchoLink — ASL / FSL Recognition App

EchoLink is a futuristic ASL / FSL sign language recognition mobile application with real-time interpretation.

## 🛠 Tech Stack (APK)
- **Framework:** Capacitor JS
- **Frontend UI:** HTML5, CSS3, Vanilla JavaScript
- **Computer Vision:** Google MediaPipe (Hand & Face Tracking)
- **Machine Learning (Classification):** K-Nearest Neighbors (KNN) algorithm running offline
- **Natural Language Processing (AI):** Google Gemini 1.5 Flash (Meaning-Based Translation & Auto-Correction)
- **Text-to-Speech:** Capacitor Native Community TTS Plugin
- **Local Database:** IndexedDB (for massive dataset storage)
- **Build Tool:** Gradle (Java 21) via Android Studio

## 🚀 How to Run the APK (Build from source)

If you are a developer and want to build the APK from the source code, follow these steps:

1. Navigate to the mobile app directory:
   ```bash
   cd mobile_app
   ```
2. Install NodeJS dependencies:
   ```bash
   npm install
   ```
3. Sync the web assets into the Android native folder:
   ```bash
   npx cap sync android
   ```
4. Set your Java Environment (requires Java 21) and compile the debug APK:
   ```bash
   export JAVA_HOME=$HOME/.jdks/jbr-21.0.11
   cd android
   ./gradlew assembleDebug
   ```

The compiled application will be generated at:
`mobile_app/android/app/build/outputs/apk/debug/app-debug.apk`

## 📱 How to Install the APK on your Phone

1. Transfer the `app-debug.apk` file to your Android phone (via USB, Google Drive, Bluetooth, or Email).
2. Open the **File Manager** on your phone and locate the downloaded `.apk` file.
3. Tap the file to install it.
4. *Note:* If your phone shows a "Install unknown apps" warning, tap **Settings** and toggle **"Allow from this source"**.
5. Once installed, open the **EchoLink** app.
6. Make sure to provide Camera permissions when prompted for the hand-tracking to work!
7. *(Optional)* Paste your Gemini API key in the AI panel to enable the Meaning-Based AI translations.
