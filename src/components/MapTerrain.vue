<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { MapRenderer, type HoverInfo } from '@/game/map/MapRenderer'
import { getTerrainLevel, TERRAIN_LEVELS } from '@/game/map/terrainLevels'

const host = ref<HTMLDivElement | null>(null)
const renderer = shallowRef<MapRenderer | null>(null)
const hover = ref<HoverInfo | null>(null)
const seed = ref(20261021)
const tileCount = ref(0)

function toCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function levelColor(level: number): string {
  return toCss(getTerrainLevel(level).color)
}

function regenerate(): void {
  renderer.value?.regenerate(Math.floor(Math.random() * 1_000_000_000))
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
})

onBeforeUnmount(() => {
  renderer.value?.dispose()
  renderer.value = null
})
</script>

<template>
  <div class="map-page">
    <div ref="host" class="map-host"></div>
    <div class="vignette"></div>

    <header class="panel head">
      <div>
        <h1>大地图 · 3D 地形建模</h1>
        <p>Three.js 程序化生成 · 0~5 级地 / 道路 / 河流</p>
      </div>
      <button type="button" @click="regenerate">重新生成</button>
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
      <p class="meta">地块 {{ tileCount }} · 种子 {{ seed }}</p>
    </section>

    <aside class="panel info">
      <template v-if="hover">
        <div class="info-head">
          <span
            class="badge"
            :style="{
              background: hover.isBank ? '#b7a67a' : levelColor(hover.level),
            }"
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

.head button {
  pointer-events: auto;
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

.legend {
  top: 110px;
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

@media (max-width: 720px) {
  .legend {
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
