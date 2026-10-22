import * as THREE from 'three'
import type { PlanePoint } from '@shared/map/hex'
import { createRibbon } from './ribbon'

const WATER_Y = 0.11
const BANK_Y = 0.06

const waterVertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const waterFragmentShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;

  void main() {
    float across = abs(vUv.x - 0.5) * 2.0;
    vec3 deep = vec3(0.05, 0.23, 0.32);
    vec3 shallow = vec3(0.20, 0.48, 0.48);
    vec3 color = mix(deep, shallow, smoothstep(0.0, 0.9, across));

    float flow = vUv.y * 2.4 - uTime * 1.1;
    float wave = sin(flow + sin(vUv.x * 16.0 + uTime * 0.7) * 1.4);
    float glint = smoothstep(0.82, 1.0, wave * 0.5 + 0.5);
    color += glint * vec3(0.16, 0.16, 0.12);

    float alpha = 0.94 - across * 0.08;
    gl_FragColor = vec4(color, alpha);
  }
`

/** 河流：沙质河岸 + 流动水面，两层带状网格 */
export class RiverLayer {
  readonly group = new THREE.Group()
  private readonly waterMaterial: THREE.ShaderMaterial
  private readonly bankMaterial: THREE.MeshStandardMaterial
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly timeUniform = { value: 0 }

  constructor(rivers: PlanePoint[][]) {
    this.waterMaterial = new THREE.ShaderMaterial({
      vertexShader: waterVertexShader,
      fragmentShader: waterFragmentShader,
      uniforms: { uTime: this.timeUniform },
      transparent: true,
      side: THREE.DoubleSide,
    })

    this.bankMaterial = new THREE.MeshStandardMaterial({
      color: 0xb7a67a,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
    })

    for (const river of rivers) {
      const bankPoints = river.map((p) => new THREE.Vector3(p.x, BANK_Y, p.z))
      const waterPoints = river.map((p) => new THREE.Vector3(p.x, WATER_Y, p.z))

      const bankGeometry = createRibbon(bankPoints, 2.5, 0.2)
      const waterGeometry = createRibbon(waterPoints, 1.35, 1)

      this.geometries.push(bankGeometry, waterGeometry)

      const bank = new THREE.Mesh(bankGeometry, this.bankMaterial)
      bank.renderOrder = 1

      const water = new THREE.Mesh(waterGeometry, this.waterMaterial)
      water.renderOrder = 2

      this.group.add(bank, water)
    }
  }

  update(time: number): void {
    this.timeUniform.value = time
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose()
    this.waterMaterial.dispose()
    this.bankMaterial.dispose()
    this.group.clear()
  }
}
