// Wrappers around the storage_* Rust commands.
// One place to keep the surface area honest as the schema evolves.
import { invoke } from '@tauri-apps/api/core'

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
  return invoke<StorageInfo>('storage_info')
}

export function backupNow(): Promise<BackupInfo> {
  return invoke<BackupInfo>('backup_now')
}

export function resetDatabase(): Promise<void> {
  return invoke<void>('reset_database')
}

export function openConfigDir(): Promise<void> {
  return invoke<void>('open_config_dir')
}
