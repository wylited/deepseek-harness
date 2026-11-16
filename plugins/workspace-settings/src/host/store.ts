/**
 * Per-workspace settings store. One JSON document per workspace under
 * `$DSH_HOME/workspace-settings/<workspaceId>.json` (same state area notify's
 * push store uses). Writes are atomic (tmp + rename); reads are tolerant — a
 * missing or corrupt file yields the empty document, and hand-edited files
 * never surface fields outside the schema. The schema rejects unknown fields
 * on the write path (schemastery object mode silently merges unknown keys, so
 * the routes layer rejects them explicitly before saving).
 * @module workspace-settings/host/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/**
 * Every sandbox mode, mirroring `SANDBOX_MODES`
 * (packages/sandbox/sandbox-policy/src/session-mode.ts). Restated locally so
 * the plugin carries no runtime sandbox package dependency.
 */
export const SANDBOX_MODE_SETTINGS = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type SandboxModeSetting = (typeof SANDBOX_MODE_SETTINGS)[number]

/** One workspace's settings document; every field is optional. */
export interface WorkspaceSettings {
  /** Agent preset id applied to new sessions (stored; enforcement wiring pending). */
  agentPreset?: string
  /** Provider route for the session-scoped model selection. */
  provider?: string
  /** Provider-owned model id for the session-scoped model selection. */
  model?: string
  /** Reasoning effort riding inside the model selection (requires provider+model). */
  reasoningEffort?: string
  /** Sandbox mode appended as the session's `sandbox/mode` override. */
  sandboxMode?: SandboxModeSetting
  /** MCP server allowlist; servers outside it have their tools masked. */
  mcpServers?: string[]
}

/** The schema's fields; anything else is rejected on write, dropped on read. */
export const WORKSPACE_SETTINGS_KEYS: readonly (keyof WorkspaceSettings)[] = [
  'agentPreset', 'provider', 'model', 'reasoningEffort', 'sandboxMode', 'mcpServers',
]

/**
 * The untrusted-document schema: all fields optional, values shape-checked.
 * The cast mirrors plugins/notify's Config idiom (the inferred type is
 * structurally what `WorkspaceSettings` declares).
 */
export const WorkspaceSettingsSchema = z.object({
  agentPreset: z.string(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  sandboxMode: z.union(SANDBOX_MODE_SETTINGS.map(mode => z.const(mode))),
  mcpServers: z.array(z.string()),
}) as z<Record<string, unknown>, WorkspaceSettings>

/** Validate one untrusted settings document; throws on shape violations. */
export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  return WorkspaceSettingsSchema(raw)
}

/** Field names in one raw document that the schema does not admit. */
export function unknownSettingKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  return Object.keys(raw).filter(key => !WORKSPACE_SETTINGS_KEYS.includes(key as keyof WorkspaceSettings))
}

/** `$DSH_HOME`, falling back to `$HOME/.dsh` (the notify store's resolution). */
export function resolveHomePath(): string {
  return process.env['DSH_HOME'] ?? join(process.env['HOME'] ?? '.', '.dsh')
}

/** Registry ids are uuids, but the id also arrives from URL segments — guard the filename seam. */
const WORKSPACE_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/

/**
 * Reject ids that could escape the settings directory.
 * @param id - raw workspace id from the registry or the request path.
 * @throws when the id is not a safe single path segment.
 */
export function assertWorkspaceId(id: string): void {
  if (!WORKSPACE_ID_PATTERN.test(id) || id.includes('..')) {
    throw new Error(`invalid workspace id ${JSON.stringify(id)}`)
  }
}

/** The JSON document path for one workspace's settings. */
export function settingsPath(homePath: string, workspaceId: string): string {
  assertWorkspaceId(workspaceId)
  return join(homePath, 'workspace-settings', `${workspaceId}.json`)
}

/**
 * Load one workspace's settings; a missing, corrupt, or schema-invalid file
 * yields the empty document, and only schema fields are served.
 */
export function loadSettings(homePath: string, workspaceId: string): WorkspaceSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(settingsPath(homePath, workspaceId), 'utf8'))
  } catch {
    return {}
  }
  try {
    const stored = parseWorkspaceSettings(parsed) as Record<string, unknown>
    const picked: Record<string, unknown> = {}
    for (const key of WORKSPACE_SETTINGS_KEYS) {
      if (key in stored) picked[key] = stored[key]
    }
    return picked as WorkspaceSettings
  } catch {
    return {}
  }
}

/** Atomically replace one workspace's settings (tmp + rename, like notify's push store). */
export function saveSettings(homePath: string, workspaceId: string, settings: WorkspaceSettings): void {
  const path = settingsPath(homePath, workspaceId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(settings, null, 2))
  renameSync(`${path}.tmp`, path)
}
