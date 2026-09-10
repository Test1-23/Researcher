/**
 * 基于 Electron safeStorage 的密钥编解码器。
 *
 * 这是**唯一**接触 Electron 加密能力的文件；引擎只依赖 `SecretCodec` 接口，
 * 因此命令行与测试可以注入明文实现，而引擎代码一行都不用改。
 *
 * 平台差异：
 *   · Windows —— DPAPI，绑定当前系统用户；换用户或换机器解不开。
 *   · macOS   —— Keychain。
 *   · Linux   —— 依赖 keyring；若 Electron 退回 `basic_text` 后端，那只是混淆而非加密。
 */

import { safeStorage } from 'electron'
import { PLAINTEXT_CODEC, type SecretCodec } from './engine/config.ts'

/** 用户显式接受明文存储时的逃生开关（例如 Linux 上没有可用 keyring）。 */
export const ALLOW_PLAINTEXT_ENV = 'RESEARCHER_ALLOW_PLAINTEXT_KEY'

/** 本次运行可用的密钥存储能力。 */
export interface SecretStorage {
  /** 读写配置时使用的加解密实现。 */
  readonly codec: SecretCodec
  /** 是否允许把密钥写进配置文件。为 false 时界面应引导用户改用环境变量。 */
  readonly canPersist: boolean
  /** 持久化时是否为明文（true 表示界面要持续警告）。 */
  readonly plaintext: boolean
  /** 不能加密时的人类可读原因。 */
  readonly reason?: string
}

/** Linux 上真正的加密后端；`basic_text` 只是把密钥打乱存放，不算加密。 */
function hasSecureBackend(): boolean {
  if (process.platform !== 'linux') return true
  try {
    // getSelectedStorageBackend 只在 Linux 上存在
    return safeStorage.getSelectedStorageBackend() !== 'basic_text'
  } catch {
    return true
  }
}

/** 探测当前平台的密钥存储能力。 */
export function detectSecretStorage(): SecretStorage {
  const explicitlyAllowed = process.env[ALLOW_PLAINTEXT_ENV] === '1'

  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch {
    available = false
  }
  const secure = available && hasSecureBackend()

  if (secure) {
    return {
      canPersist: true,
      plaintext: false,
      codec: {
        kind: 'safeStorage',
        secure: true,
        encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
        decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
      },
    }
  }

  const reason = available
    ? '当前 Linux 会话只提供 basic_text 后端，它只是混淆而不是加密。'
    : '系统密钥库不可用（safeStorage.isEncryptionAvailable() 返回 false）。'
  const hint = `建议改用 DEEPSEEK_API_KEY 环境变量；若确实要明文保存，请设置 ${ALLOW_PLAINTEXT_ENV}=1。`

  return {
    // 即使不允许持久化，也能读明文配置——只是拒绝写入新密钥
    codec: PLAINTEXT_CODEC,
    canPersist: explicitlyAllowed,
    plaintext: true,
    reason: `${reason}${hint}`,
  }
}
