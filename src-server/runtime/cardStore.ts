/**
 * SQLite-backed character-card storage built on Node's built-in node:sqlite
 * module. Cards are configuration data, kept separate from world saves: a
 * fresh world spawns units from every card, a loaded save restores its own.
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CardCreateDTO, CharacterCardDTO } from '../../src-shared/protocol'
import type { GeneralTeam } from '../../src-shared/types'

const DB_PATH = resolve('src-server/data/cards.db')

/** Builtin cards seeded on first boot: one minister plus two vanguards per faction */
const BUILTIN_CARDS: CardCreateDTO[] = [
  {
    name: '云谦',
    faction: 'red',
    team: '本团',
    role: '术武将',
    position: '大臣',
    attack: '高',
    magic: '高',
    personality: '沉稳、多疑',
    description: '北庭大臣，惯于坐镇后方权衡全局，行事务求稳妥。',
    dialoguePrompt: '言辞简练、深谋远虑，喜以问句引导他人自行领悟。',
    authorNote: '初始大臣卡，用于演示指挥链：不亲自上前线。',
  },
  {
    name: '朔风',
    faction: 'red',
    team: '本团',
    role: '武将',
    position: '无',
    attack: '高',
    magic: '低',
    personality: '勇猛、忠诚',
    description: '北庭先锋，冲锋在前，令出必行。',
    dialoguePrompt: '语气干脆，军令如山，常用短句。',
    authorNote: '初始武将卡。',
  },
  {
    name: '烈风',
    faction: 'red',
    team: '团1',
    role: '武将',
    position: '无',
    attack: '高',
    magic: '低',
    personality: '激进',
    description: '北庭急先锋，信奉先下手为强。',
    dialoguePrompt: '语速快、攻势凌厉，蔑视犹豫。',
    authorNote: '初始武将卡。',
  },
  {
    name: '江叙',
    faction: 'cyan',
    team: null,
    role: '术武将',
    position: '大臣',
    attack: '高',
    magic: '高',
    personality: '沉稳、谨慎',
    description: '东川大臣，精于布局，落子前必先推演三步。',
    dialoguePrompt: '措辞温和缜密，习惯先复述局势再给出判断。',
    authorNote: '初始大臣卡。',
  },
  {
    name: '寒江',
    faction: 'cyan',
    team: null,
    role: '武将',
    position: '无',
    attack: '高',
    magic: '低',
    personality: '谨慎',
    description: '东川宿将，行军扎营皆按章法，少有失手。',
    dialoguePrompt: '冷静克制，汇报条理分明。',
    authorNote: '初始武将卡。',
  },
  {
    name: '听涛',
    faction: 'cyan',
    team: null,
    role: '武将',
    position: '无',
    attack: '高',
    magic: '低',
    personality: '沉稳',
    description: '东川边将，常年戍守，处变不惊。',
    dialoguePrompt: '话少而稳，偶有感慨，多与江声有关。',
    authorNote: '初始武将卡。',
  },
  {
    name: '岫远',
    faction: 'gold',
    team: null,
    role: '术武将',
    position: '大臣',
    attack: '高',
    magic: '高',
    personality: '多疑、沉稳',
    description: '西陵大臣，善以疑兵与缓势消耗对手。',
    dialoguePrompt: '口气疏淡，善用比喻，常在话中留三分余地。',
    authorNote: '初始大臣卡。',
  },
  {
    name: '狼烟',
    faction: 'gold',
    team: null,
    role: '武将',
    position: '无',
    attack: '高',
    magic: '低',
    personality: '好战',
    description: '西陵猛将，遇敌必战，战则求速决。',
    dialoguePrompt: '粗声大嗓，好斗嗜战，常催促开战。',
    authorNote: '初始武将卡。',
  },
  {
    name: '铁衣',
    faction: 'gold',
    team: null,
    role: '武将',
    position: '无',
    attack: '高',
    magic: '低',
    personality: '忠诚、谨慎',
    description: '西陵老卒，护主心切，临阵不退。',
    dialoguePrompt: '朴实厚重，以职责为先，不尚空谈。',
    authorNote: '初始武将卡。',
  },
]

function openDatabase(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const database = new DatabaseSync(DB_PATH)
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS cards (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      faction         TEXT NOT NULL,
      team            TEXT NOT NULL DEFAULT '',
      role            TEXT NOT NULL,
      position        TEXT NOT NULL,
      attack          TEXT NOT NULL,
      magic           TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      personality     TEXT NOT NULL DEFAULT '',
      dialogue_prompt TEXT NOT NULL DEFAULT '',
      author_note     TEXT NOT NULL DEFAULT '',
      builtin         INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL
    );
  `)
  // 旧库没有团字段，启动时补齐
  const columns = database.prepare('PRAGMA table_info(cards)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'team')) {
    database.exec("ALTER TABLE cards ADD COLUMN team TEXT NOT NULL DEFAULT ''")
  }
  return database
}

const db = openDatabase()

const CARD_COLUMNS =
  'id, name, faction, team, role, position, attack, magic, description, personality, dialogue_prompt AS dialoguePrompt, author_note AS authorNote, builtin, created_at AS createdAt'

const listStatement = db.prepare(
  `SELECT ${CARD_COLUMNS} FROM cards ORDER BY created_at, id`,
)
const readStatement = db.prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ?`)
const insertStatement = db.prepare(`
  INSERT INTO cards (id, name, faction, team, role, position, attack, magic, description, personality, dialogue_prompt, author_note, builtin, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    faction = excluded.faction,
    team = excluded.team,
    role = excluded.role,
    position = excluded.position,
    attack = excluded.attack,
    magic = excluded.magic,
    description = excluded.description,
    personality = excluded.personality,
    dialogue_prompt = excluded.dialogue_prompt,
    author_note = excluded.author_note,
    builtin = excluded.builtin,
    created_at = excluded.created_at
`)
const updateStatement = db.prepare(`
  UPDATE cards SET
    name = ?, faction = ?, team = ?, role = ?, position = ?,
    attack = ?, magic = ?, description = ?, personality = ?,
    dialogue_prompt = ?, author_note = ?
  WHERE id = ?
`)

interface CardRow {
  id: string
  name: string
  faction: CharacterCardDTO['faction']
  team: string
  role: CharacterCardDTO['role']
  position: CharacterCardDTO['position']
  attack: CharacterCardDTO['attack']
  magic: CharacterCardDTO['magic']
  description: string
  personality: string
  dialoguePrompt: string
  authorNote: string
  builtin: number
  createdAt: string
}

function toDto(row: CardRow): CharacterCardDTO {
  return {
    id: row.id,
    name: row.name,
    faction: row.faction,
    team: row.team ? (row.team as GeneralTeam) : null,
    role: row.role,
    position: row.position,
    attack: row.attack,
    magic: row.magic,
    description: row.description,
    personality: row.personality,
    dialoguePrompt: row.dialoguePrompt,
    authorNote: row.authorNote,
    builtin: row.builtin === 1,
  }
}

function writeCard(id: string, input: CardCreateDTO, builtin: boolean): CharacterCardDTO {
  const dto: CharacterCardDTO = {
    id,
    name: input.name,
    faction: input.faction,
    team: input.team ?? null,
    role: input.role,
    position: input.position,
    attack: input.attack,
    magic: input.magic,
    description: input.description ?? '',
    personality: input.personality ?? '',
    dialoguePrompt: input.dialoguePrompt ?? '',
    authorNote: input.authorNote ?? '',
    builtin,
  }
  insertStatement.run(
    dto.id,
    dto.name,
    dto.faction,
    dto.team ?? '',
    dto.role,
    dto.position,
    dto.attack,
    dto.magic,
    dto.description,
    dto.personality,
    dto.dialoguePrompt,
    dto.authorNote,
    dto.builtin ? 1 : 0,
    new Date().toISOString(),
  )
  return dto
}

/** Seed the nine builtin cards the first time the database is created */
function seedBuiltinCards(): void {
  const row = db.prepare('SELECT COUNT(*) AS count FROM cards WHERE builtin = 1').get() as {
    count: number
  }
  if (row.count > 0) return
  BUILTIN_CARDS.forEach((card, index) => {
    writeCard(`builtin-${index + 1}`, card, true)
  })
}

seedBuiltinCards()

export function listCards(): CharacterCardDTO[] {
  return (listStatement.all() as unknown as CardRow[]).map(toDto)
}

export function insertCard(input: CardCreateDTO): CharacterCardDTO {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  return writeCard(id, input, false)
}

/** 全字段更新一张卡（内置卡同样可改）；卡不存在时返回 null */
export function updateCard(id: string, input: CardCreateDTO): CharacterCardDTO | null {
  const existing = readStatement.get(id) as CardRow | undefined
  if (!existing) return null

  updateStatement.run(
    input.name,
    input.faction,
    input.team ?? '',
    input.role,
    input.position,
    input.attack,
    input.magic,
    input.description ?? '',
    input.personality ?? '',
    input.dialoguePrompt ?? '',
    input.authorNote ?? '',
    id,
  )
  return toDto({
    ...existing,
    name: input.name,
    faction: input.faction,
    team: input.team ?? '',
    role: input.role,
    position: input.position,
    attack: input.attack,
    magic: input.magic,
    description: input.description ?? '',
    personality: input.personality ?? '',
    dialoguePrompt: input.dialoguePrompt ?? '',
    authorNote: input.authorNote ?? '',
  })
}

export function closeCardStore(): void {
  db.close()
}
