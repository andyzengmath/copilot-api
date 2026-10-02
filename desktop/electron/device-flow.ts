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
 * new flow aborts the previous poll, so a superseded flow can no longer report
 * a late failure (for example its code expiring) while a newer one is pending.
 */
export function createDeviceFlowStarter(
  dependencies: DeviceFlowDependencies,
): () => Promise<DeviceCodeResponse> {
  let active: AbortController | undefined

  return async () => {
    const deviceCode = await dependencies.getDeviceCode()
    active?.abort()
    const controller = new AbortController()
    active = controller

    void dependencies
      .pollAccessToken(deviceCode, controller.signal)
      .then((token) => dependencies.onToken(token))
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
  }
}
