<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { MapRenderer, type HoverInfo } from '@/game/map/MapRenderer'
import { getTerrainLevel, TERRAIN_LEVELS } from '@/game/map/terrainLevels'
import { MarchSimulation } from '@/game/ai/simulation'
import {
  FACTION_COLORS,
  FACTIONS,
  FACTION_NAMES,
  STATUS_LABELS,
  type Faction,
  type SimSnapshot,
} from '@/game/ai/types'

const host = ref<HTMLDivElement | null>(null)
const renderer = shallowRef<MapRenderer | null>(null)
const simulation = shallowRef<MarchSimulation | null>(null)
const snapshot = shallowRef<SimSnapshot | null>(null)
const hover = ref<HoverInfo | null>(null)
const seed = ref(20261021)
const tileCount = ref(0)
const running = ref(true)
const speed = ref(200)
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

const factionRows = computed(() =>
  FACTIONS.map((faction) => ({
    faction,
    name: FACTION_NAMES[faction],
    color: factionColorCss(faction),
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

/* ------------------------------------------------------------------ */
/* Simulation loop                                                     */
/* ------------------------------------------------------------------ */

function initSimulation(): void {
  const map = renderer.value?.getMap()
  if (!map) return
  simulation.value = new MarchSimulation(map, ((map.seed ^ 0x9e3779b9) >>> 0) || 1)
  lastOccupationVersion = -1
  syncSnapshot()
}

function syncSnapshot(): void {
  const engine = simulation.value
  const view = renderer.value
  if (!engine || !view) return

  const result = engine.snapshot()
  snapshot.value = result
  view.setAgents(result.generals)

  if (result.occupationVersion !== lastOccupationVersion) {
    lastOccupationVersion = result.occupationVersion
    view.setOccupations(result.occupation)
  }
}

function stepOnce(): void {
  if (!simulation.value) return
  simulation.value.step()
  syncSnapshot()
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
  renderer.value?.regenerate(Math.floor(Math.random() * 1_000_000_000))
  initSimulation()
  startTimer()
}

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
})
</script>

<template>
  <div class="map-page">
    <div ref="host" class="map-host"></div>
    <div class="vignette"></div>

    <header class="panel head">
      <div class="head-title">
        <h1>大地图 · AI 行军推演</h1>
        <p>程序化地形 · 势力武将自主选择目标、行军与占领</p>
      </div>
      <div class="head-actions">
        <button type="button" @click="toggleRunning">{{ running ? '暂停' : '继续' }}</button>
        <button type="button" @click="stepOnce">单步</button>
        <select v-model.number="speed" @change="onSpeedChange">
          <option :value="340">慢</option>
          <option :value="200">中</option>
          <option :value="110">快</option>
        </select>
        <button type="button" @click="regenerate">重新生成</button>
      </div>
    </header>

    <section class="panel legend">
      <h2>地形等级</h2>
      <ul>
        <li v-for="level in TERRAIN_LEVELS" :key="level.level">
          <span class="swatch" :style="{ background: toCss(level.color) }"></span>
          <span class="lv">{{ level.level }} 级</span>
          <span class="name">{{ level.name }}</span>
        </li>
        <li class="extra">
          <span class="swatch road"></span><span class="name">道路</span>
          <span class="swatch river"></span><span class="name">河流</span>
        </li>
      </ul>
      <h2 class="sub-title">势力</h2>
      <ul>
        <li v-for="faction in FACTIONS" :key="faction">
          <span class="swatch" :style="{ background: factionColorCss(faction) }"></span>
          <span class="name">{{ FACTION_NAMES[faction] }}</span>
        </li>
      </ul>
      <p class="meta">地块 {{ tileCount }} · 种子 {{ seed }}</p>
    </section>

    <aside class="panel info">
      <template v-if="hover">
        <div class="info-head">
          <span
            class="badge"
            :style="{ background: hover.isBank ? '#b7a67a' : levelColor(hover.level) }"
          >
            {{ hover.isBank ? '滩' : hover.level }}
          </span>
          <strong>{{ hover.name }}</strong>
        </div>
        <p>{{ hover.desc }}</p>
        <dl>
          <div>
            <dt>坐标</dt>
            <dd>{{ hover.q }} , {{ hover.r }}</dd>
          </div>
          <div>
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
          <span class="dot small" :style="{ background: factionColorCss(w.faction) }"></span>
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

    <section class="panel log">
      <h2>行军日志</h2>
      <ul>
        <li v-for="(e, i) in snapshot?.events ?? []" :key="i">
          <span class="round">{{ e.round }}</span>
          <span class="logtext" :style="e.faction ? { color: factionColorCss(e.faction) } : undefined">
            {{ e.text }}
          </span>
        </li>
      </ul>
      <p v-if="!(snapshot?.events.length)" class="empty">推演进行中…</p>
    </section>

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

.head select {
  border: 1px solid rgba(214, 186, 122, 0.4);
  border-radius: 8px;
  padding: 7px 8px;
  background: rgba(12, 19, 24, 0.9);
  color: #e7dfcb;
  font-size: 12px;
  cursor: pointer;
}

.legend {
  top: 128px;
  left: 20px;
  width: 192px;
  padding: 14px 16px;
}

.legend h2 {
  margin-bottom: 10px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.18em;
  color: #c8b98e;
}

.legend h2.sub-title {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed rgba(255, 255, 255, 0.12);
}

.legend ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
}

.legend li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #cfd6d3;
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

.lv {
  min-width: 34px;
  color: #8fa0a5;
}

.name {
  color: #e7dfcb;
}

.extra {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.12);
}

.meta {
  margin-top: 10px;
  font-size: 11px;
  color: #7d8d92;
}

.info {
  top: 20px;
  right: 20px;
  width: 232px;
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
  top: 230px;
  right: 20px;
  width: 252px;
  max-height: 46vh;
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

.log {
  left: 20px;
  bottom: 44px;
  width: 320px;
  max-height: 24vh;
  padding: 12px 14px;
  overflow: auto;
  pointer-events: auto;
}

.log h2 {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.18em;
  color: #c8b98e;
}

.log ul {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
}

.log li {
  display: flex;
  gap: 8px;
  font-size: 11px;
  line-height: 1.45;
}

.log .round {
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

@media (max-width: 1080px) {
  .log {
    display: none;
  }
}

@media (max-width: 820px) {
  .legend,
  .status {
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
