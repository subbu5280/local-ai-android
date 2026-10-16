/** M14 scheduled tasks below the UI: command parsing, next-run time, and add/list/cancel/complete on real SQLite. */
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { sqliteDb } from '../testUtils/sqliteDb';
import * as chat from '../src/chatStore';
import * as schedule from '../src/schedule';

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);

test('commands: times, am/pm and daily are understood; ordinary messages are not commands', () => {
  expect(schedule.parseScheduleCommand('Schedule daily 08:00 Give me a Kafka question'))
    .toEqual({ kind: 'add', hour: 8, minute: 0, daily: true, prompt: 'Give me a Kafka question' });
  expect(schedule.parseScheduleCommand('schedule at 7:30 pm: call mom')).toEqual({ kind: 'add', hour: 19, minute: 30, daily: false, prompt: 'call mom' });
  expect(schedule.parseScheduleCommand('schedule 12 am backup')).toMatchObject({ hour: 0 });
  expect(schedule.parseScheduleCommand('Schedule 25:00 x')).toBeNull();
  expect(schedule.parseScheduleCommand('Scheduled tasks')).toEqual({ kind: 'list' });
  expect(schedule.parseScheduleCommand('cancel task 2')).toEqual({ kind: 'cancel', n: 2 });
  for (const t of ['What is my schedule today?', 'Schedule a meeting with Ravi', 'How do I schedule cron jobs?']) {
    expect([t, schedule.parseScheduleCommand(t)]).toEqual([t, null]);
  }
});

test('next run is today when still ahead, otherwise tomorrow', () => {
  const now = new Date(2026, 9, 16, 9, 0).getTime();
  expect(new Date(schedule.nextRun({ hour: 10, minute: 0 }, now)).getDate()).toBe(16);
  expect(new Date(schedule.nextRun({ hour: 8, minute: 0 }, now)).getDate()).toBe(17);
  expect(schedule.taskIdFromUrl('localai://task/abc123')).toBe('abc123');
  expect(schedule.taskIdFromUrl('localai://task/../x')).toBeNull();
});

test('add, list, cancel; a one-time task is removed once opened, a daily one stays; refused notifications are reported', async () => {
  const fs = node('fs'), os = node('os'), path = node('path');
  chat.setDb(sqliteDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')), 'chat.db')));
  await chat.open();
  (Platform as any).OS = 'android';
  Object.defineProperty(Platform, 'Version', { value: 34, configurable: true });
  const perm = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
  NativeModules.AiSchedule = { schedule: jest.fn(async () => undefined), cancel: jest.fn(async () => undefined) };
  const once = await schedule.addTask({ kind: 'add', hour: 8, minute: 0, daily: false, prompt: 'once' });
  const daily = await schedule.addTask({ kind: 'add', hour: 9, minute: 15, daily: true, prompt: 'daily' });
  expect(NativeModules.AiSchedule.schedule).toHaveBeenCalledWith(daily.id, 'daily', expect.any(Number), true);
  expect((await schedule.listTasks()).map(schedule.describeTask)).toEqual(['1. Once at 08:00: once', '2. Every day at 09:15: daily']);
  await schedule.completeTask(once.id);
  await schedule.completeTask(daily.id);
  expect((await schedule.listTasks()).map(t => t.prompt)).toEqual(['daily']);
  expect(await schedule.cancelTask(5)).toBeNull();
  expect((await schedule.cancelTask(1))?.prompt).toBe('daily');
  expect(NativeModules.AiSchedule.cancel).toHaveBeenCalledWith(daily.id);
  perm.mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
  await expect(schedule.addTask({ kind: 'add', hour: 1, minute: 0, daily: false, prompt: 'x' })).rejects.toThrow(/Notifications are off/);
  expect(await schedule.listTasks()).toEqual([]); // nothing saved that could never remind
});
