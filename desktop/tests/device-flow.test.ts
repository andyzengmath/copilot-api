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

function createHarness(getDeviceCode?: () => Promise<DeviceCodeResponse>) {
  const polls: PendingPoll[] = []
  const tokens: string[] = []
  const errors: string[] = []
  let codeIndex = 0
  const start = createDeviceFlowStarter({
    getDeviceCode:
      getDeviceCode
      ?? (() => Promise.resolve(createDeviceCode(`CODE-${++codeIndex}`))),
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

  test('aborts the previous poll before the next device code arrives', async () => {
    const nextCode = Promise.withResolvers<DeviceCodeResponse>()
    let requests = 0
    const { polls, settle, start, errors } = createHarness(() =>
      ++requests === 1 ?
        Promise.resolve(createDeviceCode('CODE-1'))
      : nextCode.promise,
    )

    await start()
    const next = start()

    expect(polls[0]?.signal.aborted).toBe(true)
    await settle()
    expect(errors).toEqual([])

    nextCode.resolve(createDeviceCode('CODE-2'))
    await next
    expect(polls[1]?.signal.aborted).toBe(false)
  })

  test('rejects an older device code without aborting the latest poll', async () => {
    const firstCode = Promise.withResolvers<DeviceCodeResponse>()
    const latestCode = Promise.withResolvers<DeviceCodeResponse>()
    let requests = 0
    const { polls, start, tokens, errors, settle } = createHarness(() =>
      ++requests === 1 ? firstCode.promise : latestCode.promise,
    )

    const first = start().catch((error: unknown) => error)
    const latest = start()
    latestCode.resolve(createDeviceCode('LATEST'))
    expect((await latest).user_code).toBe('LATEST')

    firstCode.resolve(createDeviceCode('OLDER'))
    expect(await first).toMatchObject({ name: 'AbortError' })
    expect(polls).toHaveLength(1)
    expect(polls[0]?.deviceCode.user_code).toBe('LATEST')
    expect(polls[0]?.signal.aborted).toBe(false)

    polls[0]?.resolve('gho_latest')
    await settle()
    expect(tokens).toEqual(['gho_latest'])
    expect(errors).toEqual([])
  })

  test('does not deliver a resolved token after a newer request starts', async () => {
    const { polls, start, tokens, errors, settle } = createHarness()

    await start()
    polls[0]?.resolve('gho_superseded')
    await start()
    await settle()

    expect(polls[0]?.signal.aborted).toBe(true)
    expect(tokens).toEqual([])
    expect(errors).toEqual([])

    polls[1]?.resolve('gho_current')
    await settle()
    expect(tokens).toEqual(['gho_current'])
  })

  test('keeps superseded device-code failures from affecting the latest poll', async () => {
    const firstCode = Promise.withResolvers<DeviceCodeResponse>()
    let requests = 0
    const { polls, start, errors } = createHarness(() =>
      ++requests === 1 ?
        firstCode.promise
      : Promise.resolve(createDeviceCode('LATEST')),
    )

    const first = start().catch((error: unknown) => error)
    await start()
    firstCode.reject(new Error('old request failed'))

    expect(await first).toMatchObject({ name: 'AbortError' })
    expect(polls).toHaveLength(1)
    expect(polls[0]?.signal.aborted).toBe(false)
    expect(errors).toEqual([])
  })

  test('reports device-code failures to the caller and permits retrying', async () => {
    const failure = new Error('device code request failed')
    let requests = 0
    const { polls, start, errors } = createHarness(() =>
      ++requests === 1 ?
        Promise.reject(failure)
      : Promise.resolve(createDeviceCode('RETRY')),
    )

    const result = await start().catch((error: unknown) => error)
    expect(result).toBe(failure)
    expect(polls).toHaveLength(0)
    expect(errors).toEqual([])

    expect((await start()).user_code).toBe('RETRY')
    expect(polls[0]?.signal.aborted).toBe(false)
  })

  test('does not let a superseded poll cleanup clear the latest flow', async () => {
    const { polls, start, settle } = createHarness()

    await start()
    await start()
    await settle()
    await start()
    await settle()

    expect(polls).toHaveLength(3)
    expect(polls[0]?.signal.aborted).toBe(true)
    expect(polls[1]?.signal.aborted).toBe(true)
    expect(polls[2]?.signal.aborted).toBe(false)
  })

  test('normalizes non-Error poll failures', async () => {
    const errors: string[] = []
    const start = createDeviceFlowStarter({
      getDeviceCode: () => Promise.resolve(createDeviceCode('CODE-1')),
      pollAccessToken: () =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        new Promise((_resolve, reject) => reject('failed')),
      onToken: () => Promise.resolve(),
      onError: (error) => {
        errors.push(error.message)
      },
    })

    await start()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(errors).toEqual(['failed'])
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
