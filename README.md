# Placeholder.SLG
未定名 SLG 游戏

设计文档：[大地图行军推演](docs/大地图行军推演.md)

## 运行

```bash
npm install
npm run dev        # 前端 Vite HMR + 服务端 tsx watch 自动重启
npm run server     # 只启动后端（不监听文件变更，需手动重启）
npm run type-check # 前端与服务端类型检查

npm run build      # 构建前端到 dist/
npm run server     # 生产：同一端口托管 dist/ 与 /api
```

开发时修改 `src-server/` 或共享层 `src-shared/` 会自动重启；若启动提示端口 8787 被占用，先停止旧的 `npm run dev` / `npm run server` 进程。

目录划分：`src-front/` 只放渲染与传输（Three.js 图层、Vue 组件、REST 客户端），`src-shared/` 放前后端共享的数据模型、协议、编解码与纯地图工具，`src-server/` 放唯一权威世界与全部规则计算（推演、AI 决策、频道、存档）。前端通过 `@shared/*` 别名引用共享层。

生产模式下无需单独部署静态服务器：`src-server` 会挂载 `dist/`，未命中的客户端路由回退到 `index.html`，产物目录可用 `SLG_CLIENT_DIR` 覆盖。

## 存档

存档存放在 `src-server/data/save.db`（Node 内置 `node:sqlite`，无需额外依赖），该目录已在 `.gitignore` 中忽略。

- 手动存档：设置界面「存档」页签命名保存、读取、删除
- 自动续档：每 5 回合与服务退出前写入，服务启动时自动恢复；不计入手动存档列表

## 角色属性

地图角色由角色属性驱动，存放在 `src-server/data/cards.db`（与存档库相互独立）：首次启动自动种入 9 名内置角色，玩家可在设置界面「角色」页签新建角色；职位为「无」的角色立即进驻地图，大臣与团长坐镇指挥不上图。详见 `docs/角色系统/角色属性.md`。

