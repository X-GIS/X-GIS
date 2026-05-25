// Structured, host-routable engine log. Default sink mirrors the previous
// raw console.* behavior; hosts call setLogSink() to capture/route logs
// (telemetry, in-app overlay, test assertions) instead of the console.
export type LogLevel = 'debug' | 'warn' | 'error'
export type LogSink = (level: LogLevel, message: string, ...args: unknown[]) => void

let sink: LogSink = (level, message, ...args) => {
  if (level === 'error') console.error(message, ...args)
  else if (level === 'warn') console.warn(message, ...args)
  else console.debug(message, ...args)
}
/** Replace the engine log sink. Pass null to restore the console default. */
export function setLogSink(s: LogSink | null): void {
  sink = s ?? ((level, message, ...args) => {
    if (level === 'error') console.error(message, ...args)
    else if (level === 'warn') console.warn(message, ...args)
    else console.debug(message, ...args)
  })
}
export const xlog = {
  debug: (message: string, ...args: unknown[]) => sink('debug', message, ...args),
  warn: (message: string, ...args: unknown[]) => sink('warn', message, ...args),
  error: (message: string, ...args: unknown[]) => sink('error', message, ...args),
}
