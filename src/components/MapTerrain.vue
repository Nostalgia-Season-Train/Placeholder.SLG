<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { MapRenderer, type HoverInfo } from '@/game/map/MapRenderer'
import { getTerrainLevel, TERRAIN_LEVELS } from '@/game/map/terrainLevels'
import { MarchSimulation } from '@/game/bot/simulation'
import {
  FACTION_COLORS,
  FACTIONS,
  FACTION_NAMES,
  ORDER_LABELS,
  STATUS_LABELS,
  type Faction,
  type SimSnapshot,
} from '@/game/bot/types'
import { CommanderAgent, type AgentDecision } from '@/game/agent/commander'
import { WarChat, type ChatMessage } from '@/game/agent/chat'
import { createDiplomacy, RELATION_LABELS, relationStyleOf } from '@/game/bot/diplomacy'
import {
  OpenAiCompatClient,
  isLlmConfigured,
  loadLlmConfig,
  saveLlmConfig,
  type LlmConfig,
} from '@/game/agent/llm'

type SettingsTab = 'march' | 'log' | 'llm'

const host = ref<HTMLDivElement | null>(null)
const renderer = shallowRef<MapRenderer | null>(null)
const simulation = shallowRef<MarchSimulation | null>(null)
const snapshot = shallowRef<SimSnapshot | null>(null)
const hover = ref<HoverInfo | null>(null)
const seed = ref(20261021)
const tileCount = ref(0)
const running = ref(true)
const speed = ref(650)
const seedDraft = ref(String(seed.value))
const settingsOpen = ref(false)
const settingsTab = ref<SettingsTab>('march')
const helpOpen = ref(false)
const autoInterval = ref(10)
const logLimit = ref(14)
const autoScrollLog = ref(true)
const logList = ref<HTMLUListElement | null>(null)
const agent = shallowRef<CommanderAgent | null>(null)
const agentFaction = ref<Faction>('red')
const directive = ref('向北推进，夺取价值高的地块')
const agentBusy = ref(false)
const agentDecisions = ref<AgentDecision[]>([])
const autoCommand = ref(false)
const llmConfig = ref<LlmConfig>(loadLlmConfig())
const llmReady = computed(() => isLlmConfigured(llmConfig.value))
const chat = shallowRef<WarChat | null>(null)
const chatTick = ref(0)
const chatTab = ref<'world' | 'alliance' | 'log'>('world')
const chatDraft = ref('')
const chatBusy = ref(false)
const WORLD_CHAT_INTERVAL = 20
let lastWorldChatRound = 0
let worldChatIndex = 0
const AUTO_DIRECTIVE = '根据当前战况推进，优先夺取价值高且易守的地块'
let lastAutoRound = 0
let lastOccupationVersion = -1
let timer: ReturnType<typeof setInterval> | null = null

function toCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function levelColor(level: number): string {
  return toCss(getTerrainLevel(level).color)
}

function factionColorCss(faction: Faction): string {
  return toCss(FACTION_COLORS[faction])
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

const factionRows = computed(() =>
  FACTIONS.map((faction) => ({
    faction,
    name: FACTION_NAMES[faction],
    color: relationColorCss(faction),
    count: snapshot.value?.factionCounts[faction] ?? 0,
  })),
)

const generalRows = computed(() => snapshot.value?.generals ?? [])

function factionShare(count: number): string {
  const total = Math.max(1, snapshot.value?.capturedCount ?? 0)
  return `${Math.round((count / total) * 100)}%`
}

function captureWidth(progress: number, cost: number): string {
  return `${Math.min(100, Math.round((progress / Math.max(1, cost)) * 100))}%`
}

const factionGenerals = computed(() =>
  generalRows.value.filter((general) => general.faction === agentFaction.value),
)

const agentSourceLabel = computed(() => (llmReady.value ? 'LLM' : '本地解析'))

const chatMessages = computed<ChatMessage[]>(() => {
  chatTick.value
  const panel = chat.value
  const channel = chatTab.value
  if (!panel || channel === 'log') return []
  return panel.list(channel)
})

const chatPlaceholder = computed(() =>
  chatTab.value === 'world' ? '向世界频道发言（所有 LLM）' : '向本方 LLM 询问或下令',
)

function orderLabel(stance: string | undefined): string {
  return stance ? ORDER_LABELS[stance as keyof typeof ORDER_LABELS] ?? stance : '—'
}

/* ------------------------------------------------------------------ */
/* Agent                                                               */
/* ------------------------------------------------------------------ */

function createLlmClient() {
  return isLlmConfigured(llmConfig.value) ? new OpenAiCompatClient(llmConfig.value) : null
}

function saveLlmSettings(): void {
  saveLlmConfig(llmConfig.value)
  agent.value?.setLlm(createLlmClient())
  chat.value?.setLlm(createLlmClient())
}

async function issueDirective(text: string): Promise<void> {
  const engine = simulation.value
  const commander = agent.value
  const content = text.trim()
  if (!engine || !commander || agentBusy.value || !content) return

  agentBusy.value = true
  try {
    const round = engine.snapshot().round
    const decision = await commander.decide(content, agentFaction.value, engine.snapshot())
    for (const order of decision.orders) {
      engine.setOrder(order.generalId, {
        stance: order.stance,
        target: order.target,
        note: order.reason,
        issuedRound: round,
      })
    }
    agentDecisions.value = [decision, ...agentDecisions.value].slice(0, 6)
    syncSnapshot()
  } finally {
    agentBusy.value = false
  }
}

function maybeAutoCommand(): void {
  const round = snapshot.value?.round ?? 0
  if (!autoCommand.value || agentBusy.value || round - lastAutoRound < autoInterval.value) return
  lastAutoRound = round
  void issueDirective(AUTO_DIRECTIVE)
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

async function sendChat(): Promise<void> {
  const panel = chat.value
  const engine = simulation.value
  const channel = chatTab.value
  const text = chatDraft.value.trim()
  if (!panel || !engine || !text || chatBusy.value || channel === 'log') return

  chatDraft.value = ''
  chatBusy.value = true
  try {
    await panel.post(channel, text, agentFaction.value, engine.snapshot())
  } finally {
    chatBusy.value = false
    chatTick.value += 1
  }
}

async function broadcastWorld(): Promise<void> {
  const panel = chat.value
  const engine = simulation.value
  if (!panel || !engine || chatBusy.value) return

  const faction = FACTIONS[worldChatIndex % FACTIONS.length]!
  worldChatIndex += 1
  chatBusy.value = true
  try {
    await panel.broadcast(faction, engine.snapshot())
  } finally {
    chatBusy.value = false
    chatTick.value += 1
  }
}

function maybeWorldChat(): void {
  const round = snapshot.value?.round ?? 0
  if (!chat.value || chatBusy.value || round - lastWorldChatRound < WORLD_CHAT_INTERVAL) return
  lastWorldChatRound = round
  void broadcastWorld()
}

/* ------------------------------------------------------------------ */
/* Simulation loop                                                     */
/* ------------------------------------------------------------------ */

function initSimulation(): void {
  const map = renderer.value?.getMap()
  if (!map) return
  const engine = new MarchSimulation(map, ((map.seed ^ 0x9e3779b9) >>> 0) || 1)
  engine.setEventLimit(logLimit.value)
  simulation.value = engine
  agent.value = new CommanderAgent(engine.terrain, createLlmClient())
  const panel = new WarChat(engine.terrain, createLlmClient())
  panel.welcome(agentFaction.value, 0)
  chat.value = panel
  chatTick.value += 1
  agentDecisions.value = []
  lastAutoRound = 0
  lastWorldChatRound = 0
  worldChatIndex = 0
  lastOccupationVersion = -1
  syncSnapshot()
}

function syncSnapshot(): void {
  const engine = simulation.value
  const view = renderer.value
  if (!engine || !view) return

  const result = engine.snapshot()
  snapshot.value = result
  const policy = diplomacy.value
  view.setAgents(result.generals, policy)
  view.setCities(result.cities, policy)

  if (result.occupationVersion !== lastOccupationVersion) {
    lastOccupationVersion = result.occupationVersion
    view.setOccupations(result.occupation, policy)
  }
}

watch(agentFaction, () => {
  renderer.value?.setDiplomacy(diplomacy.value)
  syncSnapshot()
})

function stepOnce(): void {
  if (!simulation.value) return
  simulation.value.step()
  syncSnapshot()
  maybeWorldChat()
  maybeAutoCommand()
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function startTimer(): void {
  stopTimer()
  if (!running.value) return
  timer = setInterval(() => stepOnce(), speed.value)
}

function toggleRunning(): void {
  running.value = !running.value
  startTimer()
}

function onSpeedChange(): void {
  startTimer()
}

function regenerate(): void {
  running.value = true
  stopTimer()
  const typed = Number.parseInt(seedDraft.value, 10)
  const nextSeed =
    Number.isFinite(typed) && typed > 0 ? typed : Math.floor(Math.random() * 1_000_000_000)
  seedDraft.value = String(nextSeed)
  renderer.value?.regenerate(nextSeed)
  initSimulation()
  startTimer()
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function openSettings(tab: SettingsTab): void {
  settingsTab.value = tab
  settingsOpen.value = true
}

function onLogLimitChange(): void {
  simulation.value?.setEventLimit(logLimit.value)
  syncSnapshot()
}

watch(
  () => snapshot.value?.events,
  async () => {
    if (!autoScrollLog.value || chatTab.value !== 'log') return
    await nextTick()
    if (logList.value) logList.value.scrollTop = 0
  },
)

watch(chatTab, async (tab) => {
  if (tab !== 'log' || !autoScrollLog.value) return
  await nextTick()
  if (logList.value) logList.value.scrollTop = 0
})

onMounted(() => {
  if (!host.value) return
  renderer.value = new MapRenderer(host.value, {
    seed: seed.value,
    onHover: (info) => {
      hover.value = info
    },
    onReady: (stats) => {
      seed.value = stats.seed
      tileCount.value = stats.tiles
    },
  })
  renderer.value.start()
  initSimulation()
  startTimer()
})

onBeforeUnmount(() => {
  stopTimer()
  renderer.value?.dispose()
  renderer.value = null
  simulation.value = null
  agent.value = null
  chat.value = null
})
</script>

<template>
  <div class="map-page">
    <div ref="host" class="map-host"></div>
    <div class="vignette"></div>

    <header class="panel head">
      <div class="head-title">
        <h1>大地图 · Bot 行军推演</h1>
        <p>程序化地形 · 势力 Bot 自主选择目标、行军与占领</p>
      </div>
      <div class="head-actions">
        <button type="button" @click="toggleRunning">{{ running ? '暂停' : '继续' }}</button>
        <button type="button" @click="stepOnce">单步</button>
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
                ? factionColorCss(hover.city.faction)
                : hover.isBank
                  ? '#b7a67a'
                  : levelColor(hover.level),
            }"
          >
            {{ hover.city ? '城' : hover.isBank ? '滩' : hover.level }}
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

    <section class="panel status">
      <h2>战况</h2>
      <p class="meta">
        回合 {{ snapshot?.round ?? 0 }} · 已占领 {{ snapshot?.capturedCount ?? 0 }} /
        {{ snapshot?.capturableCount ?? 0 }}
      </p>

      <div v-for="f in factionRows" :key="f.faction" class="faction">
        <span class="dot" :style="{ background: f.color }"></span>
        <span class="fname">{{ f.name }}</span>
        <span class="fcount">{{ f.count }}</span>
        <div class="fbar"><i :style="{ width: factionShare(f.count) }"></i></div>
      </div>

      <ul class="roster">
        <li v-for="w in generalRows" :key="w.id">
          <span class="dot small" :style="{ background: relationColorCss(w.faction) }"></span>
          <span class="rname">{{ w.name }}</span>
          <span class="rstate" :class="w.status">{{ STATUS_LABELS[w.status] }}</span>
          <span v-if="w.status === 'capturing'" class="rprogress">
            <i :style="{ width: captureWidth(w.captureProgress, w.captureCost) }"></i>
          </span>
          <span v-else class="rgoal">
            {{ w.target ? `${w.target.q},${w.target.r}` : '—' }}
          </span>
        </li>
      </ul>
    </section>

    <section class="panel command">
      <h2>指挥 Agent</h2>
      <div class="cmd-row">
        <select v-model="agentFaction">
          <option v-for="f in FACTIONS" :key="f" :value="f">{{ FACTION_NAMES[f] }}</option>
        </select>
        <span class="src-badge" :class="{ live: llmReady }">{{ agentSourceLabel }}</span>
      </div>

      <div class="cmd-input">
        <input
          v-model="directive"
          type="text"
          placeholder="例：向北推进，夺取道路两侧地块"
          @keyup.enter="issueDirective(directive)"
        />
        <button type="button" :disabled="agentBusy" @click="issueDirective(directive)">
          {{ agentBusy ? '思考中' : '下达' }}
        </button>
      </div>

      <label class="auto-line">
        <input v-model="autoCommand" type="checkbox" />
        每 {{ autoInterval }} 回合自动指挥
      </label>

      <ul class="agent-bots">
        <li v-for="g in factionGenerals" :key="g.id">
          <span class="dot small" :style="{ background: factionColorCss(g.faction) }"></span>
          <span class="rname">{{ g.name }}</span>
          <span class="rgoal">{{ orderLabel(g.order?.stance) }}</span>
          <span class="rgoal">{{ g.target ? `${g.target.q},${g.target.r}` : '—' }}</span>
        </li>
      </ul>

      <button type="button" class="link-btn settings-link" @click="openSettings('llm')">
        LLM 与推演设置
      </button>

      <ul class="agent-log">
        <li v-for="(d, i) in agentDecisions" :key="i">
          <span class="src-badge" :class="{ live: d.source === 'llm' }">
            {{ d.source === 'llm' ? 'LLM' : 'Mock' }}
          </span>
          <span class="dtext">
            {{ d.reply }}
            <em v-if="d.error">{{ d.error }}</em>
          </span>
        </li>
      </ul>
    </section>

    <section class="panel comms">
      <h2>通讯</h2>

      <div class="tabs">
        <button
          type="button"
          title="所有 LLM"
          :class="{ active: chatTab === 'world' }"
          @click="chatTab = 'world'"
        >
          世界
        </button>
        <button
          type="button"
          title="本势力 LLM"
          :class="{ active: chatTab === 'alliance' }"
          @click="chatTab = 'alliance'"
        >
          同盟
        </button>
        <button type="button" :class="{ active: chatTab === 'log' }" @click="chatTab = 'log'">
          行军
        </button>
        <span class="tabhint">
          {{ chatTab === 'world' ? '所有 LLM' : chatTab === 'alliance' ? '本势力 LLM' : '战况日志' }}
        </span>
      </div>

      <ul v-if="chatTab === 'log'" ref="logList" class="log-list">
        <li v-for="(e, i) in snapshot?.events ?? []" :key="i">
          <span class="round">{{ e.round }}</span>
          <span class="logtext" :style="e.faction ? { color: factionColorCss(e.faction) } : undefined">
            {{ e.text }}
          </span>
        </li>
        <li v-if="!(snapshot?.events.length)" class="empty">推演进行中…</li>
      </ul>

      <template v-else>
        <ul class="chat-list">
          <li v-for="m in chatMessages" :key="m.id" :class="{ mine: m.source === 'player' }">
            <div class="chat-head">
              <span
                class="author"
                :style="m.faction ? { color: factionColorCss(m.faction) } : undefined"
              >
                {{ m.author }}
              </span>
              <span class="round">R{{ m.round }}</span>
            </div>
            <p>{{ m.text }}</p>
          </li>
          <li v-if="!chatMessages.length" class="empty">暂无消息</li>
        </ul>

        <div class="chat-input">
          <input v-model="chatDraft" :placeholder="chatPlaceholder" @keyup.enter="sendChat" />
          <button type="button" :disabled="chatBusy" @click="sendChat">
            {{ chatBusy ? '…' : '发送' }}
          </button>
        </div>
      </template>
    </section>

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
            :class="{ active: settingsTab === 'log' }"
            @click="settingsTab = 'log'"
          >
            战况日志
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
            <span>推演速度</span>
            <select v-model.number="speed" @change="onSpeedChange">
              <option :value="1100">慢</option>
              <option :value="650">中</option>
              <option :value="350">快</option>
            </select>
          </label>
          <label class="field">
            <span>自动指挥</span>
            <select v-model.number="autoInterval">
              <option :value="5">每 5 回合</option>
              <option :value="10">每 10 回合</option>
              <option :value="20">每 20 回合</option>
            </select>
          </label>
          <label class="field">
            <span>地图种子</span>
            <input v-model="seedDraft" type="number" min="1" />
          </label>
          <div class="settings-actions">
            <button type="button" @click="regenerate">按种子重新生成</button>
            <span class="meta">当前种子 {{ seed }}</span>
          </div>
          <p class="meta">重新生成会清空当前推演进度与行军日志。</p>
        </div>

        <div v-else-if="settingsTab === 'log'" class="settings-body">
          <label class="field">
            <span>显示条数</span>
            <select v-model.number="logLimit" @change="onLogLimitChange">
              <option :value="10">10 条</option>
              <option :value="14">14 条</option>
              <option :value="20">20 条</option>
              <option :value="30">30 条</option>
            </select>
          </label>
          <label class="field check">
            <span>自动滚动</span>
            <input v-model="autoScrollLog" type="checkbox" />
          </label>
          <p class="meta">战况日志位于左下「通讯 · 行军」页签，最新记录显示在最上方。</p>
        </div>

        <div v-else class="settings-body">
          <label class="field">
            <span>baseUrl</span>
            <input
              v-model="llmConfig.baseUrl"
              type="text"
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label class="field">
            <span>model</span>
            <input v-model="llmConfig.model" type="text" placeholder="gpt-4o-mini" />
          </label>
          <label class="field">
            <span>apiKey</span>
            <input v-model="llmConfig.apiKey" type="password" placeholder="仅保存在本地浏览器" />
          </label>
          <div class="settings-actions">
            <button type="button" @click="saveLlmSettings">保存</button>
            <span class="meta">{{ llmReady ? '已配置' : '未配置，将使用本地解析' }}</span>
          </div>
          <p class="meta">接口需兼容 OpenAI chat/completions，配置同时用于 Agent 指挥与频道聊天。</p>
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
              <span class="ldesc">沿地形连接主要区域</span>
            </li>
            <li>
              <span class="swatch river"></span><span class="name">河流</span>
              <span class="ldesc">水面不可通行，沿岸生成河滩</span>
            </li>
            <li>
              <span class="swatch city"></span><span class="name">城池</span>
              <span class="ldesc">势力主城，小队由此出发</span>
            </li>
          </ul>

          <h3>势力与外交</h3>
          <ul>
            <li v-for="faction in FACTIONS" :key="faction">
              <span class="swatch" :style="factionSwatchStyle(faction)"></span>
              <span class="name">{{ FACTION_NAMES[faction] }}</span>
              <span class="rel">{{ factionRelationLabel(faction) }}</span>
            </li>
          </ul>

          <h3>行军与占领</h3>
          <p>武将自主选择目标并寻路，抵达后持续占领；敌对单位同格时发生遭遇战，败者撤退并休整。</p>
          <p class="meta">地块 {{ tileCount }} · 种子 {{ seed }}</p>
        </div>
      </section>
    </div>

    <footer class="hint">拖拽平移 · 滚轮缩放 · 悬停查看地块</footer>
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

.status {
  top: 276px;
  left: 20px;
  width: 252px;
  max-height: 28vh;
  padding: 14px 16px;
  overflow: auto;
  pointer-events: auto;
}

.status h2 {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.18em;
  color: #c8b98e;
}

.faction {
  display: grid;
  grid-template-columns: 10px 46px 26px 1fr;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: #cfd6d3;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot.small {
  width: 6px;
  height: 6px;
}

.fname {
  color: #e7dfcb;
}

.fcount {
  color: #9fadb0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.fbar {
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}

.fbar i {
  display: block;
  height: 100%;
  background: currentColor;
  color: #c8b98e;
  transition: width 0.25s ease;
}

.roster {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.12);
  list-style: none;
}

.roster li {
  display: grid;
  grid-template-columns: 8px 46px 40px 1fr;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.rname {
  color: #e7dfcb;
}

.rstate {
  color: #8fa0a5;
}

.rstate.marching {
  color: #e0c07a;
}

.rstate.capturing {
  color: #8fd0a8;
}

.rstate.garrison {
  color: #9fb8d8;
}

.rstate.resting {
  color: #d08f8f;
}

.rprogress {
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}

.rprogress i {
  display: block;
  height: 100%;
  background: #8fd0a8;
}

.rgoal {
  color: #7d8d92;
  font-variant-numeric: tabular-nums;
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

.command {
  left: 20px;
  bottom: 20px;
  width: 320px;
  max-height: 28vh;
  padding: 14px 16px;
  overflow: auto;
  pointer-events: auto;
}

.command h2 {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.18em;
  color: #c8b98e;
}

.cmd-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cmd-row select {
  flex: 1;
  border: 1px solid rgba(214, 186, 122, 0.4);
  border-radius: 6px;
  padding: 5px 6px;
  background: rgba(12, 19, 24, 0.9);
  color: #e7dfcb;
  font-size: 12px;
}

.src-badge {
  flex: none;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: #8fa0a5;
  font-size: 10px;
  letter-spacing: 0.08em;
}

.src-badge.live {
  border-color: rgba(143, 208, 168, 0.55);
  color: #8fd0a8;
}

.cmd-input {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.cmd-input input {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(214, 186, 122, 0.3);
  border-radius: 6px;
  padding: 6px 8px;
  background: rgba(8, 13, 17, 0.85);
  color: #e9e4d6;
  font-size: 12px;
}

.cmd-input button {
  flex: none;
  border: 1px solid rgba(214, 186, 122, 0.5);
  border-radius: 6px;
  padding: 6px 10px;
  background: rgba(214, 186, 122, 0.18);
  color: #f0dfb4;
  font-size: 12px;
  cursor: pointer;
}

.cmd-input button:disabled {
  opacity: 0.5;
  cursor: default;
}

.auto-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 11px;
  color: #9fadb0;
}

.agent-bots {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.12);
  list-style: none;
}

.agent-bots li {
  display: grid;
  grid-template-columns: 8px 52px 52px 1fr;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.link-btn {
  border: 1px solid rgba(214, 186, 122, 0.4);
  border-radius: 6px;
  padding: 5px 10px;
  background: rgba(214, 186, 122, 0.14);
  color: #f0dfb4;
  font-size: 11px;
  cursor: pointer;
}

.settings-link {
  margin-top: 10px;
}

.agent-log {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.12);
  list-style: none;
}

.agent-log li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.45;
}

.dtext {
  color: #cfd6d3;
}

.dtext em {
  display: block;
  margin-top: 2px;
  color: #d08f8f;
  font-style: normal;
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

.log-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
}

.log-list li {
  display: flex;
  gap: 8px;
  font-size: 11px;
  line-height: 1.45;
}

.log-list .round {
  flex: none;
  min-width: 24px;
  color: #6f7f84;
  font-variant-numeric: tabular-nums;
}

.logtext {
  color: #cfd6d3;
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
  width: 72px;
}

.field input[type='text'],
.field input[type='password'],
.field input[type='number'],
.field select {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(214, 186, 122, 0.3);
  border-radius: 6px;
  padding: 6px 8px;
  background: rgba(8, 13, 17, 0.85);
  color: #e9e4d6;
  font-size: 12px;
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

.help-dialog {
  width: min(520px, 100%);
}

.help-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
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
  .status,
  .command,
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
