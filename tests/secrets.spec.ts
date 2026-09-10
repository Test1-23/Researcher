/**
 * 密钥存储的测试。
 *
 * 用一个假的「加密」编解码器（前缀 + base64）代替 safeStorage，
 * 这样不需要 Electron 也能验证真正重要的性质：**明文不落盘、密文解不开时优雅降级**。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configFilePath,
  DEFAULT_CONFIG,
  deepMerge,
  hasPlaintextSecrets,
  loadConfig,
  loadConfigResilient,
  PLAINTEXT_CODEC,
  redactSecrets,
  saveConfig,
  secretSourceOf,
  type SecretCodec,
} from '../src/main/engine/config.ts'
import type { AppConfig } from '../src/main/engine/types.ts'

const SECRET = 'sk-live-abcdefghijklmnopqrstuvwxyz-0123456789'

/** 假的安全编解码器：可逆，且解不开时抛错（模拟换机器/换用户的 DPAPI）。 */
const fakeSecureCodec: SecretCodec = {
  kind: 'safeStorage',
  secure: true,
  encrypt: (value) => `enc:${Buffer.from(value, 'utf8').toString('base64')}`,
  decrypt: (value) => {
    if (!value.startsWith('enc:')) throw new Error('ciphertext 不是本机产生的')
    return Buffer.from(value.slice(4), 'base64').toString('utf8')
  },
}

const roots: string[] = []
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'researcher-secrets-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 一份带密钥的配置。 */
function configWithKey(key = SECRET): AppConfig {
  return deepMerge(DEFAULT_CONFIG, { plugins: { 'provider-openai': { apiKey: key } } })
}

/** 读回磁盘上的原始 JSON 文本。 */
async function rawConfig(root: string): Promise<string> {
  return await readFile(configFilePath(root), 'utf8')
}

describe('加密落盘', () => {
  it('明文密钥永远不出现在文件里', async () => {
    const root = await makeRoot()
    await saveConfig(root, configWithKey(), fakeSecureCodec)

    const raw = await rawConfig(root)
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain('"apiKey"')
    expect(raw).toContain('apiKeyEncrypted')
    expect(JSON.parse(raw).plugins['provider-openai'].apiKeyStorage).toBe('safeStorage')
  })

  it('能读回并解出密钥', async () => {
    const root = await makeRoot()
    await saveConfig(root, configWithKey(), fakeSecureCodec)

    const loaded = await loadConfig(root, fakeSecureCodec)
    expect(loaded.plugins['provider-openai']?.['apiKey']).toBe(SECRET)
    expect(secretSourceOf(loaded.plugins['provider-openai'] ?? {}, 'DEEPSEEK_API_KEY')).toBe('encrypted')
  })

  it('没有编解码器时不会把密文当成密钥（命令行场景）', async () => {
    const root = await makeRoot()
    await saveConfig(root, configWithKey(), fakeSecureCodec)

    const loaded = await loadConfig(root)
    expect(loaded.plugins['provider-openai']?.['apiKey']).toBeUndefined()
    // 状态要如实说「解不开」，而不是假装没配置过
    expect(secretSourceOf(loaded.plugins['provider-openai'] ?? {}, 'DEEPSEEK_API_KEY')).toBe('undecryptable')
  })

  it('解密失败（换了机器/用户）时优雅降级，不抛错', async () => {
    const root = await makeRoot()
    await saveConfig(root, configWithKey(), fakeSecureCodec)
    // 模拟另一台机器产生的密文
    const foreign: SecretCodec = { ...fakeSecureCodec, decrypt: () => { throw new Error('DPAPI 解不开') } }

    const loaded = await loadConfig(root, foreign)
    expect(loaded.plugins['provider-openai']?.['apiKey']).toBeUndefined()
    expect(secretSourceOf(loaded.plugins['provider-openai'] ?? {}, 'DEEPSEEK_API_KEY')).toBe('undecryptable')
  })

  it('明文编解码器会打上标记，便于界面持续警告', async () => {
    const root = await makeRoot()
    await saveConfig(root, configWithKey(), PLAINTEXT_CODEC)

    const raw = JSON.parse(await rawConfig(root))
    expect(raw.plugins['provider-openai'].apiKey).toBe(SECRET)
    expect(raw.plugins['provider-openai'].apiKeyStorage).toBe('plaintext')
    expect(secretSourceOf(raw.plugins['provider-openai'], 'DEEPSEEK_API_KEY')).toBe('plaintext')
  })

  it('清除密钥后文件里不留任何密钥痕迹', async () => {
    const root = await makeRoot()
    await saveConfig(root, configWithKey(), fakeSecureCodec)
    const cleared = deepMerge(DEFAULT_CONFIG, { plugins: { 'provider-openai': { apiKey: '' } } })
    await saveConfig(root, cleared, fakeSecureCodec)

    const raw = await rawConfig(root)
    expect(raw).not.toContain('apiKeyEncrypted')
    expect(raw).not.toContain('apiKeyStorage')
  })
})

describe('密钥来源判定', () => {
  it('覆盖全部来源', () => {
    const envName = 'RESEARCHER_SECRET_SOURCE_TEST'
    expect(secretSourceOf({}, envName)).toBe('none')
    expect(secretSourceOf({ apiKey: 'x' }, envName)).toBe('plaintext')
    expect(secretSourceOf({ apiKey: 'x', apiKeyStorage: 'safeStorage' }, envName)).toBe('encrypted')
    expect(secretSourceOf({ apiKeyEncrypted: 'abc' }, envName)).toBe('undecryptable')

    process.env[envName] = 'from-env'
    try {
      expect(secretSourceOf({ apiKeyEnv: envName }, 'IGNORED')).toBe('env')
    } finally {
      delete process.env[envName]
    }
  })
})

describe('下发给界面的脱敏', () => {
  it('同时抹掉明文与密文', () => {
    const config = deepMerge(DEFAULT_CONFIG, {
      plugins: { 'provider-openai': { apiKey: SECRET, apiKeyEncrypted: 'cipher', apiKeyStorage: 'safeStorage' } },
    })
    const redacted = redactSecrets(config)
    const serialized = JSON.stringify(redacted)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain('cipher')
    // 非敏感字段照常保留
    expect(redacted.plugins['provider-openai']?.['model']).toBe(DEFAULT_CONFIG.plugins['provider-openai']?.['model'])
  })
})

describe('明文迁移', () => {
  it('识别出旧版残留的明文密钥', () => {
    expect(hasPlaintextSecrets(DEFAULT_CONFIG)).toBe(false)
    expect(hasPlaintextSecrets(configWithKey())).toBe(true)
    // 已加密的不需要迁移
    const encrypted = deepMerge(DEFAULT_CONFIG, {
      plugins: { 'provider-openai': { apiKey: SECRET, apiKeyStorage: 'safeStorage' } },
    })
    expect(hasPlaintextSecrets(encrypted)).toBe(false)
  })

  it('旧版明文配置能被读出来，迁移后变成密文', async () => {
    const root = await makeRoot()
    // 模拟旧版本写下的配置
    const legacy = deepMerge(DEFAULT_CONFIG, { plugins: { 'provider-openai': { apiKey: SECRET } } })
    await writeFile(configFilePath(root), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

    const loaded = await loadConfig(root, fakeSecureCodec)
    expect(loaded.plugins['provider-openai']?.['apiKey']).toBe(SECRET)
    expect(hasPlaintextSecrets(loaded)).toBe(true)

    // 启动时的迁移动作
    await saveConfig(root, loaded, fakeSecureCodec)
    const raw = await rawConfig(root)
    expect(raw).not.toContain(SECRET)
    expect(raw).toContain('apiKeyEncrypted')
  })
})

describe('容错加载与编解码器无关', () => {
  it('配置损坏时回退缺省配置并给出警告', async () => {
    const root = await makeRoot()
    await writeFile(configFilePath(root), '{ 这不是 JSON', 'utf8')
    const { config, warning } = await loadConfigResilient(root, fakeSecureCodec)
    expect(warning).toContain('已备份原文件')
    expect(config.search.id).toBe(DEFAULT_CONFIG.search.id)
  })
})
