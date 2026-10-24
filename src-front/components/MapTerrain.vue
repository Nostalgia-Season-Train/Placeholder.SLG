<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { MapRenderer, type HoverInfo } from '@/game/map/MapRenderer'
import { GATE_COLOR, WALL_COLOR, getTerrainLevel, TERRAIN_LEVELS } from '@shared/map/terrainLevels'
import { applyOccupationPatch, decodeMap, decodeSnapshot } from '@shared/codec'
import { WorldApi } from '@/game/api/client'
import type {
  CardCreateDTO,
  CharacterCardDTO,
  ControlPatch,
  GameStateDTO,
  LlmMode,
  LlmStatusDTO,
  SaveSummaryDTO,
  ServerEvent,
  WorldDTO,
} from '@shared/protocol'
import {
  FACTIONS,
  FACTION_NAMES,
  GENERAL_POSITIONS,
  GENERAL_ROLES,
  STAT_GRADES,
  type Faction,
  type SimSnapshot,
} from '@shared/types'
import type { ChatChannel, ChatMessage } from '@shared/chat'
import { createDiplomacy, RELATION_LABELS, relationStyleOf } from '@/game/bot/diplomacy'

type SettingsTab = 'march' | 'card' | 'save' | 'llm'

const api = new WorldApi()
const host = ref<HTMLDivElement | null>(null)
const renderer = shallowRef<MapRenderer | null>(null)
const snapshot = shallowRef<SimSnapshot | null>(null)
const hover = ref<HoverInfo | null>(null)
const tileCount = ref(0)
const running = ref(true)
const speed = ref(650)
const settingsOpen = ref(false)
const settingsTab = ref<SettingsTab>('march')
const helpOpen = ref(false)
const autoInterval = ref(10)
const autoCommand = ref(true)
const agentFaction = ref<Faction>('red')
const chatBusy = ref(false)
const chatTab = ref<'world' | 'alliance' | 'team'>('world')
const chatDraft = ref('')
const worldMessages = ref<ChatMessage[]>([])
const teamMessages = ref<ChatMessage[]>([])
const allianceMessages = ref<ChatMessage[]>([])
/** 正在回复的发言人，仅同盟与本团频道使用 */
const typing = ref<{ channel: ChatChannel; author: string } | null>(null)
const llmStatus = ref<LlmStatusDTO | null>(null)
const llmDraft = ref({ baseUrl: '', model: '', apiKey: '', mode: 'live' as LlmMode })
const llmError = ref('')
const llmNotice = ref('')
const llmTesting = ref(false)
const hasSavedKey = computed(() => llmStatus.value?.hasApiKey ?? false)
const saves = ref<SaveSummaryDTO[]>([])
const saveLabel = ref('')
const saveBusy = ref(false)
const savesLoading = ref(false)
const cards = ref<CharacterCardDTO[]>([])
const cardFormOpen = ref(false)
const cardsLoading = ref(false)
const cardBusy = ref(false)
const cardDraft = ref<CardCreateDTO>({
  name: '',
  faction: 'red',
  role: '武将',
  position: '无',
  attack: '中',
  magic: '低',
  personality: '',
})
const errorMessage = ref('')
let lastOccupationVersion = -1
let source: EventSource | null = null

function toCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function levelColor(level: number): string {
  return toCss(getTerrainLevel(level).color)
}

const diplomacy = computed(() => createDiplomacy(agentFaction.value))

function relationColorCss(faction: Faction): string {
  return toCss(relationStyleOf(diplomacy.value, faction).fill)
}

function factionSwatchStyle(faction: Faction): Record<string, string> {
  const style = relationStyleOf(diplomacy.value, faction)
  const result: Record<string, string> = { background: toCss(style.fill) }
  if (style.border !== null) result.boxShadow = `inset 0 0 0 2px ${toCss(style.border)}`
  return result
}

function factionRelationLabel(faction: Faction): string {
  return RELATION_LABELS[diplomacy.value.relations[faction]]
}

/** 频道列表只渲染最近若干条，避免长会话拖慢 DOM */
const CHAT_ROWS = 40
const chatListEl = ref<HTMLUListElement | null>(null)
const stickToBottom = ref(true)

const chatMessages = computed<ChatMessage[]>(() => {
  const list =
    chatTab.value === 'world'
      ? worldMessages.value
      : chatTab.value === 'alliance'
        ? allianceMessages.value
        : teamMessages.value
  return list.slice(-CHAT_ROWS)
})

/** 滚动到底部；instant 用于切换频道与刷新后直接停在最新发言 */
function scrollChatToBottom(instant = false): void {
  void nextTick(() => {
    const el = chatListEl.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: instant ? 'auto' : 'smooth' })
    stickToBottom.value = true
  })
}

function onChatScroll(): void {
  const el = chatListEl.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

const chatPlaceholder = computed(() => {
  if (chatTab.value === 'world') return '向世界频道发言（所有同盟的 LLM 角色可见）'
  if (chatTab.value === 'team') return '向本团角色下达军令（经 LLM，必然照办）'
  return '向本方角色询问或下令（经 LLM）'
})

const typingText = computed(() => {
  const current = typing.value
  if (!current || current.channel !== chatTab.value) return ''
  return `${current.author} 正在回复`
})

/* 切换频道与增量消息都停在底部；玩家上翻查看历史时不再强制跟随 */
watch(chatTab, () => scrollChatToBottom(true))
watch(
  () => {
    const list = chatMessages.value
    return [list[list.length - 1]?.id, typingText.value]
  },
  () => {
    if (!stickToBottom.value) return
    // 列表还在顶部（刷新、切频道）时直接落到底部，避免从上往下滚
    scrollChatToBottom((chatListEl.value?.scrollTop ?? 0) <= 0)
  },
)

/* ------------------------------------------------------------------ */
/* 服务端状态                                                          */
/* ------------------------------------------------------------------ */

function setLlmStatus(status: LlmStatusDTO): void {
  llmStatus.value = status
  llmDraft.value.baseUrl = status.baseUrl
  llmDraft.value.model = status.model
  llmDraft.value.apiKey = ''
  llmDraft.value.mode = status.mode
  llmError.value = status.lastError ?? ''
}

function applyWorld(world: WorldDTO): void {
  const state = world.state
  snapshot.value = decodeSnapshot(world.snapshot)
  worldMessages.value = world.chat.world
  teamMessages.value = world.chat.team
  allianceMessages.value = world.chat.alliance
  running.value = state.running
  speed.value = state.speed
  autoCommand.value = state.autoCommand
  autoInterval.value = state.autoInterval
  agentFaction.value = state.faction
  setLlmStatus(world.llm)
  lastOccupationVersion = -1
}

function applyState(state: GameStateDTO): void {
  running.value = state.running
  speed.value = state.speed
  autoCommand.value = state.autoCommand
  autoInterval.value = state.autoInterval
  if (state.faction !== agentFaction.value) {
    agentFaction.value = state.faction
    lastOccupationVersion = -1
    renderer.value?.setDiplomacy(diplomacy.value)
  }
  if (llmStatus.value) {
    llmStatus.value = { ...llmStatus.value, configured: state.llmConfigured }
  }
  llmError.value = state.llmError ?? ''
  renderScene()
}

function renderScene(): void {
  const view = renderer.value
  const snap = snapshot.value
  if (!view || !snap) return

  const policy = diplomacy.value
  view.setAgents(snap.generals, policy, speed.value)
  view.setCities(snap.cities, policy)

  if (snap.occupationVersion !== lastOccupationVersion) {
    lastOccupationVersion = snap.occupationVersion
    view.setOccupations(snap.occupation, policy)
  }
}

function onServerEvent(event: ServerEvent): void {
  errorMessage.value = ''
  switch (event.type) {
    case 'hello':
      applyWorld(event.world)
      renderScene()
      break
    case 'tick': {
      const occupation = applyOccupationPatch(
        snapshot.value?.occupation ?? new Map(),
        event.occPatch,
      )
      snapshot.value = { ...event.snapshot, occupation }
      renderScene()
      break
    }
    case 'state':
      applyState(event.state)
      break
    case 'chat':
      if (event.channel === 'world') worldMessages.value = event.messages
      else if (event.channel === 'team') teamMessages.value = event.messages
      else allianceMessages.value = event.messages
      if (typing.value?.channel === event.channel) typing.value = null
      break
    case 'typing':
      if (event.author) typing.value = { channel: event.channel, author: event.author }
      else if (typing.value?.channel === event.channel) typing.value = null
      break
    case 'reset':
      applyWorld(event.world)
      renderer.value?.setMap(decodeMap(event.world.map))
      renderScene()
      break
  }
}

async function control(patch: ControlPatch): Promise<void> {
  try {
    applyState(await api.control(patch))
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '控制请求失败'
  }
}

/* ------------------------------------------------------------------ */
/* Chat 与 LLM                                                         */
/* ------------------------------------------------------------------ */

async function sendChat(): Promise<void> {
  const channel = chatTab.value
  const text = chatDraft.value.trim()
  if (!text || chatBusy.value) return

  chatDraft.value = ''
  chatBusy.value = true
  try {
    const result = await api.chat(channel, text, agentFaction.value)
    if (channel === 'world') worldMessages.value = result.messages
    else if (channel === 'team') teamMessages.value = result.messages
    else allianceMessages.value = result.messages
    errorMessage.value = ''
  } catch (error) {
    chatDraft.value = text
    errorMessage.value = error instanceof Error ? error.message : '消息发送失败'
  } finally {
    chatBusy.value = false
  }
}

async function saveLlmSettings(): Promise<void> {
  try {
    setLlmStatus(
      await api.setLlm({
        baseUrl: llmDraft.value.baseUrl,
        model: llmDraft.value.model,
        apiKey: llmDraft.value.apiKey,
        mode: llmDraft.value.mode,
      }),
    )
    llmNotice.value = '设置已保存'
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'LLM 设置保存失败'
  }
}

/** 主动探活；失败时把后端返回的连接错误直接显示在设置面板 */
async function testLlmSettings(): Promise<void> {
  if (llmTesting.value) return
  llmTesting.value = true
  llmNotice.value = ''
  try {
    const result = await api.testLlm()
    if (result.ok) {
      llmError.value = ''
      llmNotice.value =
        llmDraft.value.mode === 'mock' ? '当前为模拟 LLM，无需联网' : '连接正常'
    } else {
      llmError.value = result.error ?? '无法连接 LLM 接口'
    }
    errorMessage.value = ''
  } catch (error) {
    llmError.value = error instanceof Error ? error.message : '连接测试失败'
  } finally {
    llmTesting.value = false
  }
}

/** 打开 LLM 页签时拉一次最新状态，避免沿用页面加载时的旧错误 */
async function refreshLlmStatus(): Promise<void> {
  try {
    setLlmStatus(await api.getLlm())
  } catch {
    /* 断线时由 SSE 重连逻辑提示，这里保持现状 */
  }
}

watch(settingsTab, (tab) => {
  if (tab === 'llm') {
    llmNotice.value = ''
    void refreshLlmStatus()
  }
})

/* ------------------------------------------------------------------ */
/* 推演控制                                                            */
/* ------------------------------------------------------------------ */

function toggleRunning(): void {
  void control({ running: !running.value })
}

function onSpeedChange(): void {
  void control({ speed: speed.value })
}

function onAutoCommandChange(): void {
  void control({ autoCommand: autoCommand.value })
}

function onAutoIntervalChange(): void {
  void control({ autoInterval: autoInterval.value })
}

function onFactionChange(): void {
  void control({ faction: agentFaction.value })
}

async function resetWorld(): Promise<void> {
  try {
    const world = await api.reset()
    applyWorld(world)
    renderer.value?.setMap(decodeMap(world.map))
    renderScene()
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '重新开局失败'
  }
}

/* ------------------------------------------------------------------ */
/* 存档                                                                */
/* ------------------------------------------------------------------ */

function defaultSaveLabel(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function formatSavedAt(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

async function refreshSaves(): Promise<void> {
  savesLoading.value = true
  try {
    saves.value = (await api.listSaves()).saves
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '读取存档列表失败'
  } finally {
    savesLoading.value = false
  }
}

async function createSave(): Promise<void> {
  if (saveBusy.value) return
  saveBusy.value = true
  try {
    saves.value = (await api.createSave(saveLabel.value.trim() || defaultSaveLabel())).saves
    saveLabel.value = ''
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    saveBusy.value = false
  }
}

async function loadSave(id: string): Promise<void> {
  if (saveBusy.value) return
  saveBusy.value = true
  try {
    const world = await api.loadSave(id)
    applyWorld(world)
    renderer.value?.setMap(decodeMap(world.map))
    renderScene()
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '读取存档失败'
  } finally {
    saveBusy.value = false
  }
}

async function removeSave(id: string): Promise<void> {
  if (saveBusy.value) return
  if (!window.confirm('确认删除该存档？')) return
  saveBusy.value = true
  try {
    saves.value = (await api.deleteSave(id)).saves
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除存档失败'
  } finally {
    saveBusy.value = false
  }
}

/* ------------------------------------------------------------------ */
/* 角色属性                                                            */
/* ------------------------------------------------------------------ */

async function refreshCards(): Promise<void> {
  cardsLoading.value = true
  try {
    cards.value = (await api.listCards()).cards
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '读取角色属性列表失败'
  } finally {
    cardsLoading.value = false
  }
}

async function createCard(): Promise<void> {
  if (cardBusy.value) return
  if (!cardDraft.value.name.trim()) {
    errorMessage.value = '名称不能为空'
    return
  }
  cardBusy.value = true
  try {
    cards.value = (
      await api.createCard({ ...cardDraft.value, name: cardDraft.value.name.trim() })
    ).cards
    cardDraft.value.name = ''
    cardFormOpen.value = false
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '角色创建失败'
  } finally {
    cardBusy.value = false
  }
}

function cardMeta(card: CharacterCardDTO): string {
  const parts = [
    FACTION_NAMES[card.faction],
    card.role,
    `职位 ${card.position === '无' ? '无（上前线）' : card.position}`,
    `攻击 ${card.attack}`,
    `魔力 ${card.magic}`,
  ]
  if (card.personality) parts.push(card.personality)
  return parts.join(' · ')
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function openSettings(tab: SettingsTab): void {
  settingsTab.value = tab
  settingsOpen.value = true
}

watch([settingsOpen, settingsTab], ([open, tab]) => {
  if (open && tab === 'save') void refreshSaves()
  if (open && tab === 'card') void refreshCards()
})

watch(cardFormOpen, (open) => {
  if (open) cardDraft.value.faction = agentFaction.value
})

onMounted(async () => {
  if (!host.value) return
  try {
    const world = await api.getWorld()
    applyWorld(world)
    renderer.value = new MapRenderer(host.value, {
      map: decodeMap(world.map),
      onHover: (info) => {
        hover.value = info
      },
      onReady: (stats) => {
        tileCount.value = stats.tiles
      },
    })
    renderer.value.start()
    renderScene()
    source = api.subscribe(onServerEvent, () => {
      errorMessage.value = '与后端断开，正在重连…'
    })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无法连接后端服务'
  }
})

onBeforeUnmount(() => {
  source?.close()
  source = null
  renderer.value?.dispose()
  renderer.value = null
})
</script>

<template>
  <div class="map-page">
    <div ref="host" class="map-host"></div>
    <div class="vignette"></div>

    <header class="panel head">
      <div class="head-title">
        <h1>大地图 · Bot 行军推演</h1>
        <p>程序化地形 · 同盟 Bot 自主选择目标、行军与占领</p>
      </div>
      <div class="head-actions">
        <button type="button" @click="toggleRunning">{{ running ? '暂停' : '继续' }}</button>
        <button type="button" @click="helpOpen = true">帮助</button>
        <button type="button" @click="openSettings('march')">设置</button>
      </div>
    </header>

    <aside class="panel info">
      <template v-if="hover">
        <div class="info-head">
          <span
            class="badge"
            :style="{
              background: hover.city
                ? relationColorCss(hover.city.faction)
                : hover.isGate
                  ? toCss(GATE_COLOR)
                  : hover.isWall
                    ? toCss(WALL_COLOR)
                    : hover.isBank
                      ? '#b7a67a'
                      : levelColor(hover.level),
            }"
          >
            {{ hover.city ? '城' : hover.isGate ? '关' : hover.isWall ? '墙' : hover.isBank ? '滩' : hover.level }}
          </span>
          <strong>{{ hover.name }}</strong>
        </div>
        <p>{{ hover.desc }}</p>
        <dl>
          <div>
            <dt>坐标</dt>
            <dd>{{ hover.q }} , {{ hover.r }}</dd>
          </div>
          <div v-if="hover.city">
            <dt>归属</dt>
            <dd>{{ hover.city.factionName }}</dd>
          </div>
          <div v-else>
            <dt>地势</dt>
            <dd>{{ hover.height.toFixed(2) }}</dd>
          </div>
        </dl>
      </template>
      <p v-else class="empty">悬停到地块上查看信息</p>
    </aside>

    <section class="panel comms">
      <div class="comms-head">
        <h2>通讯</h2>
      </div>

      <div class="tabs">
        <button
          type="button"
          :class="{ active: chatTab === 'world' }"
          @click="chatTab = 'world'"
        >
          世界
        </button>
        <button
          type="button"
          :class="{ active: chatTab === 'alliance' }"
          @click="chatTab = 'alliance'"
        >
          同盟
        </button>
        <button
          type="button"
          :class="{ active: chatTab === 'team' }"
          @click="chatTab = 'team'"
        >
          本团
        </button>
        <span class="tabhint">
          {{ chatTab === 'world' ? '世界频道' : chatTab === 'alliance' ? '同盟频道' : '本团频道' }}
        </span>
      </div>

      <div class="chat-pane">
        <ul ref="chatListEl" class="chat-list" @scroll.passive="onChatScroll">
          <li v-for="m in chatMessages" :key="m.id" :class="{ mine: m.source === 'player' }">
            <div class="chat-head">
              <span
                class="author"
                :style="m.faction ? { color: relationColorCss(m.faction) } : undefined"
              >
                {{ m.author }}
              </span>
              <span class="round">R{{ m.round }}</span>
            </div>
            <p>{{ m.text }}</p>
          </li>
          <li v-if="typingText" class="typing">{{ typingText }}<span class="dots">…</span></li>
          <li v-if="!chatMessages.length && !typingText" class="empty">暂无消息</li>
        </ul>

        <div class="chat-input">
          <input v-model="chatDraft" :placeholder="chatPlaceholder" @keyup.enter="sendChat" />
          <button type="button" :disabled="chatBusy" @click="sendChat">
            {{ chatBusy ? '…' : '发送' }}
          </button>
        </div>
      </div>
    </section>

    <div v-if="cardFormOpen" class="card-form-mask" @click.self="cardFormOpen = false">
      <section class="card-form" role="dialog" aria-modal="true" aria-label="添加角色">
        <header class="settings-head">
          <h3>添加角色</h3>
          <button type="button" class="close" aria-label="关闭" @click="cardFormOpen = false">
            ×
          </button>
        </header>
        <div class="card-form-body">
          <label class="field">
            <span>名称</span>
            <input v-model="cardDraft.name" type="text" maxlength="24" placeholder="角色名称" />
          </label>
          <label class="field">
            <span>同盟</span>
            <select v-model="cardDraft.faction">
              <option v-for="f in FACTIONS" :key="f" :value="f">{{ FACTION_NAMES[f] }}</option>
            </select>
          </label>
          <label class="field">
            <span>定位</span>
            <select v-model="cardDraft.role">
              <option v-for="role in GENERAL_ROLES" :key="role" :value="role">{{ role }}</option>
            </select>
          </label>
          <label class="field">
            <span>职位</span>
            <select v-model="cardDraft.position">
              <option v-for="position in GENERAL_POSITIONS" :key="position" :value="position">
                {{ position === '无' ? '无（上前线）' : position }}
              </option>
            </select>
          </label>
        <div class="card-grid">
          <label class="field">
            <span>攻击</span>
            <select v-model="cardDraft.attack">
              <option v-for="grade in STAT_GRADES" :key="grade" :value="grade">{{ grade }}</option>
            </select>
          </label>
          <label class="field">
            <span>魔力</span>
            <select v-model="cardDraft.magic">
              <option v-for="grade in STAT_GRADES" :key="grade" :value="grade">{{ grade }}</option>
            </select>
          </label>
        </div>
          <label class="field">
            <span>性格</span>
            <input
              v-model="cardDraft.personality"
              type="text"
              maxlength="120"
              placeholder="如：勇猛、忠诚"
            />
          </label>
          <label class="field">
            <span>描述</span>
            <textarea
              v-model="cardDraft.description"
              rows="2"
              placeholder="背景与经历（可选）"
            ></textarea>
          </label>
          <label class="field">
            <span>对话提示词</span>
            <textarea
              v-model="cardDraft.dialoguePrompt"
              rows="2"
              placeholder="说话方式与语气（可选）"
            ></textarea>
          </label>
          <label class="field">
            <span>作者注释</span>
            <textarea
              v-model="cardDraft.authorNote"
              rows="2"
              placeholder="给使用者看的备注（可选）"
            ></textarea>
          </label>
          <div class="settings-actions">
            <button type="button" :disabled="cardBusy" @click="createCard">
              {{ cardBusy ? '保存中…' : '保存' }}
            </button>
            <button type="button" class="ghost" @click="cardFormOpen = false">取消</button>
          </div>
        </div>
      </section>
    </div>

    <div v-if="settingsOpen" class="settings-mask" @click.self="settingsOpen = false">
      <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header class="settings-head">
          <h2 id="settings-title">设置</h2>
          <button type="button" class="close" aria-label="关闭" @click="settingsOpen = false">×</button>
        </header>

        <nav class="settings-tabs">
          <button
            type="button"
            :class="{ active: settingsTab === 'march' }"
            @click="settingsTab = 'march'"
          >
            大地图行军
          </button>
          <button
            type="button"
            :class="{ active: settingsTab === 'card' }"
            @click="settingsTab = 'card'"
          >
            角色
          </button>
          <button
            type="button"
            :class="{ active: settingsTab === 'save' }"
            @click="settingsTab = 'save'"
          >
            存档
          </button>
          <button
            type="button"
            :class="{ active: settingsTab === 'llm' }"
            @click="settingsTab = 'llm'"
          >
            LLM
          </button>
        </nav>

        <div v-if="settingsTab === 'march'" class="settings-body">
          <label class="field">
            <span>当前同盟</span>
            <select v-model="agentFaction" @change="onFactionChange">
              <option v-for="f in FACTIONS" :key="f" :value="f">{{ FACTION_NAMES[f] }}</option>
            </select>
          </label>
          <label class="field">
            <span>推演速度</span>
            <select v-model.number="speed" @change="onSpeedChange">
              <option :value="1100">慢</option>
              <option :value="650">中</option>
              <option :value="350">快</option>
            </select>
          </label>
          <label class="field check">
            <span>启用自动决策</span>
            <input v-model="autoCommand" type="checkbox" @change="onAutoCommandChange" />
          </label>
          <label class="field">
            <span>决策基准间隔</span>
            <select v-model.number="autoInterval" @change="onAutoIntervalChange">
              <option :value="5">约 5 回合</option>
              <option :value="10">约 10 回合</option>
              <option :value="20">约 20 回合</option>
            </select>
          </label>
          <div class="settings-actions">
            <button type="button" @click="resetWorld">重新开局</button>
          </div>
          <p class="meta">重新开局会清空当前推演进度与频道消息，地图保持固定预制。</p>
        </div>

        <div v-else-if="settingsTab === 'card'" class="settings-body">
          <div class="settings-actions">
            <button type="button" @click="cardFormOpen = true">添加角色</button>
            <span class="meta">{{ cardsLoading ? '读取中…' : `共 ${cards.length} 张卡` }}</span>
          </div>
          <ul v-if="cards.length" class="save-list">
            <li v-for="card in cards" :key="card.id">
              <div class="save-info">
                <strong :style="{ color: relationColorCss(card.faction) }">
                  {{ card.name }}{{ card.builtin ? ' · 内置' : '' }}
                </strong>
                <span class="meta">{{ cardMeta(card) }}</span>
              </div>
            </li>
          </ul>
          <p class="meta">
            职位为「无」的角色保存后立即进驻地图；大臣与团长坐镇指挥，不亲自上前线。重新开局时全部角色重新进驻。
          </p>
        </div>

        <div v-else-if="settingsTab === 'save'" class="settings-body">
          <label class="field">
            <span>存档名称</span>
            <input v-model="saveLabel" type="text" :placeholder="defaultSaveLabel()" />
          </label>
          <div class="settings-actions">
            <button type="button" :disabled="saveBusy" @click="createSave">保存当前进度</button>
            <span class="meta">{{ savesLoading ? '读取中…' : `共 ${saves.length} 个存档` }}</span>
          </div>
          <ul v-if="saves.length" class="save-list">
            <li v-for="item in saves" :key="item.id">
              <div class="save-info">
                <strong>{{ item.label }}</strong>
                <span class="meta">
                  第 {{ item.round }} 回合 · {{ formatSavedAt(item.savedAt) }}
                </span>
              </div>
              <div class="save-actions">
                <button type="button" :disabled="saveBusy" @click="loadSave(item.id)">读取</button>
                <button type="button" :disabled="saveBusy" @click="removeSave(item.id)">删除</button>
              </div>
            </li>
          </ul>
          <p v-else-if="!savesLoading" class="meta">暂无手动存档。</p>
          <p class="meta">
            服务端每 5 回合与退出时自动续档，重启后自动恢复上次进度；手动存档不会被自动覆盖。
          </p>
        </div>

        <div v-else-if="settingsTab === 'llm'" class="settings-body">
          <label class="field">
            <span>模式</span>
            <select v-model="llmDraft.mode">
              <option value="live">真实 LLM</option>
              <option value="mock">模拟 LLM（本地规则，不联网）</option>
            </select>
          </label>
          <template v-if="llmDraft.mode === 'live'">
            <label class="field">
              <span>baseUrl</span>
              <input
                v-model="llmDraft.baseUrl"
                type="text"
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label class="field">
              <span>model</span>
              <input v-model="llmDraft.model" type="text" placeholder="gpt-4o-mini" />
            </label>
            <label class="field">
              <span>apiKey</span>
              <input
                v-model="llmDraft.apiKey"
                type="password"
                :placeholder="hasSavedKey ? '已保存，留空保持不变' : '仅保存在后端服务'"
              />
            </label>
          </template>
          <div class="settings-actions">
            <button type="button" @click="saveLlmSettings">保存</button>
            <button type="button" class="ghost" :disabled="llmTesting" @click="testLlmSettings">
              {{ llmTesting ? '测试中…' : '测试连接' }}
            </button>
          </div>
          <p v-if="llmError" class="llm-error">连接失败：{{ llmError }}</p>
          <p v-else-if="llmNotice" class="llm-ok">{{ llmNotice }}</p>
          <p class="meta">
            接口需兼容 OpenAI chat/completions。配置保存在后端，Key 不会下发到浏览器。模拟
            LLM 完全由服务端本地规则驱动，不发起任何网络请求。
          </p>
        </div>
      </section>
    </div>

    <div v-if="helpOpen" class="settings-mask" @click.self="helpOpen = false">
      <section
        class="settings-dialog help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
      >
        <header class="settings-head">
          <h2 id="help-title">帮助</h2>
          <button type="button" class="close" aria-label="关闭" @click="helpOpen = false">×</button>
        </header>

        <div class="help-body">
          <h3>操作</h3>
          <p>拖拽平移，滚轮缩放，悬停地块查看地形、坐标与归属。</p>

          <h3>地形等级</h3>
          <ul>
            <li v-for="level in TERRAIN_LEVELS" :key="level.level">
              <span class="swatch" :style="{ background: toCss(level.color) }"></span>
              <span class="lv">{{ level.level }} 级</span>
              <span class="name">{{ level.name }}</span>
              <span class="ldesc">{{ level.desc }}</span>
              <span v-if="level.level >= 4" class="blocked">不可通行</span>
            </li>
          </ul>

          <h3>场景要素</h3>
          <ul>
            <li>
              <span class="swatch road"></span><span class="name">道路</span>
              <span class="ldesc">道路瓦片，行军成本更低，遇水面与城墙断开</span>
            </li>
            <li>
              <span class="swatch river"></span><span class="name">河流</span>
              <span class="ldesc">水面不可通行，沿岸生成河滩</span>
            </li>
            <li>
              <span class="swatch city"></span><span class="name">城池</span>
              <span class="ldesc">同盟主城，小队由此出发</span>
            </li>
            <li>
              <span class="swatch wall"></span><span class="name">城墙</span>
              <span class="ldesc">划分区域，不可通行</span>
            </li>
            <li>
              <span class="swatch gate"></span><span class="name">关口</span>
              <span class="ldesc">连接相邻区域的唯一通道，可被攻占</span>
            </li>
          </ul>

          <h3>同盟与外交</h3>
          <ul>
            <li v-for="faction in FACTIONS" :key="faction">
              <span class="swatch" :style="factionSwatchStyle(faction)"></span>
              <span class="name">{{ FACTION_NAMES[faction] }}</span>
              <span class="rel">{{ factionRelationLabel(faction) }}</span>
            </li>
          </ul>

          <h3>行军与占领</h3>
          <p>角色自主选择目标并寻路，抵达后持续占领；敌对单位同格时发生遭遇战，败者撤退并休整。</p>

          <h3>测试提示词</h3>
          <p>在「本团」频道发送，军令直达本方 Bot，本地解析、不经 AI 决策层，语法与同盟指令相同：</p>
          <ul>
            <li><span class="name">全员向北进攻</span><span class="ldesc">直接下达，立即执行</span></li>
            <li><span class="name">进攻 12,8</span><span class="ldesc">指定轴向坐标目标</span></li>
          </ul>
          <p>在「同盟」频道发送，等同向本方 AI 下达指令：</p>
          <ul>
            <li><span class="name">向北进攻</span><span class="ldesc">全体向北推进</span></li>
            <li><span class="name">向东进攻</span><span class="ldesc">全体向东推进</span></li>
            <li><span class="name">全员防守</span><span class="ldesc">转入防守姿态</span></li>
            <li><span class="name">原地待命</span><span class="ldesc">停止推进</span></li>
            <li><span class="name">撤回主城</span><span class="ldesc">撤退并收缩</span></li>
            <li><span class="name">自由行动</span><span class="ldesc">由 Bot 自主选择地块</span></li>
            <li><span class="name">进攻 12,8</span><span class="ldesc">指定轴向坐标目标</span></li>
          </ul>
          <p>在「世界」频道发送，只触发对话，不改变角色指令：</p>
          <ul>
            <li><span class="name">报一下当前战况</span></li>
            <li><span class="name">你们下一步打算往哪打？</span></li>
          </ul>
          <p class="meta">
            指令支持方向（东南西北 / 上下左右）、姿态（进攻、防守、待命、撤退、自由行动）与坐标（如 12,8）。
          </p>
          <p class="meta">地块 {{ tileCount }}</p>
        </div>
      </section>
    </div>

    <footer class="hint">{{ errorMessage || '拖拽平移 · 滚轮缩放 · 悬停查看地块' }}</footer>
  </div>
</template>

<style scoped>
.map-page {
  position: relative;
  width: 100%;
  height: 100dvh;
  overflow: hidden;
  background: radial-gradient(circle at 50% 40%, #16222b 0%, #080d11 72%);
  color: #e9e4d6;
}

.map-host {
  position: absolute;
  inset: 0;
}

.map-host :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
}

.map-host :deep(canvas.is-dragging) {
  cursor: grabbing;
}

.vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(circle at 50% 45%, transparent 45%, rgba(0, 0, 0, 0.42) 100%);
}

.panel {
  position: absolute;
  background: rgba(12, 19, 24, 0.78);
  border: 1px solid rgba(214, 186, 122, 0.28);
  border-radius: 12px;
  backdrop-filter: blur(10px);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}

.head {
  top: 20px;
  left: 20px;
  display: flex;
  align-items: center;
  gap: 26px;
  padding: 14px 18px;
}

.head h1 {
  font-size: 16px;
  letter-spacing: 0.12em;
  color: #f1e6c8;
}

.head p {
  margin-top: 4px;
  font-size: 12px;
  letter-spacing: 0.06em;
  color: #93a3a8;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
}

.head button {
  border: 1px solid rgba(214, 186, 122, 0.5);
  border-radius: 8px;
  padding: 8px 14px;
  background: linear-gradient(180deg, rgba(214, 186, 122, 0.24), rgba(214, 186, 122, 0.08));
  color: #f0dfb4;
  font-size: 12px;
  letter-spacing: 0.08em;
  cursor: pointer;
  transition: background 0.2s ease;
}

.head button:hover {
  background: rgba(214, 186, 122, 0.34);
}

.swatch {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.25);
}

.swatch.road {
  background: #b19468;
}

.swatch.river {
  background: #2f7d84;
}

.swatch.city {
  background: #9a927f;
}

.swatch.wall {
  background: #5d6066;
}

.swatch.gate {
  background: #b08a4a;
}

.lv {
  min-width: 34px;
  color: #8fa0a5;
}

.name {
  color: #e7dfcb;
}

.rel {
  margin-left: auto;
  font-size: 10px;
  color: #8fa0a5;
  white-space: nowrap;
}

.blocked {
  margin-left: auto;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: #d08f8f;
  white-space: nowrap;
}

.meta {
  margin-top: 10px;
  font-size: 11px;
  color: #7d8d92;
}

.llm-error,
.llm-ok {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
}

.llm-error {
  color: #e09191;
}

.llm-ok {
  color: #8fc0a0;
}

.info {
  top: 128px;
  left: 20px;
  width: 252px;
  min-height: 96px;
  padding: 14px 16px;
}

.info-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: #0d1317;
  font-size: 11px;
  font-weight: 700;
}

.info strong {
  font-size: 14px;
  letter-spacing: 0.06em;
  color: #f2e8ca;
}

.info p {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: #9fadb0;
}

.info dl {
  display: flex;
  gap: 18px;
  margin-top: 10px;
}

.info dl div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.info dt {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: #7d8d92;
}

.info dd {
  font-size: 12px;
  color: #dcd4bd;
}

.empty {
  color: #7d8d92;
  font-size: 12px;
}

.chat-list,
.settings-body,
.help-body {
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(200, 185, 142, 0.32) transparent;
}

.chat-list::-webkit-scrollbar,
.settings-body::-webkit-scrollbar,
.help-body::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.chat-list::-webkit-scrollbar-track,
.settings-body::-webkit-scrollbar-track,
.help-body::-webkit-scrollbar-track,
.chat-list::-webkit-scrollbar-corner,
.settings-body::-webkit-scrollbar-corner,
.help-body::-webkit-scrollbar-corner {
  background: transparent;
}

.chat-list::-webkit-scrollbar-thumb,
.settings-body::-webkit-scrollbar-thumb,
.help-body::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(200, 185, 142, 0.28);
}

.chat-list::-webkit-scrollbar-thumb:hover,
.settings-body::-webkit-scrollbar-thumb:hover,
.help-body::-webkit-scrollbar-thumb:hover {
  background: rgba(214, 186, 122, 0.55);
}

.card-form-mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(4, 8, 11, 0.45);
  backdrop-filter: blur(2px);
  pointer-events: auto;
}

.card-form {
  width: min(380px, 100%);
  max-height: min(86vh, 700px);
  display: flex;
  flex-direction: column;
  padding: 14px 16px 16px;
  border: 1px solid rgba(214, 186, 122, 0.38);
  border-radius: 14px;
  background: rgba(12, 19, 24, 0.95);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}

.card-form-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
  padding-right: 4px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.settings-actions .ghost {
  border-color: rgba(255, 255, 255, 0.16);
  background: transparent;
  color: #9fadb0;
}

.comms {
  top: 128px;
  right: 20px;
  bottom: 20px;
  width: 380px;
  min-height: 210px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  pointer-events: auto;
}

.comms-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.comms-head h2 {
  margin-bottom: 0;
}

.comms h2 {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.18em;
  color: #c8b98e;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}

.tabs button {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  padding: 3px 9px;
  background: transparent;
  color: #9fadb0;
  font-size: 11px;
  cursor: pointer;
}

.tabs button.active {
  border-color: rgba(214, 186, 122, 0.55);
  background: rgba(214, 186, 122, 0.16);
  color: #f0dfb4;
}

.tabhint {
  margin-left: auto;
  font-size: 10px;
  color: #6f7f84;
}

.chat-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.chat-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
  list-style: none;
}

.chat-list li {
  padding: 5px 7px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
}

.chat-list li.mine {
  background: rgba(214, 186, 122, 0.1);
}

.chat-list li.typing {
  color: #9fb3b8;
  font-size: 12px;
  font-style: italic;
}

.chat-list li.typing .dots {
  animation: typing-pulse 1.1s ease-in-out infinite;
}

@keyframes typing-pulse {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}

.chat-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.author {
  font-size: 11px;
  font-weight: 600;
}

.chat-head .round {
  margin-left: auto;
  font-size: 10px;
  color: #6f7f84;
  font-variant-numeric: tabular-nums;
}

.chat-list p {
  margin: 2px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: #cfd6d3;
  word-break: break-word;
}

.chat-input {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.chat-input input {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(214, 186, 122, 0.3);
  border-radius: 6px;
  padding: 6px 8px;
  background: rgba(8, 13, 17, 0.85);
  color: #e9e4d6;
  font-size: 11px;
}

.chat-input button {
  flex: none;
  border: 1px solid rgba(214, 186, 122, 0.5);
  border-radius: 6px;
  padding: 6px 10px;
  background: rgba(214, 186, 122, 0.18);
  color: #f0dfb4;
  font-size: 11px;
  cursor: pointer;
}

.chat-input button:disabled {
  opacity: 0.5;
  cursor: default;
}

.hint {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 12px;
  letter-spacing: 0.12em;
  color: rgba(233, 228, 214, 0.6);
  pointer-events: none;
}

/* ------------------------------------------------------------------ */
/* Settings dialog                                                     */
/* ------------------------------------------------------------------ */

.settings-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(4, 8, 11, 0.62);
  backdrop-filter: blur(3px);
  pointer-events: auto;
}

.settings-dialog {
  width: min(460px, 100%);
  max-height: min(82vh, 640px);
  display: flex;
  flex-direction: column;
  padding: 16px 18px 18px;
  border: 1px solid rgba(214, 186, 122, 0.38);
  border-radius: 14px;
  background: rgba(12, 19, 24, 0.97);
  box-shadow: 0 22px 50px rgba(0, 0, 0, 0.5);
  color: #e9e4d6;
}

.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.settings-head h2 {
  font-size: 14px;
  letter-spacing: 0.18em;
  color: #f1e6c8;
}

.settings-head h3 {
  font-size: 13px;
  letter-spacing: 0.16em;
  color: #f1e6c8;
}

.settings-head .close {
  border: none;
  background: transparent;
  color: #9fadb0;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.settings-tabs {
  display: flex;
  gap: 6px;
  margin-top: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.settings-tabs button {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  padding: 4px 10px;
  background: transparent;
  color: #9fadb0;
  font-size: 11px;
  cursor: pointer;
}

.settings-tabs button.active {
  border-color: rgba(214, 186, 122, 0.55);
  background: rgba(214, 186, 122, 0.16);
  color: #f0dfb4;
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 14px;
  min-height: 0;
  overflow: auto;
}

.field {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #9fadb0;
}

.field > span {
  flex: none;
  width: 84px;
}

.field input[type='text'],
.field input[type='password'],
.field input[type='number'],
.field select,
.field textarea {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(214, 186, 122, 0.3);
  border-radius: 6px;
  padding: 6px 8px;
  background: rgba(8, 13, 17, 0.85);
  color: #e9e4d6;
  font-size: 12px;
}

.field textarea {
  resize: vertical;
}

.field.check input {
  flex: none;
  width: 16px;
  height: 16px;
  accent-color: #d6ba7a;
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.settings-actions button {
  border: 1px solid rgba(214, 186, 122, 0.5);
  border-radius: 6px;
  padding: 6px 12px;
  background: rgba(214, 186, 122, 0.18);
  color: #f0dfb4;
  font-size: 12px;
  cursor: pointer;
}

.settings-actions .meta {
  margin-top: 0;
}

.save-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
}

.save-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 8px 10px;
  background: rgba(8, 13, 17, 0.6);
}

.save-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.save-info strong {
  font-size: 12px;
  font-weight: 500;
  color: #e9e4d6;
}

.save-info .meta {
  margin-top: 0;
}

.save-actions {
  display: flex;
  flex: none;
  gap: 6px;
}

.save-actions button {
  border: 1px solid rgba(214, 186, 122, 0.4);
  border-radius: 5px;
  padding: 4px 9px;
  background: transparent;
  color: #c8b98e;
  font-size: 11px;
  cursor: pointer;
}

.save-actions button:disabled,
.settings-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}

.help-dialog {
  width: min(520px, 100%);
}

.help-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
  min-height: 0;
  overflow: auto;
}

.help-body h3 {
  margin-top: 2px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.16em;
  color: #c8b98e;
}

.help-body ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
}

.help-body li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #cfd6d3;
}

.help-body .ldesc {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: #8fa0a5;
}

.help-body p {
  font-size: 12px;
  line-height: 1.6;
  color: #9fadb0;
}

.help-body .meta {
  margin-top: 0;
}

@media (max-width: 820px) {
  .comms {
    display: none;
  }

  .head {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .info {
    width: 180px;
  }
}
</style>
