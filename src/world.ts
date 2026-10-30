import { CLUSTERS, MAP, SPACING, TANK, TANKS_PER_CLUSTER } from './config'

export type Side = 'red' | 'blue'
export interface Vec2 { x: number; z: number }

export interface Tank {
  id: number
  side: Side
  cluster: number
  /** 集群内编位，用来算队形偏移 */
  slot: number
  x: number
  z: number
  /** 朝向弧度，0 表示面向 +z */
  dir: number
  hp: number
  cd: number
  alive: boolean
}

export interface Cluster {
  side: Side
  index: number
  tanks: Tank[]
  /** 集群订单：目标点，null 表示原地待命 */
  order: Vec2 | null
}

/** 只用于渲染的弹道线段 */
export interface Shot {
  x1: number; z1: number
  x2: number; z2: number
  ttl: number
}

const opposite = (side: Side): Side => (side === 'red' ? 'blue' : 'red')
const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(bx - ax, bz - az)

/** 集群内编位的队形偏移 */
export function slotOffset(slot: number) {
  const col = slot % 3
  const row = Math.floor(slot / 3)
  return { x: (col - 1) * SPACING, z: (row - 0.5) * SPACING }
}

/**
 * 世界状态与推演。
 * 纯逻辑、不依赖渲染：unit 只关心位置、血量、冷却与订单。
 */
export class World {
  readonly tanks: Tank[] = []
  readonly clusters: Cluster[] = []
  readonly shots: Shot[] = []
  time = 0
  /** 胜负判定结果 */
  result: Side | null = null

  private aiTimer = 0

  constructor() {
    for (const side of ['red', 'blue'] as Side[]) {
      // 红方在北、蓝方在南，玩家指挥蓝方
      const line = side === 'red' ? -MAP * 0.3 : MAP * 0.3
      for (let ci = 0; ci < CLUSTERS; ci++) {
        const cluster: Cluster = { side, index: ci, tanks: [], order: null }
        for (let i = 0; i < TANKS_PER_CLUSTER; i++) {
          const off = slotOffset(i)
          const tank: Tank = {
            id: this.tanks.length,
            side,
            cluster: ci,
            slot: i,
            x: (ci - (CLUSTERS - 1) / 2) * SPACING * 5 + off.x,
            z: line + off.z,
            dir: side === 'red' ? 0 : Math.PI,
            hp: TANK.hp,
            cd: 0,
            alive: true,
          }
          cluster.tanks.push(tank)
          this.tanks.push(tank)
        }
        this.clusters.push(cluster)
      }
    }
  }

  aliveCount(side: Side) {
    return this.tanks.filter((t) => t.side === side && t.alive).length
  }

  /** 集群存活单位的中心点，全部阵亡时返回 null */
  centroid(cluster: Cluster): Vec2 | null {
    const alive = cluster.tanks.filter((t) => t.alive)
    if (alive.length === 0) return null
    const sum = alive.reduce((acc, t) => ({ x: acc.x + t.x, z: acc.z + t.z }), { x: 0, z: 0 })
    return { x: sum.x / alive.length, z: sum.z / alive.length }
  }

  update(dt: number) {
    if (this.result) {
      this.decayShots(dt)
      return
    }
    this.time += dt
    for (const t of this.tanks) {
      if (t.alive && t.cd > 0) t.cd = Math.max(0, t.cd - dt)
    }
    this.runAi(dt)
    this.move(dt)
    this.separate()
    this.fire()
    this.decayShots(dt)
    this.checkResult()
  }

  /** 敌方 Bot 集群：定时把订单指向最近的蓝方单位 */
  private runAi(dt: number) {
    this.aiTimer -= dt
    if (this.aiTimer > 0) return
    this.aiTimer = 0.7
    for (const c of this.clusters) {
      if (c.side !== 'red') continue
      const center = this.centroid(c)
      if (!center) continue
      const target = this.nearest(center, 'blue', Infinity)
      if (target) c.order = { x: target.x, z: target.z }
    }
  }

  private move(dt: number) {
    const limit = MAP / 2 - 4
    for (const c of this.clusters) {
      if (!c.order) continue
      for (const t of c.tanks) {
        if (!t.alive) continue
        // 射程内先停下打，避免一边走一边送
        const enemy = this.nearest(t, opposite(t.side), TANK.range)
        if (enemy) {
          t.dir = Math.atan2(enemy.x - t.x, enemy.z - t.z)
          continue
        }
        const off = slotOffset(t.slot)
        const dx = c.order.x + off.x - t.x
        const dz = c.order.z + off.z - t.z
        const d = Math.hypot(dx, dz)
        if (d < 1.5) continue
        const step = Math.min(TANK.speed * dt, d)
        t.x = Math.max(-limit, Math.min(limit, t.x + (dx / d) * step))
        t.z = Math.max(-limit, Math.min(limit, t.z + (dz / d) * step))
        t.dir = Math.atan2(dx / d, dz / d)
      }
    }
  }

  /** 同阵营轻量分离，避免集群挤成一团 */
  private separate() {
    const R = 2.8
    for (let i = 0; i < this.tanks.length; i++) {
      const a = this.tanks[i]
      if (!a.alive) continue
      for (let j = i + 1; j < this.tanks.length; j++) {
        const b = this.tanks[j]
        if (!b.alive || b.side !== a.side) continue
        let dx = b.x - a.x
        let dz = b.z - a.z
        const d = Math.hypot(dx, dz)
        if (d > R || d < 1e-4) continue
        const push = (R - d) * 0.35
        dx /= d
        dz /= d
        a.x -= dx * push
        a.z -= dz * push
        b.x += dx * push
        b.z += dz * push
      }
    }
  }

  private fire() {
    for (const t of this.tanks) {
      if (!t.alive) continue
      const enemy = this.nearest(t, opposite(t.side), TANK.range)
      if (!enemy) continue
      t.dir = Math.atan2(enemy.x - t.x, enemy.z - t.z)
      if (t.cd > 0) continue
      t.cd = TANK.cooldown
      enemy.hp -= TANK.damage
      this.shots.push({ x1: t.x, z1: t.z, x2: enemy.x, z2: enemy.z, ttl: 0.15 })
      if (enemy.hp <= 0) {
        enemy.hp = 0
        enemy.alive = false
      }
    }
  }

  private decayShots(dt: number) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      this.shots[i].ttl -= dt
      if (this.shots[i].ttl <= 0) this.shots.splice(i, 1)
    }
  }

  private checkResult() {
    if (this.aliveCount('red') === 0) this.result = 'blue'
    else if (this.aliveCount('blue') === 0) this.result = 'red'
  }

  private nearest(from: Vec2, side: Side, maxDist: number): Tank | null {
    let best: Tank | null = null
    let bestDist = maxDist
    for (const t of this.tanks) {
      if (!t.alive || t.side !== side) continue
      const d = dist(from.x, from.z, t.x, t.z)
      if (d < bestDist) {
        bestDist = d
        best = t
      }
    }
    return best
  }
}
