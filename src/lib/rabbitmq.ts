import amqp from 'amqplib'

type RabbitConn = Awaited<ReturnType<typeof amqp.connect>>

let _connection: RabbitConn | null = null

function getRabbitUrl(): string {
  const url = process.env.RABBITMQ_URL
  if (!url) throw new Error('RABBITMQ_URL is not set in environment')
  return url
}

async function getConnection(): Promise<RabbitConn> {
  if (_connection) return _connection

  const conn = await amqp.connect(getRabbitUrl())
  ;(conn as any).on('error', (err: Error) => {
    console.error('[rabbitmq] connection error:', err.message)
    _connection = null
  })
  ;(conn as any).on('close', () => {
    console.warn('[rabbitmq] connection closed — will reconnect on next publish')
    _connection = null
  })

  _connection = conn
  return conn
}

export async function publishToQueue(
  queueName: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const conn = await getConnection()
  const channel = await conn.createChannel()
  try {
    await channel.assertQueue(queueName, { durable: true })
    channel.sendToQueue(
      queueName,
      Buffer.from(JSON.stringify(payload)),
      { contentType: 'application/json', deliveryMode: 2 }
    )
  } finally {
    await channel.close()
  }
}

export async function closeRabbitMQ(): Promise<void> {
  if (_connection) {
    await (_connection as any).close().catch(() => {})
    _connection = null
  }
}
