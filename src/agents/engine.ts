/**
 * Executing a validated plan, step by step, with application-enforced rules:
 *
 * - Strictly sequential, no loops, no re-planning: at most maxSteps steps, each tried at most 1 + maxRetries times,
 *   and only for errors the tool marks recoverable. A step that fails (or whose result check fails) stops the run;
 *   the remaining steps are marked skipped. The run is 'succeeded' only if every step succeeded.
 * - Each step gets only the output of the one earlier step its plan names (fromStep), clipped to a context budget.
 * - 'write' steps are confirmed by the user right before they run; declining cancels the run (nothing written).
 * - Every step has a time limit (the smaller of the tool's and the agent's); on timeout or cancel the tool's work is
 *   stopped (e.g. generation is stopped) and no later step starts.
 * - The run is saved after every change, so an interrupted run is visible (and marked interrupted at the next launch).
 */
import { estimateTokens } from '../chatStore';
import { noEvidenceReply } from '../knowledge/knowledgePrompt';
import { clampLimits, needsConfirmation, permitted } from './policy';
import { getTool } from './tools';
import { ToolError, validateInput, type AgentConfig, type Run, type StepOutput, type StepRecord } from './types';

export const PREVIOUS_TEXT_TOKENS = 1500; // text handed from one step to the next

/** Cancels a run: no further step starts, and the running step's work is stopped. */
export class RunHandle {
  cancelled = false;
  private stops = new Set<() => void>();
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stops.forEach(s => { try { s(); } catch {} });
  }
  /** @internal register a stop function for the running step; returns its removal. */
  register(stop: () => void): () => void {
    this.stops.add(stop);
    if (this.cancelled) stop();
    return () => this.stops.delete(stop);
  }
}

export type EngineDeps = {
  /** Ask the user to allow a 'write' step (preview says exactly what will happen). */
  confirm: (step: StepRecord, preview: string) => Promise<boolean>;
  /** Called with a fresh copy of the run after every change (UI). */
  onUpdate?: (run: Run) => void;
  /** Saves the run (history); failures are reported but don't stop the run. */
  persist?: (run: Run) => Promise<void>;
  now?: () => number;
};

/** The earlier output a step may see: text clipped to the budget; passages are selected by the consuming tool. */
function forNext(out: StepOutput | null): StepOutput | null {
  if (!out?.text || estimateTokens(out.text) <= PREVIOUS_TEXT_TOKENS) return out;
  const keep = Math.floor(out.text.length * (PREVIOUS_TEXT_TOKENS / estimateTokens(out.text)));
  return { ...out, text: `${out.text.slice(0, keep)}…` };
}

/** Run `work`, failing with a timeout error after `ms` (and calling `onTimeout` to stop the work). */
async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new ToolError('timeout', `The step took longer than ${Math.round(ms / 1000)} s and was stopped.`)); }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a run whose steps were validated (policy.validatePlan). Never throws for step failures: the outcome is in
 * the returned run's status, steps and error.
 */
export async function executeRun(start: Run, agent: AgentConfig, scope: string[], handle: RunHandle, deps: EngineDeps): Promise<Run> {
  const now = deps.now ?? Date.now;
  const limits = clampLimits(agent.limits);
  let run: Run = { ...start, steps: start.steps.map(s => ({ ...s, status: 'approved' })), status: 'running', startedAt: now(),
    error: null, warnings: [], finalText: null, sources: [] };
  const publish = async () => {
    deps.onUpdate?.(structuredCopy(run));
    if (deps.persist) await deps.persist(run).catch(() => undefined); // history is best effort; the UI shows the run
  };
  const setStep = (i: number, patch: Partial<StepRecord>) => {
    run = { ...run, steps: run.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) };
  };
  const finish = async (status: Run['status'], error: string | null, from: number, rest: StepRecord['status']) => {
    run.steps.slice(from).forEach((s, k) => { if (s.status === 'approved') setStep(from + k, { status: rest }); });
    run = { ...run, status, error, endedAt: now() };
    await publish();
    return run;
  };
  await publish();

  for (let i = 0; i < run.steps.length; i++) {
    const step = run.steps[i];
    if (handle.cancelled) return finish('cancelled', 'Cancelled before this step started.', i, 'cancelled');
    const tool = getTool(step.tool);
    // Re-checked at run time: the plan was validated, but the agent or registry may have changed since.
    if (!tool || tool.version !== step.toolVersion || !permitted(agent, tool)) {
      setStep(i, { status: 'failed', errorCode: 'not_permitted', error: 'This tool is not (or no longer) allowed for this agent.', endedAt: now() });
      return finish('failed', 'A step was not permitted.', i + 1, 'skipped');
    }
    const { value: input, errors } = validateInput(tool.input, step.input);
    if (errors.length) {
      setStep(i, { status: 'failed', errorCode: 'invalid_input', error: errors.join('; '), endedAt: now() });
      return finish('failed', 'A step had invalid input.', i + 1, 'skipped');
    }
    const previous = step.fromStep ? forNext(run.steps[step.fromStep - 1]?.output ?? null) : null;
    if (needsConfirmation(tool)) {
      setStep(i, { status: 'approved' });
      await publish();
      const ok = await deps.confirm(run.steps[i], tool.preview?.(input, previous) ?? `Run "${tool.name}".`);
      if (!ok || handle.cancelled) {
        setStep(i, { status: 'cancelled', errorCode: 'declined', error: 'Not allowed by you; nothing was done.', endedAt: now() });
        return finish('cancelled', 'You declined a step; nothing was written.', i + 1, 'cancelled');
      }
    }

    const maxAttempts = 1 + limits.maxRetries;
    const timeoutMs = Math.min(tool.timeoutMs, limits.stepTimeoutSec * 1000);
    let output: StepOutput | null = null;
    let failure: ToolError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      setStep(i, { status: 'running', attempts: attempt, startedAt: run.steps[i].startedAt ?? now(), errorCode: null, error: null });
      await publish();
      const stops: (() => void)[] = [];
      const unregister = handle.register(() => stops.forEach(s => s()));
      try {
        output = await withTimeout(tool.run(input, {
          scope, previous, isCancelled: () => handle.cancelled, onCancel: s => { stops.push(s); }, language: run.language ?? undefined,
        }), timeoutMs, () => stops.forEach(s => s()));
        if (handle.cancelled) throw new ToolError('cancelled', 'Cancelled.');
        failure = null;
        break;
      } catch (e: any) {
        failure = e instanceof ToolError ? e : new ToolError('failed', String(e?.message ?? e).slice(0, 200), false);
        if (handle.cancelled) failure = new ToolError('cancelled', 'Cancelled while running.');
        if (!failure.recoverable || attempt === maxAttempts || handle.cancelled) break;
      } finally {
        unregister();
      }
    }
    if (failure || !output) {
      const f = failure ?? new ToolError('failed', 'The step produced no result.');
      setStep(i, { status: f.code === 'cancelled' ? 'cancelled' : 'failed', errorCode: f.code, error: f.message, endedAt: now() });
      if (f.code === 'cancelled') return finish('cancelled', 'Cancelled.', i + 1, 'cancelled');
      if (f.code === 'no_evidence') {
        run = { ...run, finalText: noEvidenceReply(scope.length, false) };
        return finish('no_evidence', f.message, i + 1, 'skipped');
      }
      return finish('failed', `Step ${i + 1} (${tool.name}) failed: ${f.message}`, i + 1, 'skipped');
    }
    setStep(i, { status: 'succeeded', output, summary: output.summary, warning: output.warning ?? null, endedAt: now() });
    if (output.warning) run = { ...run, warnings: [...run.warnings, `Step ${i + 1}: ${output.warning}`] };
    await publish();
  }

  // Every step succeeded: the result is the last step that produced text (or a value), with its sources.
  const last = [...run.steps].reverse().find(s => s.output?.text);
  run = { ...run, finalText: last?.output?.text ?? null, sources: [...run.steps].reverse().find(s => s.output?.sources?.length)?.output?.sources ?? [] };
  return finish('succeeded', null, run.steps.length, 'skipped');
}

/** A deep copy for UI state (runs hold only plain data). */
function structuredCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
