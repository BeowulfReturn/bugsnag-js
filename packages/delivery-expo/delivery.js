const payload = require('@bugsnag/core/lib/json-payload')
const { isoDate } = require('@bugsnag/core/lib/es-utils')
const UndeliveredPayloadQueue = require('./queue')
const NetworkStatus = require('./network-status')
const RedeliveryLoop = require('./redelivery')

module.exports = (client, fetch = global.fetch) => {
  const networkStatus = new NetworkStatus()

  const send = (url, opts, cb) => {
    fetch(url, opts)
      .then(response => {
        if (response.ok) return response.text()
        const err = new Error(`Bad status code from API: ${response.status}`)
        err.isRetryable = isRetryable(response.status)
        return Promise.reject(err)
      })
      .then(() => cb(null))
      .catch(err => cb(err))
  }

  const logError = e => client.__logger.error('Error redelivering payload', e)

  const enqueue = async (payloadKind, failedPayload) => {
    client.__logger.info(`Writing ${payloadKind} payload to cache`)
    await queues[payloadKind].enqueue(failedPayload, logError)
    if (networkStatus.isConnected) queueConsumers[payloadKind].start()
  }

  const onerror = async (err, failedPayload, payloadKind, cb) => {
    client.__logger.error(`${payloadKind} failed to send…\n${(err && err.stack) ? err.stack : err}`, err)
    if (failedPayload && err.isRetryable !== false) enqueue(payloadKind, failedPayload)
    cb(err)
  }

  const { queues, queueConsumers } = initRedelivery(networkStatus, client.__logger, send)

  return {
    sendReport: (report, cb = () => {}) => {
      const url = client._config.endpoints.notify

      let body, opts
      try {
        body = payload.event(report, client._config.redactedKeys)
        opts = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Bugsnag-Api-Key': report.apiKey || client._config.apiKey,
            'Bugsnag-Payload-Version': '4',
            'Bugsnag-Sent-At': isoDate()
          },
          body
        }
        if (!networkStatus.isConnected || report.attemptImmediateDelivery === false) {
          enqueue('report', { url, opts })
          return cb(null)
        }
        client.__logger.info(`Sending report ${report.events[0].errorClass}: ${report.events[0].errorMessage}`)
        send(url, opts, err => {
          if (err) return onerror(err, { url, opts }, 'report', cb)
          cb(null)
        })
      } catch (e) {
        onerror(e, { url, opts }, 'report', cb)
      }
    },

    sendSession: (session, cb = () => {}) => {
      const url = client._config.endpoints.sessions

      let body, opts
      try {
        body = payload.session(session, client._config.redactedKeys)
        opts = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Bugsnag-Api-Key': client._config.apiKey,
            'Bugsnag-Payload-Version': '1',
            'Bugsnag-Sent-At': isoDate()
          },
          body
        }
        if (!networkStatus.isConnected) {
          enqueue('session', { url, opts })
          return cb(null)
        }
        client.__logger.info('Sending session')
        send(url, opts, err => {
          if (err) return onerror(err, { url, opts }, 'session', cb)
          cb(null)
        })
      } catch (e) {
        onerror(e, { url, opts }, 'session', cb)
      }
    }
  }
}

const initRedelivery = (networkStatus, logger, send) => {
  const onQueueError = e => logger.error('UndeliveredPayloadQueue error', e)
  const queues = {
    report: new UndeliveredPayloadQueue('report', onQueueError),
    session: new UndeliveredPayloadQueue('session', onQueueError)
  }

  const onLoopError = e => logger.error('RedeliveryLoop error', e)
  const queueConsumers = {
    report: new RedeliveryLoop(send, queues.report, onLoopError),
    session: new RedeliveryLoop(send, queues.session, onLoopError)
  }

  Promise.all([queues.report.init(), queues.session.init()])
    .then(() => {
      networkStatus.watch(isConnected => {
        if (isConnected) {
          queueConsumers.report.start()
          queueConsumers.session.start()
        } else {
          queueConsumers.report.stop()
          queueConsumers.session.stop()
        }
      })
    })
    .catch(onQueueError)

  return { queues, queueConsumers }
}

// basically, if it starts with a 4, don't retry (unless it's in the list of exceptions)
const isRetryable = status => {
  return (
    status < 400 ||
    status > 499 ||
    [
      408, // timeout
      429 // too many requests
    ].includes(status))
}
