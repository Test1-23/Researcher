/**
 * 事件总线与日志。
 *
 * 日志同时走两个去向：控制台（开发排障）与事件总线（界面实时显示）。
 * 两者都经过脱敏，保证 API key 永远不会出现在日志或界面里。
 */

import type { EventBus, Logger, RunEvent, RunEventPayload } from './types.ts'

/** 内存事件总线。内核与插件发事件，Electron 主进程订阅后转发给渲染进程。 */
export class SimpleEventBus implements EventBus {
  private readonly listeners = new Set<(event: RunEvent) => void>()

  emit(event: RunEventPayload): void {
    const stamped: RunEvent = { ...event, at: new Date().toISOString() }
    for (const listener of this.listeners) {
      // 一个监听器抛异常不能打断运行本身。
      try {
        listener(stamped)
      } catch {
        /* 监听器故障与引擎无关，忽略 */
      }
    }
  }

  on(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/**
 * 把文本里出现的密钥替换成 ***。
 *
 * 这是最后一道防线：即使某处不小心把 key 拼进了错误信息，写进日志前也会被抹掉。
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let output = text
  for (const secret of secrets) {
    if (secret.length < 8) continue // 太短的字符串替换会误伤正常文本
    output = output.split(secret).join('***')
  }
  return output
}

/** 收集配置中出现的全部密钥字面量，用于脱敏。 */
export function collectSecrets(pluginSections: Readonly<Record<string, Readonly<Record<string, unknown>>>>): string[] {
  const secrets: string[] = []
  for (const section of Object.values(pluginSections)) {
    const value = section['apiKey']
    if (typeof value === 'string' && value.length > 0) secrets.push(value)
  }
  return secrets
}

/** 创建带前缀与脱敏的日志器。 */
export function createLogger(
  bus: EventBus,
  prefix: string,
  secrets: readonly string[] = [],
  mirrorToConsole = true,
): Logger {
  const write = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
    const safe = redactSecrets(message, secrets)
    bus.emit({ type: 'log', level, message: `${prefix}${safe}` })
    if (mirrorToConsole) {
      const line = `[${level}] ${prefix}${safe}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }
  }
  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/** 供测试使用的静默日志器。 */
export function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}
