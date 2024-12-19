const config = {
    AMQP_URL: process.env.AMQP_URL || "amqp://127.0.0.1",
    QUEUE_NAME: process.env.QUEUE_NAME || "transactionQueue",
    TRANSACTION_TIMEOUT: process.env.TRANSACTION_TIMEOUT || 30 * 60 * 1000, // 30 minutes
    MAX_RETRY_ATTEMPTS: process.env.MAX_RETRY_ATTEMPTS || 10
  };