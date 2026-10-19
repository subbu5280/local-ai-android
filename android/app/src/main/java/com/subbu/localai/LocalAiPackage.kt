package com.subbu.localai

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers the app's own native modules: AiStoreModule (the chat database on Android's built-in SQLite) and
 *  AiDeviceModule (network state before a model download), AiDocsModule (document picker and text extraction)
 * , AiWorkspaceModule (project workspaces for the coding assistant, M7)
 *  AiCryptoModule (encrypted backups, M8), AiLocationModule (approximate location for weather) and VoiceModule
 *  (speech in and out with Android's own engines), both from the original app. */
class LocalAiPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AiStoreModule(ctx), AiDeviceModule(ctx), AiDocsModule(ctx), AiWorkspaceModule(ctx), AiCryptoModule(ctx), AiLocationModule(ctx), VoiceModule(ctx), AiOcrModule(ctx), AiScheduleModule(ctx), AiImageModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
