# R8 is ON for release builds. Debug builds are not minified.

# The page's JS calls AndroidBridge methods BY NAME through addJavascriptInterface
# (platform(), exitApp(), the exo* player calls, hasTouchscreen(), ...). R8 must
# neither rename nor remove them, so the whole class is kept. This is the one
# rule that matters: without it the bridge silently fails in release builds only.
-keep class com.xtivio.iptv.AndroidBridge { *; }
-keepattributes JavascriptInterface
-keepattributes *Annotation*

# The activity, the player controller and its handle interface hold the native
# player wiring the bridge calls into. Kept as before; they are small.
-keep class com.xtivio.iptv.MainActivity { *; }
-keep interface com.xtivio.iptv.ExoControllerHandle { *; }
-keep class com.xtivio.iptv.ExoController { *; }

# Readable Play crash traces: keep file names and line numbers, and upload
# mapping.txt with the release.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Media3 / ExoPlayer ships its own consumer rules. These are compile-time-only
# annotation classes that some dependencies reference and R8 would otherwise warn
# about as missing.
-dontwarn org.checkerframework.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn org.codehaus.mojo.animal_sniffer.**

# Direct-build updater (called from the bridge only; kept so nothing is stripped).
-keep class com.xtivio.iptv.AppUpdater { *; }
