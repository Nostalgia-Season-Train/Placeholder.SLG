import * as THREE from 'three'

/**
 * 把一条中心线扩充成带宽度的带状网格（道路、河岸、水面共用）。
 * uv.x 横跨河宽（0~1），uv.y 沿路径累积长度。
 */
export function createRibbon(points: THREE.Vector3[], width: number, uvScale = 1): THREE.BufferGeometry {
  const count = points.length
  const positions = new Float32Array(count * 2 * 3)
  const uvs = new Float32Array(count * 2 * 2)
  const indices: number[] = []
  let distance = 0

  for (let i = 0; i < count; i++) {
    const point = points[i]!
    const prev = points[Math.max(0, i - 1)]!
    const next = points[Math.min(count - 1, i + 1)]!

    let dx = next.x - prev.x
    let dz = next.z - prev.z
    const length = Math.hypot(dx, dz) || 1
    dx /= length
    dz /= length

    // 路径法线（XZ 平面内逆时针旋转 90°）
    const nx = -dz
    const nz = dx

    if (i > 0) distance += point.distanceTo(points[i - 1]!)

    const edge = Math.min(i / (count - 1), 1 - i / (count - 1))
    const taper = edge < 0.04 ? 0.45 + (edge / 0.04) * 0.55 : 1
    const half = (width * 0.5) * taper

    const vertex = i * 6
    positions[vertex] = point.x + nx * half
    positions[vertex + 1] = point.y
    positions[vertex + 2] = point.z + nz * half

    positions[vertex + 3] = point.x - nx * half
    positions[vertex + 4] = point.y
    positions[vertex + 5] = point.z - nz * half

    const uv = i * 4
    uvs[uv] = 0
    uvs[uv + 1] = distance * uvScale
    uvs[uv + 2] = 1
    uvs[uv + 3] = distance * uvScale

    if (i > 0) {
      const a = (i - 1) * 2
      const b = a + 1
      const c = i * 2
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}
