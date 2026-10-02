import { describe, expect, test } from 'bun:test'

import type { DeviceCodeResponse } from '../../src/services/github/get-device-code'
import { createDeviceFlowStarter } from '../electron/device-flow'

const createDeviceCode = (code: string): DeviceCodeResponse => ({
  device_code: `device-${code}`,
  expires_in: 900,
  interval: 5,
  user_code: code,
  verification_uri: 'https://github.com/login/device',
})

interface PendingPoll {
  deviceCode: DeviceCodeResponse
  signal: AbortSignal
  resolve: (token: string) => void
  reject: (error: Error) => void
}

function createHarness() {
  const polls: PendingPoll[] = []
  const tokens: string[] = []
  const errors: string[] = []
  let codeIndex = 0
  const start = createDeviceFlowStarter({
    getDeviceCode: () =>
      Promise.resolve(createDeviceCode(`CODE-${++codeIndex}`)),
    pollAccessToken: (deviceCode, signal) =>
      new Promise<string>((resolve, reject) => {
        polls.push({ deviceCode, signal, resolve, reject })
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        })
      }),
    onToken: (token) => {
      tokens.push(token)
      return Promise.resolve()
    },
    onError: (error) => {
      errors.push(error.message)
    },
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { errors, polls, settle, start, tokens }
}

describe('createDeviceFlowStarter', () => {
  test('reports the token of the current flow', async () => {
    const { polls, settle, start, tokens, errors } = createHarness()

    const deviceCode = await start()
    polls[0]?.resolve('gho_token')
    await settle()

    expect(deviceCode.user_code).toBe('CODE-1')
    expect(tokens).toEqual(['gho_token'])
    expect(errors).toEqual([])
  })

  test('reports failures of the current flow', async () => {
    const { polls, settle, start, errors } = createHarness()

    await start()
    polls[0]?.reject(new Error('GitHub device code expired'))
    await settle()

    expect(errors).toEqual(['GitHub device code expired'])
  })

  test('aborts a superseded flow and ignores its failure', async () => {
    const { polls, settle, start, tokens, errors } = createHarness()

    await start()
    await start()
    await settle()

    expect(polls).toHaveLength(2)
    expect(polls[0]?.signal.aborted).toBe(true)
    expect(polls[1]?.signal.aborted).toBe(false)
    expect(errors).toEqual([])

    polls[1]?.resolve('gho_second')
    await settle()

    expect(tokens).toEqual(['gho_second'])
    expect(errors).toEqual([])
  })

  test('reports errors thrown while handling the token', async () => {
    const errors: string[] = []
    const start = createDeviceFlowStarter({
      getDeviceCode: () => Promise.resolve(createDeviceCode('CODE-1')),
      pollAccessToken: () => Promise.resolve('gho_token'),
      onToken: () => Promise.reject(new Error('save failed')),
      onError: (error) => {
        errors.push(error.message)
      },
    })

    await start()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(errors).toEqual(['save failed'])
  })
})
