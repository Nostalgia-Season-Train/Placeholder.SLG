/**
 * 0~5 级地的视觉预设。
 * 等级越高，地势越高、颜色越偏岩石/雪线，装饰物也从草丛过渡到树林与山峰。
 */
export interface TerrainLevelDef {
  level: number
  name: string
  /** 地块顶面到基准面的高度（世界单位） */
  height: number
  /** 顶面颜色（十六进制） */
  color: number
  /** 悬停面板里的简短描述 */
  desc: string
}

/** 河道两侧的滩涂地块（不属于 0~5 级地） */
export const BANK_HEIGHT = 0.05
export const BANK_COLOR = 0xb7a67a

export const TERRAIN_LEVELS: TerrainLevelDef[] = [
  { level: 0, name: '荒地', height: 0.14, color: 0x9a9063, desc: '干枯的平原，几乎没有产出' },
  { level: 1, name: '草地', height: 0.2, color: 0x6f9a3e, desc: '低缓的草地，基础资源地' },
  { level: 2, name: '林地', height: 0.32, color: 0x557f34, desc: '灌木与零散树木覆盖' },
  { level: 3, name: '丘陵', height: 0.58, color: 0x6d7a4a, desc: '起伏的丘陵，视野受阻' },
  { level: 4, name: '山地', height: 0.95, color: 0x7f7d6e, desc: '岩壁陡峭，无法通行' },
  { level: 5, name: '高山', height: 1.4, color: 0x92969c, desc: '雪线之上的险峻地形，无法通行' },
]

export function getTerrainLevel(level: number): TerrainLevelDef {
  const index = Math.max(0, Math.min(TERRAIN_LEVELS.length - 1, level))
  return TERRAIN_LEVELS[index]!
}
