/**
 * geonera-scheduler — Standalone cron scheduler service.
 *
 * Responsibilities:
 *   - Load all ACTIVE crons from schedule.crons at startup
 *   - Fire them on schedule via RabbitMQ (primary) or HTTP to Go Daemon (fallback)
 *   - React to live config changes via PostgreSQL LISTEN/NOTIFY:
 *       cron_reload        → reloadJob(cron_id)   after any CRUD on schedule.crons
 *       scheduler_settings → refreshAutoRun()      after worker_auto_run is toggled
 *
 * Exactly ONE instance of this service should run at a time.
 * Admin backend is now stateless with respect to scheduling and can scale freely.
 */
import postgres from 'postgres'
import { startScheduler, stopScheduler, reloadJob, refreshAutoRun } from './lib/scheduler'
import { closeRabbitMQ } from './lib/rabbitmq'
import { prisma } from './lib/prisma'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[scheduler] DATABASE_URL is required')
  process.exit(1)
}

async function main() {
  // 1. Start in-process croner jobs
  await startScheduler()

  // 2. Dedicated raw pg connection for LISTEN/NOTIFY
  //    (Prisma connection pool does not support LISTEN)
  const pg = postgres(DATABASE_URL!)

  const cronSub = await pg.listen('cron_reload', async (cronId) => {
    console.log(`[notify] cron_reload → reloadJob(${cronId})`)
    try {
      await reloadJob(cronId)
    } catch (err: any) {
      console.error('[notify] reloadJob failed:', err.message)
    }
  })

  const settingsSub = await pg.listen('scheduler_settings', async (key) => {
    if (key === 'worker_auto_run') {
      console.log('[notify] scheduler_settings → refreshing worker_auto_run')
      try {
        await refreshAutoRun()
      } catch (err: any) {
        console.error('[notify] refreshAutoRun failed:', err.message)
      }
    }
  })

  console.log('⏰ Listening on cron_reload + scheduler_settings')

  // 3. Graceful shutdown
  const shutdown = async () => {
    stopScheduler()
    await cronSub.unlisten()
    await settingsSub.unlisten()
    await pg.end()
    await closeRabbitMQ()
    await prisma.$disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('[scheduler] fatal error:', err)
  process.exit(1)
})
