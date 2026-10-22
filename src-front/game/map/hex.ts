/** 尖顶六边形网格（pointy-top），与 CylinderGeometry(…, 6) 的顶点朝向一致 */
export const HEX_RADIUS = 1
export const HEX_WIDTH = Math.sqrt(3) * HEX_RADIUS
export const HEX_ROW_HEIGHT = 1.5 * HEX_RADIUS

export interface AxialCoord {
  q: number
  r: number
}

export interface PlanePoint {
  x: number
  z: number
}

export function axialToWorld(q: number, r: number): PlanePoint {
  return {
    x: HEX_WIDTH * (q + r / 2),
    z: HEX_ROW_HEIGHT * r,
  }
}

/** 世界坐标 → 最近的轴向格子坐标（用于道路采样高度、拾取校验） */
export function worldToAxial(x: number, z: number): AxialCoord {
  const rf = z / HEX_ROW_HEIGHT
  const qf = x / HEX_WIDTH - rf / 2
  return axialRound(qf, rf)
}

function axialRound(qf: number, rf: number): AxialCoord {
  const xf = qf
  const zf = rf
  const yf = -xf - zf

  let x = Math.round(xf)
  let z = Math.round(zf)
  const y = Math.round(yf)

  const dx = Math.abs(x - xf)
  const dy = Math.abs(y - yf)
  const dz = Math.abs(z - zf)

  if (dx > dy && dx > dz) x = -y - z
  else if (dy > dz) z = -x - y

  return { q: x, r: z }
}

/** 以本地原点为中心的六边形顶点（尖顶朝 ±z） */
export function hexCornerPoints(radius = HEX_RADIUS): PlanePoint[] {
  const points: PlanePoint[] = []
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 2 + (i * Math.PI) / 3
    points.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
    })
  }
  return points
}

export function tileKey(q: number, r: number): string {
  return `${q},${r}`
}
