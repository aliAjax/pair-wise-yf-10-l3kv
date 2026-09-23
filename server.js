const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = path.join(__dirname, "data", "db.json");

const ACCLIMATE_MS = 12 * 60 * 60 * 1000;
const MAX_HUMIDITY_PCT = 65;

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: new Date().toISOString()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
  ],
  rooms: [
    { id: "room_cool", name: "阴凉库", kind: "cool", humidityPct: 45 },
    { id: "room_punch", name: "打孔间", kind: "punch", humidityPct: 55 }
  ],
  rolls: [
    {
      id: "roll_demo",
      batchNo: "BATCH-2026-001",
      widthMm: 70,
      remainingLengthMm: 12000,
      roomId: "room_punch",
      arrivedAt: new Date(Date.now() - ACCLIMATE_MS - 60 * 60 * 1000).toISOString(),
      reservedByTuneId: null,
      reservedLengthMm: 0,
      createdAt: new Date().toISOString()
    }
  ]
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /rooms",
  "PATCH /rooms/:id/humidity",
  "GET /rolls",
  "GET /rolls/:id",
  "POST /rolls",
  "POST /rolls/:id/transfer",
  "POST /rolls/:id/allocate",
  "POST /rolls/:id/release"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let needsInit = false;
  let data = null;
  try {
    data = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    needsInit = true;
  }
  if (needsInit) {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return;
  }
  let changed = false;
  for (const key of Object.keys(initialData)) {
    if (!Array.isArray(data[key])) {
      data[key] = initialData[key];
      changed = true;
    }
  }
  if (changed) await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

function findRoom(db, roomId) {
  const room = db.rooms.find((item) => item.id === roomId);
  if (!room) {
    const error = new Error("房间不存在");
    error.status = 404;
    throw error;
  }
  return room;
}

function findRoll(db, rollId) {
  const roll = db.rolls.find((item) => item.id === rollId);
  if (!roll) {
    const error = new Error("卷材不存在");
    error.status = 404;
    throw error;
  }
  return roll;
}

function positiveNumber(body, field) {
  const value = Number(body[field]);
  if (!Number.isFinite(value) || value <= 0) {
    const error = new Error(`字段${field}必须为大于0的数字`);
    error.status = 400;
    throw error;
  }
  return value;
}

function rollView(db, roll, now = new Date()) {
  const room = db.rooms.find((item) => item.id === roll.roomId);
  const acclimatedMs = roll.arrivedAt ? now.getTime() - new Date(roll.arrivedAt).getTime() : null;
  const acclimatedHours = acclimatedMs === null ? null : Math.floor(acclimatedMs / (60 * 60 * 1000));
  const readyAt = roll.arrivedAt
    ? new Date(new Date(roll.arrivedAt).getTime() + ACCLIMATE_MS).toISOString()
    : null;
  return {
    ...roll,
    roomName: room ? room.name : null,
    roomKind: room ? room.kind : null,
    roomHumidityPct: room ? room.humidityPct : null,
    state: roll.reservedByTuneId ? "reserved" : room && room.kind === "punch" ? "in_punch_room" : "in_storage",
    acclimatedHours,
    readyAt,
    acclimationReady: acclimatedMs !== null && acclimatedMs >= ACCLIMATE_MS
  };
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    await writeDb(db);
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = {
      id: makeId("section"),
      tuneId,
      startBeat: Number(body.startBeat),
      endBeat: Number(body.endBeat),
      laneRange: body.laneRange,
      checked: Boolean(body.checked),
      note: body.note || ""
    };
    db.sections.push(section);
    await writeDb(db);
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    await writeDb(db);
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
    if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
    const issue = {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat === undefined ? null : Number(body.beat),
      lane: body.lane === undefined ? null : Number(body.lane),
      description: body.description,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    await writeDb(db);
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
    if (!issue) return send(res, 404, { error: "问题不存在" });
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    await writeDb(db);
    return send(res, 200, { data: issue });
  }

  if (req.method === "GET" && pathname === "/rooms") {
    return send(res, 200, { data: db.rooms });
  }

  const roomHumidityMatch = pathname.match(/^\/rooms\/([^/]+)\/humidity$/);
  if (roomHumidityMatch && req.method === "PATCH") {
    const room = findRoom(db, roomHumidityMatch[1]);
    const body = await parseBody(req);
    const humidity = Number(body.humidityPct);
    if (!Number.isFinite(humidity) || humidity < 0 || humidity > 100) {
      return send(res, 400, { error: "湿度必须是0到100之间的数字" });
    }
    room.humidityPct = humidity;
    await writeDb(db);
    return send(res, 200, { data: room });
  }

  if (req.method === "GET" && pathname === "/rolls") {
    const roomId = searchParams.get("roomId");
    const includeReserved = searchParams.get("reserved");
    let rolls = db.rolls.map((item) => rollView(db, item));
    if (roomId) rolls = rolls.filter((item) => item.roomId === roomId);
    if (includeReserved === "false") rolls = rolls.filter((item) => !item.reservedByTuneId);
    return send(res, 200, { data: rolls });
  }

  const rollByIdMatch = pathname.match(/^\/rolls\/([^/]+)$/);
  if (rollByIdMatch && req.method === "GET") {
    const roll = findRoll(db, rollByIdMatch[1]);
    return send(res, 200, { data: rollView(db, roll) });
  }

  if (req.method === "POST" && pathname === "/rolls") {
    const body = await parseBody(req);
    required(body, ["batchNo", "widthMm", "remainingLengthMm", "roomId"]);
    findRoom(db, body.roomId);
    const widthMm = positiveNumber(body, "widthMm");
    const remainingLengthMm = positiveNumber(body, "remainingLengthMm");
    if (db.rolls.some((item) => item.batchNo === body.batchNo)) {
      return send(res, 409, { error: `批次号已登记：${body.batchNo}` });
    }
    let arrivedAt = null;
    if (body.arrivedAt !== undefined) {
      const stamp = new Date(body.arrivedAt);
      if (Number.isNaN(stamp.getTime())) return send(res, 400, { error: "arrivedAt时间格式无法识别" });
      arrivedAt = stamp.toISOString();
    } else if (db.rooms.find((item) => item.id === body.roomId).kind === "punch") {
      arrivedAt = new Date().toISOString();
    }
    const roll = {
      id: makeId("roll"),
      batchNo: body.batchNo,
      widthMm,
      remainingLengthMm,
      roomId: body.roomId,
      arrivedAt,
      reservedByTuneId: null,
      reservedLengthMm: 0,
      createdAt: new Date().toISOString()
    };
    db.rolls.push(roll);
    await writeDb(db);
    return send(res, 201, { data: rollView(db, roll) });
  }

  const transferMatch = pathname.match(/^\/rolls\/([^/]+)\/transfer$/);
  if (transferMatch && req.method === "POST") {
    const roll = findRoll(db, transferMatch[1]);
    const body = await parseBody(req);
    required(body, ["roomId"]);
    const room = findRoom(db, body.roomId);
    if (roll.reservedByTuneId) {
      return send(res, 409, { error: "该批次已被曲目预留，不能转移房间" });
    }
    let arrivedAt = roll.arrivedAt;
    if (room.kind === "punch") {
      if (body.arrivedAt !== undefined) {
        const stamp = new Date(body.arrivedAt);
        if (Number.isNaN(stamp.getTime())) return send(res, 400, { error: "arrivedAt时间格式无法识别" });
        arrivedAt = stamp.toISOString();
      } else {
        arrivedAt = new Date().toISOString();
      }
    } else {
      arrivedAt = null;
    }
    roll.roomId = room.id;
    roll.arrivedAt = arrivedAt;
    await writeDb(db);
    return send(res, 200, { data: rollView(db, roll) });
  }

  const allocateMatch = pathname.match(/^\/rolls\/([^/]+)\/allocate$/);
  if (allocateMatch && req.method === "POST") {
    const roll = findRoll(db, allocateMatch[1]);
    const body = await parseBody(req);
    required(body, ["tuneId", "lengthMm"]);
    const tune = findTune(db, body.tuneId);
    const lengthMm = positiveNumber(body, "lengthMm");
    const room = db.rooms.find((item) => item.id === roll.roomId);
    const now = new Date();
    const reasons = [];

    if (!room || room.kind !== "punch") {
      reasons.push("卷材尚未转入打孔间，不能分配");
    }
    if (roll.arrivedAt) {
      const elapsedMs = now.getTime() - new Date(roll.arrivedAt).getTime();
      if (elapsedMs < ACCLIMATE_MS) {
        const waitHours = Math.ceil((ACCLIMATE_MS - elapsedMs) / (60 * 60 * 1000));
        reasons.push(`到达打孔间不足12小时，还需等待约${waitHours}小时`);
      }
    }
    if (room && room.kind === "punch" && room.humidityPct > MAX_HUMIDITY_PCT) {
      reasons.push(`打孔间湿度${room.humidityPct}%超过${MAX_HUMIDITY_PCT}%上限，禁止开卷`);
    }

    const requiredWidth = tune.stripSpec && Number(tune.stripSpec.widthMm);
    if (Number.isFinite(requiredWidth) && requiredWidth !== roll.widthMm) {
      reasons.push(`卷材宽度${roll.widthMm}mm与曲目要求${requiredWidth}mm不匹配`);
    }

    const reallocating = roll.reservedByTuneId === tune.id;
    if (roll.reservedByTuneId && !reallocating) {
      reasons.push("该批次已被另一首曲目预留，不能同时预留");
    }

    const availableMm = reallocating ? roll.remainingLengthMm + roll.reservedLengthMm : roll.remainingLengthMm;
    if (lengthMm > availableMm) {
      reasons.push(`余量不足：需要${lengthMm}mm，可用${availableMm}mm`);
    }

    if (reasons.length) {
      return send(res, 409, {
        error: "卷材不可分配",
        reasons,
        roll: rollView(db, roll, now)
      });
    }

    roll.remainingLengthMm = availableMm - lengthMm;
    roll.reservedByTuneId = tune.id;
    roll.reservedLengthMm = lengthMm;
    await writeDb(db);
    return send(res, 200, { data: rollView(db, roll, now) });
  }

  const releaseMatch = pathname.match(/^\/rolls\/([^/]+)\/release$/);
  if (releaseMatch && req.method === "POST") {
    const roll = findRoll(db, releaseMatch[1]);
    if (!roll.reservedByTuneId) {
      return send(res, 409, { error: "该批次当前没有预留" });
    }
    const body = await parseBody(req);
    if (body.tuneId && body.tuneId !== roll.reservedByTuneId) {
      return send(res, 409, { error: "只能由预留该批次的曲目释放" });
    }
    roll.remainingLengthMm += roll.reservedLengthMm;
    roll.reservedByTuneId = null;
    roll.reservedLengthMm = 0;
    await writeDb(db);
    return send(res, 200, { data: rollView(db, roll) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
