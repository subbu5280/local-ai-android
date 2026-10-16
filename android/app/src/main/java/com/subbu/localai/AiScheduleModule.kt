package com.subbu.localai

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Scheduled tasks (M14), within Android's limits: at the chosen time a notification is shown; tapping it opens the
 * app at localai://task/<id>, and the app runs the saved prompt with the user present. The model never runs in the
 * background (a 1 GB model in a background job would be killed and drain the battery).
 *
 * Alarms are inexact (setAndAllowWhileIdle: no special permission; Android may delay them by minutes in Doze).
 * Android drops alarms on reboot, so each armed alarm is also kept in private SharedPreferences (id, title, time,
 * daily) and BootReceiver re-arms them; a one-time task that came due while the phone was off notifies at boot.
 */
class AiScheduleModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AiSchedule"

  /** Schedule (or replace) task `id` to notify at `atMillis`, then every 24 h when `daily`. */
  @ReactMethod
  fun schedule(id: String, title: String, atMillis: Double, daily: Boolean, promise: Promise) {
    set(ctx, id, title, atMillis.toLong(), daily)
    promise.resolve(null)
  }

  @ReactMethod
  fun cancel(id: String, promise: Promise) {
    alarms(ctx).cancel(pending(ctx, id, "", false))
    prefs(ctx).edit().remove(id).apply()
    promise.resolve(null)
  }

  companion object {
    private const val CHANNEL = "scheduled_tasks"
    private fun alarms(c: Context) = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    private fun pending(c: Context, id: String, title: String, daily: Boolean): PendingIntent {
      val i = Intent(c, ScheduleReceiver::class.java).setData(Uri.parse("localai://task/$id"))
        .putExtra("title", title).putExtra("daily", daily)
      return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun prefs(c: Context) = c.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE)

    fun set(c: Context, id: String, title: String, at: Long, daily: Boolean) {
      alarms(c).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(c, id, title, daily))
      prefs(c).edit().putString(id, org.json.JSONObject().put("title", title).put("at", at).put("daily", daily).toString()).apply()
    }

    /** After a reboot: re-arm every kept alarm. Daily ones move to their next future time; missed one-time ones notify now. */
    fun rearm(c: Context, now: Long = System.currentTimeMillis()) {
      for ((id, raw) in prefs(c).all) {
        val j = runCatching { org.json.JSONObject(raw as String) }.getOrNull() ?: continue
        val title = j.optString("title", "Scheduled task")
        var at = j.optLong("at")
        val daily = j.optBoolean("daily")
        if (at > now) set(c, id, title, at, daily)
        else if (daily) { while (at <= now) at += 86_400_000L; set(c, id, title, at, true) }
        else { notify(c, id, title); prefs(c).edit().remove(id).apply() }
      }
    }

    fun done(c: Context, id: String) = prefs(c).edit().remove(id).apply()

    fun notify(c: Context, id: String, title: String) {
      val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Scheduled tasks", NotificationManager.IMPORTANCE_DEFAULT))
      val open = PendingIntent.getActivity(c, id.hashCode(),
        Intent(Intent.ACTION_VIEW, Uri.parse("localai://task/$id"), c, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val b = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(c, CHANNEL) else @Suppress("DEPRECATION") android.app.Notification.Builder(c)
      nm.notify(id.hashCode(), b.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title)
        .setContentText("Tap to run this task in Local AI").setContentIntent(open).setAutoCancel(true).build())
    }
  }
}

/** Fires a scheduled task: shows its notification and, for a daily task, sets tomorrow's alarm. */
class ScheduleReceiver : BroadcastReceiver() {
  override fun onReceive(c: Context, i: Intent) {
    val id = i.data?.lastPathSegment ?: return
    val title = i.getStringExtra("title") ?: "Scheduled task"
    AiScheduleModule.notify(c, id, title)
    if (i.getBooleanExtra("daily", false)) AiScheduleModule.set(c, id, title, System.currentTimeMillis() + 86_400_000L, true)
    else AiScheduleModule.done(c, id)
  }
}

/** Re-arms scheduled tasks after the phone restarts (Android clears all alarms on reboot). */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(c: Context, i: Intent) {
    if (i.action == Intent.ACTION_BOOT_COMPLETED) AiScheduleModule.rearm(c)
  }
}
