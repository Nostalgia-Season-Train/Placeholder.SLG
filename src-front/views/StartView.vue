<script setup lang="ts">
/**
 * 开局界面：继续当前对局、开始新游戏、读取存档、管理角色库、LLM 设置。
 * 同盟配置只在「开始游戏」时提交并由服务端重建世界。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import CharacterForm from '../components/CharacterForm.vue'
import LlmSettings from '../components/LlmSettings.vue'
import { WorldApi } from '@/game/api/client'
import { decodeSnapshot } from '@shared/codec'
import { createDiplomacy, RELATION_STYLES, relationStyleOf } from '@/game/bot/diplomacy'
import {
  ALLIANCE_RELATIONS,
  ALLIANCE_RELATION_LABELS,
  FACTION_NAMES,
  GENERAL_TEAMS,
  type AllianceConfig,
  type AllianceRelation,
  type Faction,
  type GeneralTeam,
} from '@shared/types'
import type { CardCreateDTO, CharacterCardDTO, SaveSummaryDTO } from '@shared/protocol'

const api = new WorldApi()
const router = useRouter()

const FACTION_SLOTS: Faction[] = ['red', 'cyan', 'gold']

type Pane = 'continue' | 'new' | 'load' | 'library' | 'settings'

const MENU: { key: Pane; label: string; desc: string }[] = [
  { key: 'continue', label: '继续', desc: '回到上次对局' },
  { key: 'new', label: '新游戏', desc: '配置同盟并分配角色' },
  { key: 'load', label: '读取存档', desc: '从手动存档开始' },
  { key: 'library', label: '角色库', desc: '角色属性管理' },
  { key: 'settings', label: '设置', desc: 'LLM 与连接' },
]

const pane = ref<Pane>('continue')
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')

const alliances = ref<AllianceConfig[]>([])
const cards = ref<CharacterCardDTO[]>([])
const saves = ref<SaveSummaryDTO[]>([])
const currentRound = ref(0)
const running = ref(true)

const formOpen = ref(false)
const formMode = ref<'assign' | 'library'>('library')
const editingCard = ref<CharacterCardDTO | null>(null)

const availableSlots = computed(() =>
  FACTION_SLOTS.filter((faction) => !alliances.value.some((item) => item.faction === faction)),
)
const canAddAlliance = computed(() => availableSlots.value.length > 0)
const diplomacy = computed(() => createDiplomacy(alliances.value))
/** 只有我方同盟分团 */
const selfFaction = computed(
  () => alliances.value.find((alliance) => alliance.relation === 'self')?.faction ?? 'red',
)
/** 已加入本局的角色与角色库中的闲置角色 */
const rosterCards = computed(() => cards.value.filter((card) => card.active))
const idleCards = computed(() => cards.value.filter((card) => !card.active))

interface RosterGroup {
  key: string
  label: string
  names: string
  color: string
  cards: CharacterCardDTO[]
}

/** 出战角色按关系分组：我方 / 友方 / 敌方；所属同盟已停用的角色单独成组 */
const rosterGroups = computed<RosterGroup[]>(() => {
  const groups: RosterGroup[] = ALLIANCE_RELATIONS.map((relation) => {
    const members = alliances.value.filter((item) => item.relation === relation)
    return {
      key: relation,
      label: ALLIANCE_RELATION_LABELS[relation],
      names: members.map((item) => item.name).join('、'),
      color: `#${RELATION_STYLES[relation].fill.toString(16).padStart(6, '0')}`,
      cards: rosterCards.value.filter((card) =>
        members.some((item) => item.faction === card.faction),
      ),
    }
  })
  const enabled = new Set(alliances.value.map((item) => item.faction))
  const orphans = rosterCards.value.filter((card) => !enabled.has(card.faction))
  if (orphans.length > 0) {
    groups.push({ key: 'unassigned', label: '未启用同盟', names: '', color: '#8c9a9d', cards: orphans })
  }
  return groups.filter((group) => group.cards.length > 0)
})

function allianceNameOf(faction: Faction): string {
  const alliance = alliances.value.find((item) => item.faction === faction)
  return alliance ? alliance.name : `${FACTION_NAMES[faction]}（未启用）`
}

function relationLabel(relation: AllianceRelation): string {
  return ALLIANCE_RELATION_LABELS[relation]
}

function relationColor(faction: Faction): string {
  return `#${relationStyleOf(diplomacy.value, faction).fill.toString(16).padStart(6, '0')}`
}

/* ------------------------------------------------------------------ */
/* 同盟配置                                                            */
/* ------------------------------------------------------------------ */

function setRelation(alliance: AllianceConfig, relation: AllianceRelation): void {
  if (relation === 'self') {
    // 我方唯一：原来标为我方的同盟自动降为友方
    for (const item of alliances.value) {
      if (item.relation === 'self') item.relation = 'friendly'
    }
  }
  alliance.relation = relation
}

function addAlliance(): void {
  const faction = availableSlots.value[0]
  if (!faction) return
  const hasSelf = alliances.value.some((item) => item.relation === 'self')
  alliances.value.push({
    faction,
    name: FACTION_NAMES[faction],
    relation: hasSelf ? 'friendly' : 'self',
  })
}

function removeAlliance(faction: Faction): void {
  const removed = alliances.value.find((item) => item.faction === faction)
  alliances.value = alliances.value.filter((item) => item.faction !== faction)
  if (removed?.relation === 'self' && alliances.value.length > 0) {
    alliances.value[0]!.relation = 'self'
  }
}

/* ------------------------------------------------------------------ */
/* 角色库                                                              */
/* ------------------------------------------------------------------ */

function cardMeta(card: CharacterCardDTO): string {
  const parts: string[] = [card.role]
  if (card.personality.length > 0) parts.push(card.personality.join('、'))
  return parts.join(' · ')
}

/** 对局内的角色才展示职位，角色库不暴露职位字段 */
function rosterMeta(card: CharacterCardDTO): string {
  const parts = [card.role, `职位 ${card.position === '无' ? '无（上前线）' : card.position}`]
  if (card.personality.length > 0) parts.push(card.personality.join('、'))
  return parts.join(' · ')
}

function cardPayload(card: CharacterCardDTO, patch: Partial<CardCreateDTO> = {}): CardCreateDTO {
  return {
    name: card.name,
    faction: card.faction,
    team: card.team,
    role: card.role,
    position: card.position,
    attack: card.attack,
    magic: card.magic,
    personality: card.personality,
    description: card.description,
    dialoguePrompt: card.dialoguePrompt,
    authorNote: card.authorNote,
    active: card.active,
    ...patch,
  }
}

async function patchCard(card: CharacterCardDTO, patch: Partial<CardCreateDTO>): Promise<void> {
  try {
    cards.value = (await api.updateCard(card.id, cardPayload(card, patch))).cards
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '角色更新失败'
  }
}

function onCardFactionChange(card: CharacterCardDTO, faction: Faction): void {
  // 只有我方同盟分团，换到其他同盟时清空团
  void patchCard(card, { faction, ...(faction === selfFaction.value ? {} : { team: null }) })
}

function onCardTeamChange(card: CharacterCardDTO, team: string): void {
  void patchCard(card, { team: team ? (team as GeneralTeam) : null })
}

/** 从角色库加入本局 / 移回角色库 */
function setCardActive(card: CharacterCardDTO, active: boolean): void {
  void patchCard(card, { active })
}

function openCreateCard(mode: 'assign' | 'library' = 'library'): void {
  formMode.value = mode
  editingCard.value = null
  formOpen.value = true
}

function openEditCard(card: CharacterCardDTO, mode: 'assign' | 'library' = 'library'): void {
  formMode.value = mode
  editingCard.value = card
  formOpen.value = true
}

async function saveCard(payload: CardCreateDTO): Promise<void> {
  try {
    cards.value = editingCard.value
      ? (await api.updateCard(editingCard.value.id, payload)).cards
      : (await api.createCard(payload)).cards
    formOpen.value = false
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '角色保存失败'
  }
}

/* ------------------------------------------------------------------ */
/* 对局与存档                                                          */
/* ------------------------------------------------------------------ */

function enterWorld(): void {
  void router.push({ name: 'map' })
}

async function startGame(): Promise<void> {
  if (busy.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const names = new Set<string>()
    for (const alliance of alliances.value) {
      const name = alliance.name.trim()
      if (!name) throw new Error('同盟名称不能为空')
      if (names.has(name)) throw new Error('同盟名称不可重复')
      names.add(name)
    }
    await api.setAlliances(alliances.value.map((item) => ({ ...item, name: item.name.trim() })))
    await api.reset()
    await router.push({ name: 'map' })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '开始游戏失败'
  } finally {
    busy.value = false
  }
}

async function enterSave(id: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    await api.loadSave(id)
    await router.push({ name: 'map' })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '读取存档失败'
  } finally {
    busy.value = false
  }
}

async function removeSave(id: string): Promise<void> {
  if (busy.value) return
  if (!window.confirm('确认删除该存档？')) return
  busy.value = true
  try {
    saves.value = (await api.deleteSave(id)).saves
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除存档失败'
  } finally {
    busy.value = false
  }
}

function formatSavedAt(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

onMounted(async () => {
  try {
    const [world, cardList, saveList] = await Promise.all([
      api.getWorld(),
      api.listCards(),
      api.listSaves(),
    ])
    alliances.value = world.alliances.map((item) => ({ ...item }))
    currentRound.value = decodeSnapshot(world.snapshot).round
    running.value = world.state.running
    cards.value = cardList.cards
    saves.value = saveList.saves
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法连接后端服务'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="start-page">
    <div class="vignette"></div>

    <header class="start-head">
      <h1>季前列车</h1>
      <p>继续当前对局、开始新游戏、读取存档、管理角色库与设置</p>
    </header>

    <div class="start-layout">
      <nav class="start-nav">
        <button
          v-for="item in MENU"
          :key="item.key"
          type="button"
          :class="{ active: pane === item.key }"
          @click="pane = item.key"
        >
          <span class="nav-title">{{ item.label }}</span>
          <span class="nav-desc">{{ item.desc }}</span>
        </button>
      </nav>

      <main class="start-body">
        <section v-if="pane === 'continue'" class="panel section">
          <header class="section-head">
            <h2>继续游戏</h2>
            <span class="meta">{{ running ? '推演进行中' : '推演已暂停' }}</span>
          </header>
          <div class="world-stats">
            <div class="stat">
              <span class="stat-label">当前回合</span>
              <strong>{{ currentRound }}</strong>
            </div>
            <div class="stat">
              <span class="stat-label">同盟</span>
              <strong>{{ alliances.length }}</strong>
            </div>
          </div>
          <ul class="alliance-chips">
            <li v-for="alliance in alliances" :key="alliance.faction">
              <span class="swatch" :style="{ background: relationColor(alliance.faction) }"></span>
              <span>{{ alliance.name }}</span>
              <span class="meta">{{ relationLabel(alliance.relation) }}</span>
            </li>
          </ul>
          <div class="section-actions">
            <button type="button" :disabled="loading" @click="enterWorld">继续游戏</button>
            <span class="meta">回到上次对局的地图与频道</span>
          </div>
        </section>

        <template v-else-if="pane === 'new'">
          <section class="panel section">
            <header class="section-head">
              <h2>同盟</h2>
              <span class="meta">最多 3 个 · 恰有一个我方</span>
            </header>

            <ul class="alliance-list">
              <li v-for="alliance in alliances" :key="alliance.faction">
                <input v-model="alliance.name" type="text" maxlength="12" placeholder="同盟名称" />
                <div class="segmented">
                  <button
                    v-for="relation in ALLIANCE_RELATIONS"
                    :key="relation"
                    type="button"
                    :class="{ active: alliance.relation === relation }"
                    @click="setRelation(alliance, relation)"
                  >
                    {{ relationLabel(relation) }}
                  </button>
                </div>
                <button type="button" class="icon" @click="removeAlliance(alliance.faction)">
                  ×
                </button>
              </li>
            </ul>

            <div class="section-actions">
              <button type="button" class="ghost" :disabled="!canAddAlliance" @click="addAlliance">
                添加同盟
              </button>
              <span v-if="!canAddAlliance" class="meta">三块预置出生区已全部启用</span>
            </div>
          </section>

          <section class="panel section">
            <header class="section-head">
              <h2>出战角色</h2>
              <span class="meta">共 {{ rosterCards.length }} 名 · 指定所属同盟与团</span>
            </header>

            <div v-for="group in rosterGroups" :key="group.key" class="roster-group">
              <div class="roster-group-head">
                <span class="swatch" :style="{ background: group.color }"></span>
                <strong>{{ group.label }}</strong>
                <span class="meta">
                  {{ group.names || '未启用' }} · {{ group.cards.length }} 名
                </span>
              </div>
              <ul class="card-list">
                <li v-for="card in group.cards" :key="card.id">
                  <div class="card-info">
                    <strong>{{ card.name }}{{ card.builtin ? ' · 内置' : '' }}</strong>
                    <span class="meta">{{ rosterMeta(card) }}</span>
                  </div>
                  <select
                    v-if="card.faction === selfFaction"
                    :value="card.team ?? ''"
                    @change="onCardTeamChange(card, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">无团</option>
                    <option v-for="team in GENERAL_TEAMS" :key="team" :value="team">{{ team }}</option>
                  </select>
                  <span v-else class="meta team-none">不分团</span>
                  <select
                    :value="card.faction"
                    @change="onCardFactionChange(card, ($event.target as HTMLSelectElement).value as Faction)"
                  >
                    <option
                      v-for="alliance in alliances"
                      :key="alliance.faction"
                      :value="alliance.faction"
                    >
                      {{ alliance.name }}
                    </option>
                    <option
                      v-if="!alliances.some((item) => item.faction === card.faction)"
                      :value="card.faction"
                    >
                      {{ allianceNameOf(card.faction) }}
                    </option>
                  </select>
                  <button type="button" class="ghost" @click="openEditCard(card, 'assign')">
                    编辑
                  </button>
                  <button type="button" class="ghost" @click="setCardActive(card, false)">移除</button>
                </li>
              </ul>
            </div>
            <p v-if="!rosterCards.length" class="meta">暂无出战角色，从下方角色库添加。</p>

            <div class="section-actions">
              <button type="button" :disabled="busy || loading" @click="startGame">
                {{ busy ? '开局中…' : '开始游戏' }}
              </button>
              <span class="meta">开始游戏会清空当前对局进度，地图保持固定预制</span>
            </div>
          </section>

          <section class="panel section">
            <header class="section-head">
              <h2>角色库（未加入）</h2>
              <span class="meta">{{ idleCards.length }} 名 · 可加入本局</span>
            </header>

            <ul class="card-list">
              <li v-for="card in idleCards" :key="card.id">
                <div class="card-info">
                  <strong>{{ card.name }}{{ card.builtin ? ' · 内置' : '' }}</strong>
                  <span class="meta">{{ cardMeta(card) }}</span>
                </div>
                <button type="button" class="ghost" @click="openEditCard(card, 'library')">
                  编辑
                </button>
                <button type="button" class="ghost" @click="setCardActive(card, true)">添加</button>
              </li>
            </ul>
            <p v-if="!idleCards.length" class="meta">角色库中的角色都已加入本局。</p>

            <div class="section-actions">
              <button type="button" class="ghost" @click="openCreateCard('library')">
                添加角色
              </button>
              <span class="meta">新建角色默认只进入角色库，加入本局后才会出现在地图上</span>
            </div>
          </section>
        </template>

        <section v-else-if="pane === 'load'" class="panel section">
          <header class="section-head">
            <h2>读取存档</h2>
            <span class="meta">共 {{ saves.length }} 个</span>
          </header>

          <ul class="save-list">
            <li v-for="item in saves" :key="item.id">
              <div class="card-info">
                <strong>{{ item.label }}</strong>
                <span class="meta">第 {{ item.round }} 回合 · {{ formatSavedAt(item.savedAt) }}</span>
              </div>
              <button type="button" :disabled="busy" @click="enterSave(item.id)">读取并进入</button>
              <button type="button" class="ghost" :disabled="busy" @click="removeSave(item.id)">
                删除
              </button>
            </li>
          </ul>
          <p v-if="!saves.length && !loading" class="meta">暂无手动存档。</p>
        </section>

        <section v-else-if="pane === 'library'" class="panel section">
          <header class="section-head">
            <h2>角色库</h2>
            <span class="meta">共 {{ cards.length }} 名 · 角色属性与同盟无关</span>
          </header>

          <ul class="card-list">
            <li v-for="card in cards" :key="card.id">
              <div class="card-info">
                <strong>{{ card.name }}{{ card.builtin ? ' · 内置' : '' }}</strong>
                <span class="meta">{{ cardMeta(card) }}</span>
              </div>
              <span v-if="!card.active" class="tag">未加入</span>
              <button type="button" class="ghost" @click="openEditCard(card, 'library')">
                编辑
              </button>
            </li>
          </ul>

          <div class="section-actions">
            <button type="button" class="ghost" @click="openCreateCard('library')">添加角色</button>
            <span class="meta">新建角色默认只进入角色库；是否出战在新游戏中决定</span>
          </div>
        </section>

        <section v-else class="panel section">
          <header class="section-head">
            <h2>设置</h2>
            <span class="meta">LLM 模式与连接</span>
          </header>
          <LlmSettings />
          <p class="meta">推演速度、存档与角色管理在对局内的设置面板中。</p>
        </section>
      </main>
    </div>

    <footer class="start-foot">
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
      <p v-else-if="loading" class="meta">读取配置中…</p>
      <span class="meta">同盟关系：我方绿 · 友方蓝 · 敌方红</span>
    </footer>

    <CharacterForm
      v-if="formOpen"
      :card="editingCard"
      :alliances="alliances"
      :mode="formMode"
      :busy="false"
      :error="errorMessage"
      @save="saveCard"
      @close="formOpen = false"
    />
  </div>
</template>

<style scoped>
.start-page {
  position: relative;
  height: 100dvh;
  padding: 32px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  background: radial-gradient(circle at 50% 20%, #16222b 0%, #080d11 72%);
  color: #e9e4d6;
  overflow: hidden;
}

.vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(circle at 50% 45%, transparent 45%, rgba(0, 0, 0, 0.42) 100%);
}

.start-head,
.start-layout,
.start-foot {
  position: relative;
  z-index: 1;
  width: min(920px, 100%);
  margin: 0 auto;
}

.start-head h1 {
  font-size: 20px;
  letter-spacing: 0.14em;
  color: #f1e6c8;
}

.start-head p {
  margin-top: 6px;
  font-size: 12px;
  letter-spacing: 0.06em;
  color: #93a3a8;
}

.start-layout {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 14px;
  flex: 1;
  min-height: 0;
}

.start-nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
  border: 1px solid rgba(214, 186, 122, 0.28);
  border-radius: 12px;
  background: rgba(12, 19, 24, 0.78);
  backdrop-filter: blur(10px);
}

.start-nav button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 9px 12px;
  background: transparent;
  color: #9fadb0;
  text-align: left;
  cursor: pointer;
}

.start-nav button.active {
  border-color: rgba(214, 186, 122, 0.55);
  background: rgba(214, 186, 122, 0.16);
  color: #f0dfb4;
}

.nav-title {
  font-size: 13px;
  letter-spacing: 0.1em;
}

.nav-desc {
  font-size: 10px;
  color: #7d8d92;
}

.start-nav button.active .nav-desc {
  color: #b7a778;
}

.start-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 186, 122, 0.45) transparent;
}

.start-body::-webkit-scrollbar {
  width: 8px;
}

.start-body::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: rgba(214, 186, 122, 0.35);
}

.start-body::-webkit-scrollbar-thumb:hover {
  background: rgba(214, 186, 122, 0.55);
}

.panel {
  border: 1px solid rgba(214, 186, 122, 0.28);
  border-radius: 12px;
  background: rgba(12, 19, 24, 0.78);
  backdrop-filter: blur(10px);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
}

.section {
  padding: 16px 18px 18px;
}

.section-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}

.section-head h2 {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.18em;
  color: #c8b98e;
}

.meta {
  font-size: 11px;
  color: #7d8d92;
}

.tag {
  flex: none;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10px;
  color: #9fadb0;
}

.team-none {
  flex: none;
  box-sizing: border-box;
  width: 108px;
  padding: 5px 7px;
  text-align: center;
}

.roster-group + .roster-group {
  margin-top: 14px;
}

.roster-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.roster-group-head strong {
  font-size: 12px;
  font-weight: 500;
  color: #e9dcc0;
}

.world-stats {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(8, 13, 17, 0.6);
}

.stat-label {
  font-size: 11px;
  color: #7d8d92;
}

.stat strong {
  font-size: 18px;
  font-weight: 500;
  color: #f0dfb4;
}

.alliance-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  list-style: none;
}

.alliance-chips li {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  padding: 4px 10px;
  background: rgba(8, 13, 17, 0.6);
  font-size: 12px;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.alliance-list,
.card-list,
.save-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
}

.alliance-list li,
.card-list li,
.save-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 8px 10px;
  background: rgba(8, 13, 17, 0.6);
}

.alliance-list input {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(214, 186, 122, 0.3);
  border-radius: 6px;
  padding: 6px 8px;
  background: rgba(8, 13, 17, 0.85);
  color: #e9e4d6;
  font-size: 12px;
}

.segmented {
  display: flex;
  flex: none;
  gap: 2px;
  padding: 2px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
}

.segmented button {
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px 10px;
  background: transparent;
  color: #9fadb0;
  font-size: 12px;
  letter-spacing: 0.06em;
  cursor: pointer;
}

.segmented button.active {
  border-color: rgba(214, 186, 122, 0.5);
  background: rgba(214, 186, 122, 0.16);
  color: #f0dfb4;
}

.card-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.card-info strong {
  font-size: 12px;
  font-weight: 500;
  color: #e9e4d6;
}

.card-list select {
  flex: none;
  width: 108px;
  border: 1px solid rgba(214, 186, 122, 0.3);
  border-radius: 6px;
  padding: 5px 7px;
  background: rgba(8, 13, 17, 0.85);
  color: #e9e4d6;
  font-size: 11px;
}

.section-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

button.ghost,
.section-actions button,
.save-list button {
  border: 1px solid rgba(214, 186, 122, 0.5);
  border-radius: 6px;
  padding: 6px 12px;
  background: rgba(214, 186, 122, 0.18);
  color: #f0dfb4;
  font-size: 12px;
  cursor: pointer;
}

button.ghost {
  border-color: rgba(255, 255, 255, 0.16);
  background: transparent;
  color: #9fadb0;
}

button.icon {
  flex: none;
  width: 26px;
  height: 26px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: transparent;
  color: #9fadb0;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

button:disabled {
  opacity: 0.45;
  cursor: default;
}

.start-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border: 1px solid rgba(214, 186, 122, 0.28);
  border-radius: 12px;
  background: rgba(12, 19, 24, 0.78);
}

.error {
  font-size: 12px;
  color: #e09191;
}

@media (max-width: 720px) {
  .start-page {
    padding: 20px 12px 16px;
  }

  .start-layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .start-nav {
    flex-direction: row;
    overflow-x: auto;
  }

  .start-nav button {
    flex: none;
  }

  .alliance-list li,
  .card-list li,
  .save-list li {
    flex-wrap: wrap;
  }
}
</style>
