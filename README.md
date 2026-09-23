# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间和试奏问题。

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
- `GET /rolls?room=` — 卷材列表，带适应状态（到达时长、湿度是否达标、被谁预留）
- `POST /rolls` — 登记批次：`{batchNo, widthMm, remainingM, room}`，批次号唯一
- `POST /rolls/:id/transfer` — 转入房间：`{room}`，记录到达时间（适应期从此起算）
- `POST /rolls/:id/allocate` — 分配给曲目：`{tuneId, lengthM}`，按曲目宽度校验并扣减余长
- `GET /rooms` / `PUT /rooms/:name/humidity` — 查看/更新房间湿度：`{humidityPct}`
- `GET /allocations?rollId=&tuneId=&status=` — 预留记录
- `POST /allocations/:id/release` — 释放预留；`{restoreLength:true}` 可退回未用的带长

## 卷材分配规则

- 卷材必须先转入「打孔间」，且距到达满 **12 小时**适应期才允许分配
- 所在房间湿度 **超过 65%** 时不能分配（无湿度记录同样拒绝）
- 卷材宽度必须与曲目 `stripSpec.widthMm` 一致
- 余长不足直接拒绝；同一批次同一时间只能被一首曲目预留
- 所有拒绝都返回 `409` 及原因，响应中附带原批次当前状态，数据不会被改动

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'
```

## 卷材流转示例

```bash
# 登记批次并转入打孔间（自动记录到达时间）
curl -X POST http://127.0.0.1:3019/rolls \
  -H 'Content-Type: application/json' \
  -d '{"batchNo":"PC-2026-0903","widthMm":70,"remainingM":100,"room":"阴凉库"}'
curl -X POST http://127.0.0.1:3019/rolls/<rollId>/transfer \
  -H 'Content-Type: application/json' \
  -d '{"room":"打孔间"}'

# 更新房间湿度
curl -X PUT "http://127.0.0.1:3019/rooms/打孔间/humidity" \
  -H 'Content-Type: application/json' \
  -d '{"humidityPct":58}'

# 适应满12小时且湿度≤65%后，按曲目扣减用带长度
curl -X POST http://127.0.0.1:3019/rolls/roll_demo_ready/allocate \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","lengthM":30}'

# 打孔完成后释放批次，其他曲目才能预留
curl -X POST http://127.0.0.1:3019/allocations/<allocId>/release \
  -H 'Content-Type: application/json' -d '{}'
```
