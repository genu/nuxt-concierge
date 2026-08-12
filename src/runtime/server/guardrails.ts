// Stub — Task 11 replaces this file with the real boot checks.
export interface GuardrailInput {
  role: string
  capabilities: { persistent: boolean, crossProcess: boolean }
  driverName: string
  queueCount: number
  isProduction: boolean
  shutdownTimeout: number
  nitroShutdownTimeout: number
  nitroShutdownDisabled: boolean
  preset?: string
}

export const checkGuardrails = (_input: GuardrailInput): void => {}
