/**
 * Codec between runtime game objects and the JSON wire format.
 * Pure functions so both the server and the browser can use them.
 */
import type { Faction, SimSnapshot } from './types'
import type { MapDTO, SnapshotDTO } from './protocol'
import type { MapData } from './map/MapGenerator'

export function decodeMap(dto: MapDTO): MapData {
  const tileMap = new Map<string, MapData['tiles'][number]>()
  for (const tile of dto.tiles) tileMap.set(`${tile.q},${tile.r}`, tile)
  return { ...dto, tileMap }
}

export function encodeSnapshot(snapshot: SimSnapshot): SnapshotDTO {
  return { ...snapshot, occupation: [...snapshot.occupation.entries()] }
}

export function decodeSnapshot(dto: SnapshotDTO): SimSnapshot {
  return { ...dto, occupation: new Map(dto.occupation) }
}

/** Diff two occupation maps; `null` means the tile was released */
export function occupationPatch(
  previous: Map<string, Faction> | null,
  next: Map<string, Faction>,
): [string, Faction | null][] {
  const patch: [string, Faction | null][] = []
  if (!previous) return patch
  for (const [key, faction] of next) {
    if (previous.get(key) !== faction) patch.push([key, faction])
  }
  for (const key of previous.keys()) {
    if (!next.has(key)) patch.push([key, null])
  }
  return patch
}

export function applyOccupationPatch(
  occupation: Map<string, Faction>,
  patch: [string, Faction | null][],
): Map<string, Faction> {
  const next = new Map(occupation)
  for (const [key, faction] of patch) {
    if (faction === null) next.delete(key)
    else next.set(key, faction)
  }
  return next
}
