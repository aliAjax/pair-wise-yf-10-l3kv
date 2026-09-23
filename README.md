# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题，以及卷材批次与房间环境。

## 启动

```bash
PORT=3019 node server.js
```

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

### 房间与卷材流转

- `GET /rooms` 房间列表（含当前湿度读数）
- `PATCH /rooms/:id/humidity` 上报房间湿度，body：`{"humidityPct": 58}`
- `GET /rolls?roomId=&reserved=false` 卷材列表（含余长、到达时间、适应时长、湿度、预留状态）
- `GET /rolls/:id` 卷材详情
- `POST /rolls` 登记批次：`{"batchNo","widthMm","remainingLengthMm","roomId"}`；直接登记在打孔间时以当前时间记到达时间
- `POST /rolls/:id/transfer` 转入房间，body：`{"roomId":"room_punch"}`；转入打孔间自动记到达时间（可用 `arrivedAt` 指定）
- `POST /rolls/:id/allocate` 按曲目分配预留，body：`{"tuneId","lengthMm"}`
- `POST /rolls/:id/release` 释放预留，余量归还（body 可带 `tuneId` 校验归属）

### 分配规则

卷材只有同时满足以下条件才能分配，否则返回 `409` 并在 `reasons` 中列出全部原因，原批次数据保持不变：

1. 卷材已转入打孔间；
2. 距到达打孔间已满 12 小时适应期（`readyAt` 为最早可分配时间）；
3. 打孔间当前湿度不超过 65%；
4. 卷材宽度与曲目 `stripSpec.widthMm` 一致；
5. 同一批次未被其他曲目预留（同一曲目再次分配视为改约，按新旧长度差额调整）；
6. 余量足够覆盖 `lengthMm`。

分配成功即按用带长度扣减余长并记录预留；已预留的卷材不能转移房间。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'

# 卷材从阴凉库转入打孔间（记录到达时间），满12小时且湿度合格后分配给曲目
curl -X POST http://127.0.0.1:3019/rolls \
  -H 'Content-Type: application/json' \
  -d '{"batchNo":"BATCH-2026-002","widthMm":70,"remainingLengthMm":15000,"roomId":"room_cool"}'
curl -X POST http://127.0.0.1:3019/rolls/<rollId>/transfer \
  -H 'Content-Type: application/json' \
  -d '{"roomId":"room_punch"}'
curl -X POST http://127.0.0.1:3019/rolls/<rollId>/allocate \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","lengthMm":3000}'
```
