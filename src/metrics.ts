/**
 * Measurements for device verification: one `LOCALAI_METRIC {json}` line per event in logcat (tag ReactNativeJS),
 * read by scripts/device-check.ps1. Only numbers and labels; never message text, prompts or answers.
 */
export type MetricValue = string | number | boolean | null;

/**
 * Log one event.
 * @param event what happened, e.g. 'model_loaded' or 'answer'
 * @param data numbers and short labels only (the caller must never pass user text)
 */
export function metric(event: string, data: Record<string, MetricValue> = {}): void {
  console.log(`LOCALAI_METRIC ${JSON.stringify({ event, t: Date.now(), ...data })}`);
}
