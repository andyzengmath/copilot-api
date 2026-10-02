import type { DeviceCodeResponse } from '../../src/services/github/get-device-code'

export interface DeviceFlowDependencies {
  getDeviceCode: () => Promise<DeviceCodeResponse>
  pollAccessToken: (
    deviceCode: DeviceCodeResponse,
    signal: AbortSignal,
  ) => Promise<string>
  onToken: (token: string) => Promise<void>
  onError: (error: Error) => void
}

/**
 * Starts GitHub device flows for the sign-in page, one at a time. Starting a
 * new request supersedes pending device-code requests and token polls, so
 * only the current flow can return a code or begin handling a token.
 */
export function createDeviceFlowStarter(
  dependencies: DeviceFlowDependencies,
): () => Promise<DeviceCodeResponse> {
  let active: AbortController | undefined

  return async () => {
    active?.abort()
    const controller = new AbortController()
    active = controller

    try {
      const deviceCode = await dependencies.getDeviceCode()
      controller.signal.throwIfAborted()

      void dependencies
        .pollAccessToken(deviceCode, controller.signal)
        .then((token) => {
          controller.signal.throwIfAborted()
          return dependencies.onToken(token)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          dependencies.onError(
            error instanceof Error ? error : new Error(String(error)),
          )
        })
        .finally(() => {
          if (active === controller) active = undefined
        })

      return deviceCode
    } catch (error) {
      if (active === controller) active = undefined
      controller.signal.throwIfAborted()
      throw error
    }
  }
}
