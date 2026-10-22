# Placeholder.SLG
未定名 SLG 游戏

设计文档：[大地图行军推演](docs/大地图行军推演.md)

## 运行

```bash
npm install
npm run dev        # 同时启动后端（8787）与前端
npm run server     # 只启动后端权威服务
npm run type-check # 前端与服务端类型检查

npm run build      # 构建前端到 dist/
npm run server     # 生产：同一端口托管 dist/ 与 /api
```

生产模式下无需单独部署静态服务器：`src-server` 会挂载 `dist/`，未命中的客户端路由回退到 `index.html`，产物目录可用 `SLG_CLIENT_DIR` 覆盖。
