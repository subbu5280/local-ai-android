package com.subbu.localai

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableArray
import java.util.concurrent.Executors

/**
 * Phase 15.3: the phone's own chat database, using Android's built-in SQLite (no extra library).
 *
 * The file lives in the app's private databases folder (other apps can't read it; it isn't exported or logged).
 * All SQL runs on one background thread, in order, never on the UI thread. The schema and every query live in
 * src/chatStore.ts; this module only executes parameterized statements and returns rows. Nothing here logs SQL
 * parameters or row contents (they are personal messages).
 */
class AiStoreModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private val worker = Executors.newSingleThreadExecutor()
  private var db: SQLiteDatabase? = null

  override fun getName() = "AiStore"

  private fun open(): SQLiteDatabase =
    db ?: SQLiteDatabase.openOrCreateDatabase(ctx.getDatabasePath(DB_NAME).apply { parentFile?.mkdirs() }, null)
      .also { it.setForeignKeyConstraintsEnabled(true); db = it }

  private fun args(params: ReadableArray?): Array<Any?> =
    Array(params?.size() ?: 0) { i ->
      when (params!!.getType(i)) {
        ReadableType.Null -> null
        ReadableType.Boolean -> if (params.getBoolean(i)) 1L else 0L
        ReadableType.Number -> params.getDouble(i).let { d -> if (d % 1.0 == 0.0 && Math.abs(d) < 9.0e15) d.toLong() else d }
        else -> params.getString(i)
      }
    }

  private fun run(promise: Promise, work: () -> Any?) {
    worker.execute {
      try {
        promise.resolve(work())
      } catch (e: Exception) {
        promise.reject("sqlite", e.javaClass.simpleName + ": " + (e.message ?: "")) // SQLite messages never contain row values
      }
    }
  }

  /** One write statement (INSERT / UPDATE / DELETE / CREATE ...) with positional `?` parameters. */
  @ReactMethod
  fun execute(sql: String, params: ReadableArray?, promise: Promise) = run(promise) {
    val s = open().compileStatement(sql)
    try {
      bind(s, args(params))
      s.executeUpdateDelete()
    } finally {
      s.close()
    }
  }

  /** Several write statements in ONE transaction: all or nothing (migrations, multi-row updates). */
  @ReactMethod
  fun batch(statements: ReadableArray, promise: Promise) = run(promise) {
    val d = open()
    d.beginTransaction()
    try {
      for (i in 0 until statements.size()) {
        val st = statements.getMap(i) ?: continue
        val s = d.compileStatement(st.getString("sql") ?: "")
        try {
          bind(s, args(st.getArray("params")))
          s.execute()
        } finally {
          s.close()
        }
      }
      d.setTransactionSuccessful()
      null
    } finally {
      d.endTransaction()
    }
  }

  /** A SELECT; resolves with the rows as objects (column -> value). */
  @ReactMethod
  fun query(sql: String, params: ReadableArray?, promise: Promise) = run(promise) {
    val strArgs = args(params).map { it?.toString() }.toTypedArray() // rawQuery binds text; SQLite applies column affinity
    open().rawQuery(sql, strArgs).use { rows(it) }
  }

  private fun bind(s: android.database.sqlite.SQLiteStatement, a: Array<Any?>) {
    a.forEachIndexed { i, v ->
      when (v) {
        null -> s.bindNull(i + 1)
        is Long -> s.bindLong(i + 1, v)
        is Double -> s.bindDouble(i + 1, v)
        else -> s.bindString(i + 1, v.toString())
      }
    }
  }

  private fun rows(c: Cursor): WritableArray {
    val out = Arguments.createArray()
    while (c.moveToNext()) {
      val row = Arguments.createMap()
      for (i in 0 until c.columnCount) {
        val name = c.getColumnName(i)
        when (c.getType(i)) {
          Cursor.FIELD_TYPE_NULL -> row.putNull(name)
          Cursor.FIELD_TYPE_INTEGER -> row.putDouble(name, c.getLong(i).toDouble())
          Cursor.FIELD_TYPE_FLOAT -> row.putDouble(name, c.getDouble(i))
          else -> row.putString(name, c.getString(i))
        }
      }
      out.pushMap(row)
    }
    return out
  }

  override fun invalidate() {
    worker.execute { db?.close(); db = null }
    worker.shutdown()
    super.invalidate()
  }

  companion object {
    const val DB_NAME = "chat.db"
  }
}
