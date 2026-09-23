const BASE = "http://127.0.0.1:3019";
let failures = 0;

function assert(cond, msg) {
  if (cond) {
    console.log("  PASS:", msg);
  } else {
    failures++;
    console.log("  FAIL:", msg);
  }
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

(async () => {
  // 第二首曲目（65mm 宽），用于宽度/并发预留校验
  let r = await api("POST", "/tunes", { title: "测试窄曲", stripSpec: { widthMm: 65 } });
  const tune2 = r.json.data.id;

  // 1. 登记批次到阴凉库
  r = await api("POST", "/rolls", { batchNo: "BATCH-E2E-X", widthMm: 70, remainingLengthMm: 10000, roomId: "room_cool" });
  assert(r.status === 201, `登记批次 201（实际 ${r.status}）`);
  const roll = r.json.data;
  const RID = roll.id;
  assert(roll.arrivedAt === null && roll.state === "in_storage", "阴凉库批次无到达时间");

  // 2. 阴凉库直接分配被拒
  r = await api("POST", `/rolls/${RID}/allocate`, { tuneId: "tune_demo", lengthMm: 3000 });
  assert(r.status === 409, `阴凉库分配 409（实际 ${r.status}）`);
  assert(r.json.reasons.some((x) => x.includes("尚未转入打孔间")), "原因：未到打孔间");

  // 3. 转入打孔间，立即分配被拒（12小时）
  r = await api("POST", `/rolls/${RID}/transfer`, { roomId: "room_punch" });
  assert(r.status === 200 && r.json.data.arrivedAt !== null, "转入打孔间并记录到达时间");
  r = await api("POST", `/rolls/${RID}/allocate`, { tuneId: "tune_demo", lengthMm: 3000 });
  assert(r.status === 409, `适应不足12h 分配 409（实际 ${r.status}）`);
  assert(r.json.reasons.some((x) => x.includes("不足12小时")), "原因：适应不足12小时");
  r = await api("GET", `/rolls/${RID}`);
  assert(r.json.data.remainingLengthMm === 10000 && r.json.data.reservedByTuneId === null, "拒绝后余长/预留原样保留");

  // 4. 湿度超65% + 到达时间伪造为13小时前 -> 仍被拒（湿度）
  await api("PATCH", "/rooms/room_punch/humidity", { humidityPct: 70 });
  r = await api("POST", `/rolls/${RID}/transfer`, { roomId: "room_punch", arrivedAt: new Date(Date.now() - 13 * 3600e3).toISOString() });
  assert(r.json.data.acclimationReady === true, "到达时间可指定且已满12h");
  r = await api("POST", `/rolls/${RID}/allocate`, { tuneId: "tune_demo", lengthMm: 3000 });
  assert(r.status === 409 && r.json.reasons.some((x) => x.includes("湿度")), `高湿 409（实际 ${r.status}）`);
  assert(r.json.json === undefined && r.json.roll.remainingLengthMm === 10000, "响应附带原批次快照、余长不变");

  // 5. 湿度恢复后宽度不匹配
  await api("PATCH", "/rooms/room_punch/humidity", { humidityPct: 55 });
  r = await api("POST", `/rolls/${RID}/allocate`, { tuneId: tune2, lengthMm: 3000 });
  assert(r.status === 409 && r.json.reasons.some((x) => x.includes("宽度")), `宽度不匹配 409（实际 ${r.status}）`);

  // 6. 正常分配：扣减 + 预留
  r = await api("POST", `/rolls/${RID}/allocate`, { tuneId: "tune_demo", lengthMm: 3000 });
  assert(r.status === 200, `合格条件分配 200（实际 ${r.status}）`);
  assert(r.json.data.remainingLengthMm === 7000, "余长扣减为7000");
  assert(r.json.data.reservedByTuneId === "tune_demo" && r.json.data.reservedLengthMm === 3000, "预留记录写入");

  // 7. 另一曲目不能同时预留
  r = await api("POST", `/rolls/${RID}/allocate`, { tuneId: tune2, lengthMm: 1000 });
  assert(r.status === 409 && r.json.reasons.some((x) => x.includes("另一首曲目")), `并发预留 409（实际 ${r.status}）`);

  // 8. 同曲目改约到9000：可用=7000+3000=10000，扣后余1000/预留9000
  r = await api("POST", `/rolls/${RID}/allocate`, { tuneId: "tune_demo", lengthMm: 9000 });
  assert(r.status === 200, `同曲目改约加大 200（实际 ${r.status}）`);
  assert(r.json.data.remainingLengthMm === 1000 && r.json.data.reservedLengthMm === 9000, "改约后余长1000/预留9000");

  // 9. 余量不足：再改约11000 > 可用10000，拒绝且状态不变
  r = await api("POST", `/rolls/${RID}/allocate`, { tuneId: "tune_demo", lengthMm: 11000 });
  assert(r.status === 409 && r.json.reasons.some((x) => x.includes("余量不足")), `余量不足 409（实际 ${r.status}，可用10000）`);
  r = await api("GET", `/rolls/${RID}`);
  assert(r.json.data.remainingLengthMm === 1000 && r.json.data.reservedLengthMm === 9000, "改约被拒不影响原扣减");

  // 10. 已预留不能转房
  r = await api("POST", `/rolls/${RID}/transfer`, { roomId: "room_cool" });
  assert(r.status === 409, `预留中转房 409（实际 ${r.status}）`);

  // 11. 释放后余量归还，可被第二首曲目预留
  r = await api("POST", `/rolls/${RID}/release`, { tuneId: "tune_demo" });
  assert(r.status === 200 && r.json.data.remainingLengthMm === 10000, "释放后余量归还10000");
  r = await api("POST", `/rolls/${RID}/allocate`, { tuneId: tune2, lengthMm: 12000 });
  assert(r.status === 409 && r.json.reasons.some((x) => x.includes("宽度")), "释放后宽度仍需匹配");

  // 12. 演示批次（已合格）可直接分配
  r = await api("POST", "/rolls/roll_demo/allocate", { tuneId: "tune_demo", lengthMm: 2000 });
  assert(r.status === 200 && r.json.data.remainingLengthMm === 10000, `演示批次正常扣减（实际 ${r.status}）`);

  // 13. 重复批次号 / 错误房间 / 非法湿度
  r = await api("POST", "/rolls", { batchNo: "BATCH-E2E-X", widthMm: 70, remainingLengthMm: 1, roomId: "room_cool" });
  assert(r.status === 409, `重复批次号 409（实际 ${r.status}）`);
  r = await api("POST", "/rolls", { batchNo: "BATCH-E2E-Y", widthMm: 70, remainingLengthMm: 1, roomId: "nope" });
  assert(r.status === 404, `未知房间 404（实际 ${r.status}）`);
  r = await api("PATCH", "/rooms/room_punch/humidity", { humidityPct: 120 });
  assert(r.status === 400, `非法湿度 400（实际 ${r.status}）`);
  r = await api("GET", "/rolls?reserved=false");
  assert(r.status === 200 && r.json.data.every((x) => !x.reservedByTuneId), "reserved=false 过滤生效");

  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
