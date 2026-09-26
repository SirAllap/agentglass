package app.agentglass.keepalive

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JS-facing switch for KeepAliveService. See that file for why it exists.
 *
 * start()/stop() never throw across the bridge: a phone where the OS refuses
 * to start a foreground service (background-start limits, battery
 * restrictions the owner set by hand, or the API-31+ exception for exactly
 * this case) should still be a working app with a dead notification switch,
 * not a crash. One `catch (e: Exception)` covers all of those — naming the
 * specific one too is a Lint NewApi warning on a module whose minSdk is
 * below 31, for a case the generic catch already handles.
 */
class KeepAliveModule : Module() {
  /** start() and stop() differ only in which one line can throw; this is that
   *  shape once, not copied per function. See the class comment for why
   *  every reason it can throw ends the same way: `false`, not a crash. */
  private inline fun guarded(block: () -> Unit): Boolean = try {
    block()
    true
  } catch (e: Exception) {
    false
  }

  override fun definition() = ModuleDefinition {
    Name("AgxKeepAlive")

    Function("start") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      guarded { ContextCompat.startForegroundService(context, Intent(context, KeepAliveService::class.java)) }
    }

    Function("stop") {
      val context = appContext.reactContext
      guarded { context?.stopService(Intent(context, KeepAliveService::class.java)) }
    }

    // Read from the service's own lifecycle (KeepAliveService.running, set in
    // its onCreate/onDestroy), not a flag this module set on start()'s
    // success — that call only means the OS ACCEPTED the request, and says
    // nothing about a service later killed by the OS, by battery settings, or
    // by the person tapping "stop" on the foreground-service notification
    // itself. None of those reach this module any other way.
    Function("isRunning") {
      KeepAliveService.running
    }
  }
}
