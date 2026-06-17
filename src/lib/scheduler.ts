/**
 * In-process cron scheduler (geonera-scheduler service).
 *
 * Identical logic to the original admin-backend scheduler, with one addition:
 * refreshAutoRun() — called when the scheduler receives a 'scheduler_settings'
 * NOTIFY so it reacts to worker_auto_run changes without restarting.
 */
import { Cron } from 'croner'
import { prisma } from './prisma'
import { publishToQueue } from './rabbitmq'
import { daemonFetch } from './daemon'

interface CronRow {
  id: string
  name: string
  cronExpr: string
  workerKey: string
  triggerMethod: string
  queueName: string | null
  httpPath: string | null
}

const jobs = new Map<string, Cron>()

let _autoRun = true

export function getAutoRun(): boolean {
  return _autoRun
}

export async function _loadAutoRun(): Promise<void> {
  try {
    const rows = await prisma.$queryRaw<{ value: string }[]>`
      SELECT value FROM schedule.settings WHERE key = 'worker_auto_run'
    `
    if (rows.length > 0) _autoRun = rows[0].value === 'true'
  } catch (err: any) {
    console.warn('⏰ Could not load worker_auto_run, defaulting to enabled:', err.message)
  }
}

/** Re-read worker_auto_run from DB — called on 'scheduler_settings' NOTIFY. */
export async function refreshAutoRun(): Promise<void> {
  await _loadAutoRun()
  console.log(`⏰ worker_auto_run refreshed → ${_autoRun ? 'ON' : 'OFF'}`)
}

export async function startScheduler(): Promise<void> {
  await _loadAutoRun()
  const crons = await prisma.cron.findMany({ where: { status: 'ACTIVE' } })
  for (const cron of crons) _scheduleOne(cron)
  console.log(`⏰ Scheduler started — ${crons.length} active jobs (auto-run: ${_autoRun ? 'ON' : 'OFF'})`)
}

export async function reloadJob(id: string): Promise<void> {
  _stopOne(id)
  const cron = await prisma.cron.findUnique({ where: { id } })
  if (!cron) return
  if (cron.status === 'ACTIVE') {
    _scheduleOne(cron)
    console.log(`⏰ Reloaded job "${cron.name}" (${cron.cronExpr})`)
  } else {
    console.log(`⏰ Job "${cron.name}" is ${cron.status} — not scheduled`)
  }
}

export function stopScheduler(): void {
  for (const [id] of jobs) _stopOne(id)
  console.log('⏰ Scheduler stopped')
}

function _scheduleOne(cron: CronRow): void {
  _stopOne(cron.id)
  try {
    const job = new Cron(
      cron.cronExpr,
      { timezone: 'UTC', protect: true },
      () => void _fire(cron)
    )
    jobs.set(cron.id, job)
  } catch (err: any) {
    console.error(`⏰ Failed to schedule "${cron.name}" (${cron.cronExpr}):`, err.message)
  }
}

function _stopOne(id: string): void {
  const existing = jobs.get(id)
  if (existing) {
    existing.stop()
    jobs.delete(id)
  }
}

async function _fire(cron: CronRow): Promise<void> {
  if (!_autoRun) {
    console.log(`⏰ [${cron.name}] SKIPPED — worker auto-run is disabled`)
    return
  }

  const t0 = Date.now()
  let success = false
  let resultMeta: Record<string, unknown> = {}

  try {
    if (cron.triggerMethod === 'RABBITMQ' && cron.queueName) {
      await publishToQueue(cron.queueName, {})
      success = true
      resultMeta = { method: 'rabbitmq', queue: cron.queueName }
      console.log(`⏰ [${cron.name}] → ${cron.queueName} ✓`)
    } else if (cron.httpPath) {
      const res = await daemonFetch(cron.httpPath, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      })
      success = res.ok
      resultMeta = { method: 'http', httpStatus: res.status, path: cron.httpPath }
      console.log(`⏰ [${cron.name}] HTTP ${res.status}`)
    } else {
      throw new Error('No queue_name or http_path configured')
    }
  } catch (err: any) {
    resultMeta = { error: err.message, method: cron.triggerMethod }
    console.error(`⏰ [${cron.name}] FAILED:`, err.message)
  }

  prisma.cron
    .update({
      where: { id: cron.id },
      data: {
        lastTriggeredAt: new Date(),
        lastResult: { success, durationMs: Date.now() - t0, ...resultMeta },
        updatedAt: new Date(),
      },
    })
    .catch((e) => console.error(`⏰ [${cron.name}] Failed to persist last_result:`, e.message))
}
