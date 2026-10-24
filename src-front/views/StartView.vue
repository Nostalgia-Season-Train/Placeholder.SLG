<script setup lang="ts">
/**
 * 开局界面：新开局配置同盟与角色，或直接读取旧存档进入地图。
 * 配置只在「开始游戏」时生效，由服务端重建世界。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import CharacterForm from '../components/CharacterForm.vue'
import { WorldApi } from '@/game/api/client'
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

type Mode = 'new' | 'load'
const mode = ref<Mode>('new')
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')

const alliances = ref<AllianceConfig[]>([])
const cards = ref<CharacterCardDTO[]>([])
const saves = ref<SaveSummaryDTO[]>([])

const formOpen = ref(false)
const editingCard = ref<CharacterCardDTO | null>(null)

const availableSlots = computed(() =>
  FACTION_SLOTS.filter((faction) => !alliances.value.some((item) => item.faction === faction)),
)
const canAddAlliance = computed(() => availableSlots.value.length > 0)

function allianceNameOf(faction: Faction): string {
  const alliance = alliances.value.find((item) => item.faction === faction)
  return alliance ? alliance.name : `${FACTION_NAMES[faction]}（未启用）`
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
/* 角色                                                                */
/* ------------------------------------------------------------------ */

function cardMeta(card: CharacterCardDTO): string {
  const parts = [card.role, `职位 ${card.position === '无' ? '无（上前线）' : card.position}`]
  if (card.personality) parts.push(card.personality)
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
  void patchCard(card, { faction })
}

function onCardTeamChange(card: CharacterCardDTO, team: string): void {
  void patchCard(card, { team: team ? (team as GeneralTeam) : null })
}

function openCreateCard(): void {
  editingCard.value = null
  formOpen.value = true
}

function openEditCard(card: CharacterCardDTO): void {
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
/* 开局与存档                                                          */
/* ------------------------------------------------------------------ */

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
      <div>
        <h1>季前列车 · 开局</h1>
        <p>配置同盟与角色后开始，或直接读取既有存档</p>
      </div>
      <div class="mode-switch">
        <button type="button" :class="{ active: mode === 'new' }" @click="mode = 'new'">
          新开局
        </button>
        <button type="button" :class="{ active: mode === 'load' }" @click="mode = 'load'">
          读取存档
        </button>
      </div>
    </header>

    <main class="start-body">
      <section v-if="mode === 'new'" class="panel section">
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
                {{ ALLIANCE_RELATION_LABELS[relation] }}
              </button>
            </div>
            <button type="button" class="icon" @click="removeAlliance(alliance.faction)">×</button>
          </li>
        </ul>

        <div class="section-actions">
          <button type="button" class="ghost" :disabled="!canAddAlliance" @click="addAlliance">
            添加同盟
          </button>
          <span v-if="!canAddAlliance" class="meta">三块预置出生区已全部启用</span>
        </div>
      </section>

      <section v-if="mode === 'new'" class="panel section">
        <header class="section-head">
          <h2>角色</h2>
          <span class="meta">共 {{ cards.length }} 名 · 可指定同盟与团</span>
        </header>

        <ul class="card-list">
          <li v-for="card in cards" :key="card.id">
            <div class="card-info">
              <strong>{{ card.name }}{{ card.builtin ? ' · 内置' : '' }}</strong>
              <span class="meta">{{ cardMeta(card) }}</span>
            </div>
            <select
              :value="card.faction"
              @change="onCardFactionChange(card, ($event.target as HTMLSelectElement).value as Faction)"
            >
              <option v-for="alliance in alliances" :key="alliance.faction" :value="alliance.faction">
                {{ alliance.name }}
              </option>
              <option
                v-if="!alliances.some((item) => item.faction === card.faction)"
                :value="card.faction"
              >
                {{ allianceNameOf(card.faction) }}
              </option>
            </select>
            <select
              :value="card.team ?? ''"
              @change="onCardTeamChange(card, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">无团</option>
              <option v-for="team in GENERAL_TEAMS" :key="team" :value="team">{{ team }}</option>
            </select>
            <button type="button" class="ghost" @click="openEditCard(card)">编辑</button>
          </li>
        </ul>

        <div class="section-actions">
          <button type="button" class="ghost" @click="openCreateCard">添加角色</button>
          <span class="meta">职位为「无」的角色会亲自带兵，大臣与团长留在城中指挥</span>
        </div>
      </section>

      <section v-if="mode === 'load'" class="panel section">
        <header class="section-head">
          <h2>存档</h2>
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
    </main>

    <footer class="start-foot">
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
      <p v-else-if="loading" class="meta">读取配置中…</p>
      <div class="foot-actions">
        <button
          v-if="mode === 'new'"
          type="button"
          :disabled="busy || loading"
          @click="startGame"
        >
          {{ busy ? '开局中…' : '开始游戏' }}
        </button>
        <span v-else class="meta">选择存档后直接进入地图</span>
        <span class="meta">同盟关系：我方绿 · 友方蓝 · 敌方红</span>
      </div>
    </footer>

    <CharacterForm
      v-if="formOpen"
      :card="editingCard"
      :alliances="alliances"
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
  min-height: 100dvh;
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
.start-body,
.start-foot {
  position: relative;
  z-index: 1;
  width: min(860px, 100%);
  margin: 0 auto;
}

.start-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
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

.mode-switch {
  display: flex;
  gap: 6px;
  padding: 4px;
  border: 1px solid rgba(214, 186, 122, 0.28);
  border-radius: 9px;
  background: rgba(12, 19, 24, 0.78);
}

.mode-switch button,
.segmented button {
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 6px 14px;
  background: transparent;
  color: #9fadb0;
  font-size: 12px;
  letter-spacing: 0.06em;
  cursor: pointer;
}

.mode-switch button.active {
  border-color: rgba(214, 186, 122, 0.55);
  background: rgba(214, 186, 122, 0.18);
  color: #f0dfb4;
}

.start-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
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
  padding: 4px 10px;
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
.foot-actions button,
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

.foot-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.foot-actions button {
  padding: 8px 18px;
  font-size: 13px;
}

.error {
  font-size: 12px;
  color: #e09191;
}

@media (max-width: 720px) {
  .start-head {
    flex-direction: column;
    align-items: flex-start;
  }

  .alliance-list li,
  .card-list li,
  .save-list li {
    flex-wrap: wrap;
  }
}
</style>
