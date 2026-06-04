// Wrappers around the storage backend surface. The transport lives in
// `services/{tauriApi,webApi}.ts`; this module owns the types + stable names.
import { api } from '../services/api'

export interface BackupInfo {
  path: string
  size: number
  /** Unix seconds. */
  modified: number
}

export interface StorageInfo {
  dbPath: string
  dbSize: number
  backupsDir: string
  backups: BackupInfo[]
}

export function storageInfo(): Promise<StorageInfo> {
  return api.storageInfo()
}

export function backupNow(): Promise<BackupInfo> {
  return api.backupNow()
}

export function resetDatabase(): Promise<void> {
  return api.resetDatabase()
}

export function openConfigDir(): Promise<void> {
  return api.openConfigDir()
}
