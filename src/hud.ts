import type { Cluster, World } from './world'

/**
 * 极简 HUD：兵力统计、操作提示、胜负横幅。
 * 只读 World 与选中集合，不参与推演。
 */
export class Hud {
  private stats: HTMLElement
  private banner: HTMLElement
  private lastStats = ''
  private lastBanner = ''

  constructor() {
    const root = document.getElementById('hud')
    if (!root) throw new Error('缺少 #hud 容器')
    root.innerHTML = `
      <div class="hud-stats"></div>
      <div class="hud-tip">
        <strong>RTT 框架 Demo</strong><br />
        左键点击坦克：选中所在集群 · Shift 加选<br />
        右键地面：给选中集群下达移动指令<br />
        WASD / 方向键平移镜头 · 滚轮缩放
      </div>
      <div class="hud-banner"></div>`
    this.stats = root.querySelector('.hud-stats') as HTMLElement
    this.banner = root.querySelector('.hud-banner') as HTMLElement
  }

  sync(world: World, selected: Set<Cluster>) {
    const names = [...selected]
      .map((c) => `${c.side === 'blue' ? '蓝' : '红'}方第 ${c.index + 1} 队`)
      .join('、')
    const text = `蓝方 ${world.aliveCount('blue')} 辆　红方 ${world.aliveCount('red')} 辆` +
      (names ? `　｜　已选：${names}` : '　｜　未选中集群')
    if (text !== this.lastStats) {
      this.lastStats = text
      this.stats.textContent = text
    }

    const banner = world.result
      ? (world.result === 'blue' ? '蓝方胜利' : '红方胜利')
      : ''
    if (banner !== this.lastBanner) {
      this.lastBanner = banner
      this.banner.textContent = banner
      this.banner.classList.toggle('show', banner !== '')
    }
  }
}
