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

开发时修改 `src-server/` 或服务端复用的 `src-front/game/` 内核文件会自动重启；若启动提示端口 8787 被占用，先停止旧的 `npm run dev` / `npm run server` 进程。

生产模式下无需单独部署静态服务器：`src-server` 会挂载 `dist/`，未命中的客户端路由回退到 `index.html`，产物目录可用 `SLG_CLIENT_DIR` 覆盖。
