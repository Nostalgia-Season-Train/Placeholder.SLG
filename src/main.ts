import './style.css'
import { World } from './world'
import { View } from './scene'
import { Controls } from './controls'
import { Hud } from './hud'

const world = new World()
const view = new View(document.getElementById('app') as HTMLElement)
const controls = new Controls(view, world)
const hud = new Hud()

let last = performance.now()
function frame(now: number) {
  // 单帧最长按 50ms 算，切标签页回来不会让坦克瞬移
  const dt = Math.min((now - last) / 1000, 0.05)
  last = now

  controls.update(dt)
  world.update(dt)
  view.sync(world, controls.selected)
  hud.sync(world, controls.selected)
  view.render()

  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)
