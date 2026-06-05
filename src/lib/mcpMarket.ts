// MCP market — browse + install servers from the official MCP Registry (or a
// custom source / pasted blob with the same schema), and turn a catalog entry
// into a `McpServerConfig`. Remote (Streamable-HTTP) servers install on every
// platform; local (stdio package) servers only where we can spawn a process
// (desktop / self-hosted web), so each installable carries a platform tag the
// UI filters on.
//
// Schema verified against the live `registry.modelcontextprotocol.io` API
// (server.json): each list item is `{ server, _meta }`; a server exposes
// `remotes[]` (transport `streamable-http` / `sse`, `url`, `headers[]`) and/or
// `packages[]` (`registryType`, `identifier`, `version`, `runtimeHint`,
// `transport`, `runtimeArguments[]`, `packageArguments[]`,
// `environmentVariables[]`).
import { api } from '../services/api'
import { getSetting, setSetting } from './store'
import type { McpServerConfig } from './mcp'

// ---------- raw registry shapes (only the fields we read) ----------

interface RawKeyInput {
  name?: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  default?: string
}
interface RawArg {
  type?: 'positional' | 'named'
  name?: string
  value?: string
  default?: string
  valueHint?: string
}
interface RawTransport {
  type?: string
  url?: string
}
interface RawRemote {
  type?: string
  url?: string
  headers?: RawKeyInput[]
}
interface RawPackage {
  registryType?: string
  identifier?: string
  version?: string
  runtimeHint?: string
  transport?: RawTransport
  runtimeArguments?: RawArg[]
  packageArguments?: RawArg[]
  environmentVariables?: RawKeyInput[]
}
interface RawServer {
  name?: string
  title?: string
  description?: string
  version?: string
  repository?: { url?: string }
  websiteUrl?: string
  icons?: { src?: string }[]
  remotes?: RawRemote[]
  packages?: RawPackage[]
}
interface RawItem {
  server?: RawServer
  _meta?: Record<string, unknown>
}
interface RawList {
  servers?: RawItem[]
  metadata?: { nextCursor?: string; count?: number }
}

// ---------- normalized catalog ----------

/** A required/optional input the installer must collect: an env var (stdio) or
 *  an HTTP header (remote). `secret` inputs are flagged for masked entry. */
export interface InputSpec {
  kind: 'env' | 'header'
  key: string
  description?: string
  required: boolean
  secret: boolean
  default?: string
}

/** A remote server: works on every platform. */
export interface HttpInstall {
  transport: 'http'
  /** 'all' — installable everywhere. */
  platform: 'all'
  url: string
  inputs: InputSpec[]
}

/** A local package server (npx/uvx/…): only where a process can be spawned. */
export interface StdioInstall {
  transport: 'stdio'
  /** 'desktop' — desktop + self-hosted web only (not native mobile). */
  platform: 'desktop'
  command: string
  args: string[]
  inputs: InputSpec[]
  registryType?: string
}

export type Installable = HttpInstall | StdioInstall

/** One server in the market, with every way we know how to install it. */
export interface CatalogEntry {
  /** Registry id (e.g. `io.github.foo/bar`); stable across versions. */
  id: string
  name: string
  description: string
  version?: string
  repositoryUrl?: string
  websiteUrl?: string
  iconUrl?: string
  deprecated: boolean
  installs: Installable[]
}

/** A browsable source. The official registry plus any user-added URLs share the
 *  same MCP-registry schema, so a source is just a base URL + label. */
export interface RegistrySource {
  id: string
  label: string
  url: string
}

export const OFFICIAL_SOURCE: RegistrySource = {
  id: 'official',
  label: 'registry.modelcontextprotocol.io',
  url: 'https://registry.modelcontextprotocol.io',
}

const SOURCES_KEY = 'mcpMarketSources'

/** Custom sources the user added (the official one is always prepended). */
export async function loadSources(): Promise<RegistrySource[]> {
  const v = await getSetting<RegistrySource[]>(SOURCES_KEY)
  const custom = Array.isArray(v) ? v : []
  return [OFFICIAL_SOURCE, ...custom]
}

export async function saveCustomSources(sources: RegistrySource[]): Promise<void> {
  // Never persist the built-in official source.
  await setSetting(
    SOURCES_KEY,
    sources.filter((s) => s.id !== OFFICIAL_SOURCE.id),
  )
}

// ---------- fetching + normalization ----------

export interface CatalogPage {
  entries: CatalogEntry[]
  nextCursor?: string
}

/** Fetch a page of servers from `source`, optionally filtered by `query` and
 *  paginated with `cursor`. Entries with no installable transport are dropped. */
export async function searchCatalog(
  source: RegistrySource,
  query: string,
  cursor?: string,
): Promise<CatalogPage> {
  const base = source.url.replace(/\/+$/, '')
  const u = new URL(`${base}/v0/servers`)
  u.searchParams.set('limit', '50')
  if (query.trim()) u.searchParams.set('search', query.trim())
  if (cursor) u.searchParams.set('cursor', cursor)
  const res = await fetch(u.toString(), { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  const data = (await res.json()) as RawList
  // The list endpoint returns every published version; keep only the latest of
  // each server and dedupe by id (a search can surface several versions).
  const entries = dedupeById(
    (data.servers ?? [])
      .filter(isLatestItem)
      .map(normalizeItem)
      .filter((e): e is CatalogEntry => e != null && e.installs.length > 0),
  )
  return { entries, nextCursor: data.metadata?.nextCursor }
}

/** Whether a list item is the latest version of its server. Absent metadata
 *  (e.g. a pasted single server) counts as latest. */
function isLatestItem(item: RawItem): boolean {
  const meta =
    (item._meta?.['io.modelcontextprotocol.registry/official'] as
      | Record<string, unknown>
      | undefined) ?? item._meta
  return meta?.isLatest !== false
}

function dedupeById(entries: CatalogEntry[]): CatalogEntry[] {
  const seen = new Set<string>()
  return entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
}

/** Parse a pasted blob: a registry list (`{servers:[…]}`), a bare array of
 *  items/servers, or a single `{server}` / server object. */
export function parsePastedCatalog(text: string): CatalogEntry[] {
  const data: unknown = JSON.parse(text)
  let items: RawItem[]
  if (data && typeof data === 'object' && Array.isArray((data as RawList).servers)) {
    items = (data as RawList).servers ?? []
  } else if (Array.isArray(data)) {
    items = data as RawItem[]
  } else {
    items = [data as RawItem]
  }
  return dedupeById(
    items
      .filter(isLatestItem)
      .map(normalizeItem)
      .filter((e): e is CatalogEntry => e != null && e.installs.length > 0),
  )
}

/** Accept either a `{server, _meta}` wrapper or a bare server object. */
function normalizeItem(item: RawItem): CatalogEntry | null {
  const server = item.server ?? (item as RawServer)
  if (!server || !server.name) return null
  const meta =
    (item._meta?.['io.modelcontextprotocol.registry/official'] as
      | Record<string, unknown>
      | undefined) ?? item._meta
  const deprecated = (meta?.status as string | undefined) === 'deprecated'

  const installs: Installable[] = []
  for (const r of server.remotes ?? []) {
    const inst = remoteToInstall(r)
    if (inst) installs.push(inst)
  }
  for (const p of server.packages ?? []) {
    const inst = packageToInstall(p)
    if (inst) installs.push(inst)
  }

  return {
    id: server.name,
    name: server.title?.trim() || server.name,
    description: server.description?.trim() ?? '',
    version: server.version,
    repositoryUrl: server.repository?.url,
    websiteUrl: server.websiteUrl,
    iconUrl: server.icons?.[0]?.src,
    deprecated,
    installs,
  }
}

function remoteToInstall(r: RawRemote): Installable | null {
  // We speak Streamable HTTP; legacy `sse` remotes aren't supported.
  if (!r.url || (r.type && r.type !== 'streamable-http')) return null
  return {
    transport: 'http',
    platform: 'all',
    url: r.url,
    inputs: (r.headers ?? []).map((h) => keyInput(h, 'header')),
  }
}

/** Map a registry package to a spawn command + args. */
function packageToInstall(p: RawPackage): Installable | null {
  const id = p.identifier
  if (!id) return null
  // A package can declare an http transport instead of a process.
  if (p.transport?.type && p.transport.type !== 'stdio') {
    if (!p.transport.url) return null
    return {
      transport: 'http',
      platform: 'all',
      url: p.transport.url,
      inputs: (p.environmentVariables ?? []).map((e) => keyInput(e, 'header')),
    }
  }
  const command = p.runtimeHint || runtimeForRegistry(p.registryType)
  if (!command) return null
  const args = [...renderArgs(p.runtimeArguments)]
  // npx/dnx/uvx run a published package non-interactively; ensure `-y` for npx.
  if (/(^|[\\/])npx$/.test(command) && !args.some((a) => a === '-y' || a === '--yes')) {
    args.push('-y')
  }
  args.push(packageSpec(p))
  args.push(...renderArgs(p.packageArguments))
  return {
    transport: 'stdio',
    platform: 'desktop',
    command,
    args,
    inputs: (p.environmentVariables ?? []).map((e) => keyInput(e, 'env')),
    registryType: p.registryType,
  }
}

/** The package token passed to the runtime. npm pins `id@version`; other
 *  ecosystems just take the identifier (their version syntax varies). */
function packageSpec(p: RawPackage): string {
  if (p.registryType === 'npm' && p.version) return `${p.identifier}@${p.version}`
  return p.identifier ?? ''
}

function runtimeForRegistry(registryType?: string): string {
  switch (registryType) {
    case 'npm':
      return 'npx'
    case 'pypi':
      return 'uvx'
    case 'nuget':
      return 'dnx'
    case 'oci':
      return 'docker'
    default:
      return ''
  }
}

/** Render a registry argument list to plain CLI tokens. Named args emit their
 *  flag (and value when one is known); positionals emit value/default/hint. */
function renderArgs(args?: RawArg[]): string[] {
  const out: string[] = []
  for (const a of args ?? []) {
    if (a.type === 'named' && a.name) {
      out.push(a.name)
      const v = a.value ?? a.default
      if (v != null && v !== '') out.push(String(v))
    } else {
      const v = a.value ?? a.default ?? a.valueHint
      if (v != null && v !== '') out.push(String(v))
    }
  }
  return out
}

function keyInput(k: RawKeyInput, kind: 'env' | 'header'): InputSpec {
  return {
    kind,
    key: k.name ?? '',
    description: k.description,
    required: k.isRequired ?? false,
    secret: k.isSecret ?? false,
    default: k.default,
  }
}

// ---------- platform gating + install ----------

/** Whether `inst` can be installed on the running platform. Remote works
 *  everywhere; stdio needs a process host (not native mobile). */
export function installAvailable(inst: Installable, platform: string): boolean {
  if (inst.transport === 'http') return true
  return platform !== 'android' && platform !== 'ios'
}

export async function currentPlatform(): Promise<string> {
  try {
    return await api.getPlatform()
  } catch {
    return 'web'
  }
}

/** Build an `McpServerConfig` from a chosen installable + collected input
 *  values. Empty/optional inputs are dropped; values are stored inline (the
 *  same plaintext Store the manual MCP form uses). */
export function installEntry(
  entry: CatalogEntry,
  inst: Installable,
  values: Record<string, string>,
): McpServerConfig {
  const env: string[] = []
  const headers: string[] = []
  for (const i of inst.inputs) {
    const v = (values[i.key] ?? i.default ?? '').trim()
    if (!v) continue
    if (i.kind === 'env') env.push(`${i.key}=${v}`)
    else headers.push(`${i.key}: ${v}`)
  }
  const base = { id: crypto.randomUUID(), name: entry.name, enabled: false }
  if (inst.transport === 'http') {
    return { ...base, transport: 'http', command: '', args: [], env: [], url: inst.url, headers }
  }
  return { ...base, transport: 'stdio', command: inst.command, args: inst.args, env, headers: [] }
}

/** Does an already-saved server look like this installable? (dedupe the
 *  "Install" button into "Installed"). */
export function isInstalled(inst: Installable, servers: McpServerConfig[]): boolean {
  return servers.some((s) => {
    if (inst.transport === 'http') return (s.transport ?? 'stdio') === 'http' && s.url === inst.url
    return (
      (s.transport ?? 'stdio') === 'stdio' &&
      s.command === inst.command &&
      s.args.join(' ') === inst.args.join(' ')
    )
  })
}
