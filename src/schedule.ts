/**
 * Scheduled tasks (M14): "Schedule daily 08:00 Give me a Kafka interview question", "Scheduled tasks",
 * "Cancel task 2". At the time, android/.../AiScheduleModule.kt shows a notification; tapping it opens
 * localai://task/<id> and the app asks before running the saved prompt (an outside app could open that link too).
 * Tasks are stored in the meta table (key scheduled_tasks), so the Settings backup category includes them.
 */
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { db, newId } from './chatStore';

export type Task = { id: string; prompt: string; hour: number; minute: number; daily: boolean; created_at: number };
export type ScheduleCommand =
  | { kind: 'add'; hour: number; minute: number; daily: boolean; prompt: string }
  | { kind: 'list' }
  | { kind: 'cancel'; n: number };

const KEY = 'scheduled_tasks';
const ADD = /^schedule\s+(daily\s+|every\s*day\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[:,-]?\s+(.+)$/is;

/** The schedule command in `text`, or null when it is a normal message. Times are 24 h unless am/pm is given. */
export function parseScheduleCommand(text: string): ScheduleCommand | null {
  const t = text.trim();
  if (/^(scheduled tasks|list (scheduled )?tasks|my tasks)\??$/i.test(t)) return { kind: 'list' };
  const cancel = t.match(/^(?:cancel|delete|remove)\s+task\s+(\d+)$/i);
  if (cancel) return { kind: 'cancel', n: Number(cancel[1]) };
  const m = t.match(ADD);
  if (!m) return null;
  let hour = Number(m[2]);
  const minute = Number(m[3] ?? 0);
  const ampm = m[4]?.toLowerCase();
  if (ampm) { if (hour < 1 || hour > 12) return null; hour = (hour % 12) + (ampm === 'pm' ? 12 : 0); }
  if (hour > 23 || minute > 59) return null;
  return { kind: 'add', hour, minute, daily: !!m[1], prompt: m[5].trim() };
}

/** The next time (ms) the task is due after `now`: today at hour:minute, or tomorrow if that has passed. */
export function nextRun(t: Pick<Task, 'hour' | 'minute'>, now = Date.now()): number {
  const d = new Date(now);
  d.setHours(t.hour, t.minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export async function listTasks(): Promise<Task[]> {
  const row = (await db().query('SELECT value FROM meta WHERE key = ?', [KEY]))[0];
  try { return row ? JSON.parse(row.value as string) : []; } catch { return []; }
}
async function save(tasks: Task[]) {
  await db().execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [KEY, JSON.stringify(tasks)]);
}

const title = (t: Task) => (t.prompt.length > 60 ? `${t.prompt.slice(0, 57)}…` : t.prompt);
async function arm(t: Task, now: number) {
  await NativeModules.AiSchedule?.schedule(t.id, title(t), nextRun(t, now), t.daily);
}

/** Ask for notification permission (Android 13+); false when refused. */
async function canNotify(): Promise<boolean> {
  if (Platform.OS !== 'android' || (Platform.Version as number) < 33) return true;
  return (await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any)) === PermissionsAndroid.RESULTS.GRANTED;
}

/** Save and arm a task. Throws when notifications are refused (the task would never be seen). */
export async function addTask(c: Extract<ScheduleCommand, { kind: 'add' }>, now = Date.now()): Promise<Task> {
  if (!(await canNotify())) throw new Error('Notifications are off for Local AI, so a scheduled task could not remind you. Allow them in Settings.');
  const t: Task = { id: newId(), prompt: c.prompt, hour: c.hour, minute: c.minute, daily: c.daily, created_at: now };
  await save([...(await listTasks()), t]);
  await arm(t, now);
  return t;
}

/** Cancel the n-th task (1-based, as listed); null when there is no such task. */
export async function cancelTask(n: number): Promise<Task | null> {
  const tasks = await listTasks();
  const t = tasks[n - 1];
  if (!t) return null;
  await save(tasks.filter(x => x.id !== t.id));
  await NativeModules.AiSchedule?.cancel(t.id);
  return t;
}

/** A one-time task is done once it has been opened; daily tasks stay. */
export async function completeTask(id: string): Promise<void> {
  const tasks = await listTasks();
  if (tasks.some(t => t.id === id && !t.daily)) await save(tasks.filter(t => t.id !== id));
}

/** Re-arm every task (on app start: alarms do not survive a reboot or an app update). */
export async function rearmAll(now = Date.now()): Promise<void> {
  for (const t of await listTasks()) await arm(t, now).catch(() => undefined);
}

export const describeTask = (t: Task, i: number) =>
  `${i + 1}. ${t.daily ? 'Every day' : 'Once'} at ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}: ${t.prompt}`;

/** The task id in a localai://task/<id> link, or null. */
export const taskIdFromUrl = (url?: string | null) => url?.match(/^localai:\/\/task\/([a-z0-9]+)$/i)?.[1] ?? null;
