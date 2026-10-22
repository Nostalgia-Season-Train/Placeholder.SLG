/**
 * SQLite-backed save storage built on Node's built-in node:sqlite module.
 * One row per slot; the payload column holds the serialized world snapshot.
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SaveSummaryDTO, WorldSaveDTO } from '../../src-shared/protocol'

const DB_PATH = resolve('src-server/data/save.db')
const AUTO_SAVE_ID = 'autosave'
const ID_PATTERN = /^[a-z0-9-]+$/

function openDatabase(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const database = new DatabaseSync(DB_PATH)
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS saves (
      id       TEXT PRIMARY KEY,
      label    TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      round    INTEGER NOT NULL,
      seed     INTEGER NOT NULL,
      auto     INTEGER NOT NULL DEFAULT 0,
      payload  TEXT NOT NULL
    );
  `)
  return database
}

const db = openDatabase()

const listStatement = db.prepare(
  'SELECT id, label, saved_at AS savedAt, round, seed FROM saves WHERE auto = 0 ORDER BY saved_at DESC',
)
const readStatement = db.prepare('SELECT payload FROM saves WHERE id = ?')
const writeStatement = db.prepare(`
  INSERT INTO saves (id, label, saved_at, round, seed, auto, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    label = excluded.label,
    saved_at = excluded.saved_at,
    round = excluded.round,
    seed = excluded.seed,
    auto = excluded.auto,
    payload = excluded.payload
`)
const deleteStatement = db.prepare('DELETE FROM saves WHERE id = ?')

export function isValidSaveId(id: string): boolean {
  return ID_PATTERN.test(id)
}

export function listSaves(): SaveSummaryDTO[] {
  return listStatement.all() as unknown as SaveSummaryDTO[]
}

export function readSave(id: string): WorldSaveDTO | null {
  if (!isValidSaveId(id)) return null
  const row = readStatement.get(id) as { payload: string } | undefined
  if (!row) return null
  try {
    const save = JSON.parse(row.payload) as WorldSaveDTO
    return save.version === 1 ? save : null
  } catch {
    console.warn(`[slg] 存档 ${id} 无法解析，已忽略`)
    return null
  }
}

export function writeSave(id: string, save: WorldSaveDTO, auto = false): void {
  if (!isValidSaveId(id)) throw new Error('非法的存档标识')
  writeStatement.run(
    id,
    save.label,
    save.savedAt,
    save.round,
    save.state.seed,
    auto ? 1 : 0,
    JSON.stringify(save),
  )
}

export function deleteSave(id: string): boolean {
  if (!isValidSaveId(id)) return false
  const result = deleteStatement.run(id)
  return Number(result.changes) > 0
}

export function readAutoSave(): WorldSaveDTO | null {
  return readSave(AUTO_SAVE_ID)
}

export function writeAutoSave(save: WorldSaveDTO): void {
  writeSave(AUTO_SAVE_ID, save, true)
}

export function closeSaveStore(): void {
  db.close()
}
