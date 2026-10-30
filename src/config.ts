/** 框架 Demo 的全部数值集中在这里，后续调平衡只改这个文件 */

/** 地图边长（世界单位），以原点为中心 */
export const MAP = 140

/** 坦克参数：全 Demo 只有这一种坦克 */
export const TANK = {
  hp: 100,
  speed: 7,
  range: 16,
  cooldown: 1.1,
  damage: 12,
}

/** 每方集群数与每集群坦克数 */
export const CLUSTERS = 3
export const TANKS_PER_CLUSTER = 6
export const SPACING = 3.4
