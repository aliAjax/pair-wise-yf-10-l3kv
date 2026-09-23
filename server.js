const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = path.join(__dirname, "data", "db.json");

const PUNCH_ROOM = "打孔间";
const ACCLIMATION_HOURS = 12;
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
  rolls: [
    {
      id: "roll_demo_ready",
      batchNo: "PC-2026-0901",
      widthMm: 70,
      remainingM: 120,
      room: "打孔间",
      arrivedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 72 * 3600 * 1000).toISOString()
    },
    {
      id: "roll_demo_storage",
      batchNo: "PC-2026-0902",
      widthMm: 70,
      remainingM: 80,
      room: "阴凉库",
      arrivedAt: null,
      createdAt: new Date().toISOString()
    }
  ],
  rooms: [
    { name: "阴凉库", humidityPct: 52, updatedAt: new Date().toISOString() },
    { name: "打孔间", humidityPct: 58, updatedAt: new Date().toISOString() }
  ],
  allocations: []
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
  "GET /rolls",
  "POST /rolls",
  "POST /rolls/:id/transfer",
  "POST /rolls/:id/allocate",
  "GET /rooms",
  "PUT /rooms/:name/humidity",
  "GET /allocations",
  "POST /allocations/:id/release"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  db.rolls = Array.isArray(db.rolls) ? db.rolls : [];
  db.rooms = Array.isArray(db.rooms) ? db.rooms : [];
  db.allocations = Array.isArray(db.allocations) ? db.allocations : [];
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

let exclusiveQueue = Promise.resolve();
function runExclusive(task) {
  const result = exclusiveQueue.then(task);
  exclusiveQueue = result.catch(() => {});
  return result;
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

function buildRollStatus(db, roll) {
  const hoursSinceArrival = roll.arrivedAt ? (Date.now() - Date.parse(roll.arrivedAt)) / 3600000 : null;
  const room = db.rooms.find((item) => item.name === roll.room);
  const active = db.allocations.find((item) => item.rollId === roll.id && item.status === "reserved");
  return {
    inPunchRoom: roll.room === PUNCH_ROOM,
    hoursSinceArrival: hoursSinceArrival === null ? null : Math.round(hoursSinceArrival * 10) / 10,
    acclimated: hoursSinceArrival !== null && hoursSinceArrival >= ACCLIMATION_HOURS,
    roomHumidityPct: room ? room.humidityPct : null,
    humidityOk: Boolean(room) && room.humidityPct <= MAX_HUMIDITY_PCT,
    reservedByTuneId: active ? active.tuneId : null
  };
}

function allocateRoll(db, rollId, body) {
  const roll = db.rolls.find((item) => item.id === rollId);
  if (!roll) return { status: 404, body: { error: "卷材批次不存在" } };
  const tune = db.tunes.find((item) => item.id === body.tuneId);
  if (!tune) return { status: 404, body: { error: "曲目不存在" } };
  const lengthM = Number(body.lengthM);
  if (!Number.isFinite(lengthM) || lengthM <= 0) {
    return { status: 400, body: { error: "用带长度必须是正数" } };
  }
  if (roll.room !== PUNCH_ROOM) {
    return { status: 409, body: { error: `卷材当前在「${roll.room}」，未转入${PUNCH_ROOM}，不能分配`, roll } };
  }
  const hoursSinceArrival = roll.arrivedAt ? (Date.now() - Date.parse(roll.arrivedAt)) / 3600000 : null;
  if (hoursSinceArrival === null) {
    return { status: 409, body: { error: `卷材缺少到达${PUNCH_ROOM}的时间记录，不能分配`, roll } };
  }
  if (hoursSinceArrival < ACCLIMATION_HOURS) {
    const waited = Math.round(hoursSinceArrival * 10) / 10;
    return { status: 409, body: { error: `距到达${PUNCH_ROOM}仅${waited}小时，不足${ACCLIMATION_HOURS}小时适应期，不能分配`, roll } };
  }
  const room = db.rooms.find((item) => item.name === roll.room);
  if (!room) {
    return { status: 409, body: { error: `${roll.room}暂无湿度记录，无法确认湿度不高于${MAX_HUMIDITY_PCT}%，不能分配`, roll } };
  }
  if (room.humidityPct > MAX_HUMIDITY_PCT) {
    return { status: 409, body: { error: `${roll.room}湿度${room.humidityPct}%超过${MAX_HUMIDITY_PCT}%上限，不能分配`, roll } };
  }
  const tuneWidth = tune.stripSpec && tune.stripSpec.widthMm !== undefined ? Number(tune.stripSpec.widthMm) : null;
  if (tuneWidth !== null && tuneWidth !== roll.widthMm) {
    return { status: 409, body: { error: `卷材宽度${roll.widthMm}mm与曲目《${tune.title}》纸带宽度${tuneWidth}mm不符，不能分配`, roll } };
  }
  const active = db.allocations.find((item) => item.rollId === roll.id && item.status === "reserved");
  if (active && active.tuneId !== tune.id) {
    const holder = db.tunes.find((item) => item.id === active.tuneId);
    return { status: 409, body: { error: `批次${roll.batchNo}已被曲目《${holder ? holder.title : active.tuneId}》预留，同一批次不能同时预留给两首曲目`, roll } };
  }
  if (roll.remainingM < lengthM) {
    return { status: 409, body: { error: `余长不足：剩余${roll.remainingM}m，本次需要${lengthM}m`, roll } };
  }
  roll.remainingM = Math.round((roll.remainingM - lengthM) * 1000) / 1000;
  const allocation = {
    id: makeId("alloc"),
    rollId: roll.id,
    batchNo: roll.batchNo,
    tuneId: tune.id,
    widthMm: roll.widthMm,
    lengthM,
    status: "reserved",
    createdAt: new Date().toISOString(),
    releasedAt: null
  };
  db.allocations.push(allocation);
  return { status: 201, body: { data: { allocation, roll } }, write: true };
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

  if (req.method === "GET" && pathname === "/rolls") {
    const room = searchParams.get("room");
    const rolls = db.rolls
      .filter((item) => !room || item.room === room)
      .map((roll) => ({ ...roll, status: buildRollStatus(db, roll) }));
    return send(res, 200, { data: rolls });
  }

  if (req.method === "POST" && pathname === "/rolls") {
    const body = await parseBody(req);
    required(body, ["batchNo", "widthMm", "remainingM", "room"]);
    const widthMm = Number(body.widthMm);
    const remainingM = Number(body.remainingM);
    if (!Number.isFinite(widthMm) || widthMm <= 0) return send(res, 400, { error: "宽度必须是正数" });
    if (!Number.isFinite(remainingM) || remainingM < 0) return send(res, 400, { error: "余长必须是非负数字" });
    if (db.rolls.some((item) => item.batchNo === body.batchNo)) {
      return send(res, 409, { error: `批次号${body.batchNo}已登记` });
    }
    const now = new Date().toISOString();
    const roll = {
      id: makeId("roll"),
      batchNo: body.batchNo,
      widthMm,
      remainingM,
      room: body.room,
      arrivedAt: body.room === PUNCH_ROOM ? now : null,
      createdAt: now
    };
    db.rolls.push(roll);
    await writeDb(db);
    return send(res, 201, { data: roll });
  }

  const transferMatch = pathname.match(/^\/rolls\/([^/]+)\/transfer$/);
  if (transferMatch && req.method === "POST") {
    const roll = db.rolls.find((item) => item.id === transferMatch[1]);
    if (!roll) return send(res, 404, { error: "卷材批次不存在" });
    const body = await parseBody(req);
    required(body, ["room"]);
    roll.room = body.room;
    roll.arrivedAt = new Date().toISOString();
    await writeDb(db);
    return send(res, 200, { data: roll });
  }

  const allocateMatch = pathname.match(/^\/rolls\/([^/]+)\/allocate$/);
  if (allocateMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["tuneId", "lengthM"]);
    const result = await runExclusive(async () => {
      const fresh = await readDb();
      const allocationResult = allocateRoll(fresh, allocateMatch[1], body);
      if (allocationResult.write) await writeDb(fresh);
      return allocationResult;
    });
    return send(res, result.status, result.body);
  }

  if (req.method === "GET" && pathname === "/rooms") {
    return send(res, 200, { data: db.rooms });
  }

  const humidityMatch = pathname.match(/^\/rooms\/([^/]+)\/humidity$/);
  if (humidityMatch && req.method === "PUT") {
    const name = decodeURIComponent(humidityMatch[1]);
    const body = await parseBody(req);
    required(body, ["humidityPct"]);
    const humidityPct = Number(body.humidityPct);
    if (!Number.isFinite(humidityPct) || humidityPct < 0 || humidityPct > 100) {
      return send(res, 400, { error: "湿度必须是0-100的数字" });
    }
    let room = db.rooms.find((item) => item.name === name);
    if (!room) {
      room = { name, humidityPct, updatedAt: null };
      db.rooms.push(room);
    }
    room.humidityPct = humidityPct;
    room.updatedAt = new Date().toISOString();
    await writeDb(db);
    return send(res, 200, { data: room });
  }

  if (req.method === "GET" && pathname === "/allocations") {
    const rollId = searchParams.get("rollId");
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const allocations = db.allocations.filter(
      (item) =>
        (!rollId || item.rollId === rollId) &&
        (!tuneId || item.tuneId === tuneId) &&
        (!status || item.status === status)
    );
    return send(res, 200, { data: allocations });
  }

  const releaseMatch = pathname.match(/^\/allocations\/([^/]+)\/release$/);
  if (releaseMatch && req.method === "POST") {
    const body = await parseBody(req);
    const result = await runExclusive(async () => {
      const fresh = await readDb();
      const allocation = fresh.allocations.find((item) => item.id === releaseMatch[1]);
      if (!allocation) return { status: 404, body: { error: "预留记录不存在" } };
      if (allocation.status !== "reserved") return { status: 409, body: { error: "该预留已释放" } };
      allocation.status = "released";
      allocation.releasedAt = new Date().toISOString();
      const roll = fresh.rolls.find((item) => item.id === allocation.rollId);
      if (roll && body.restoreLength === true) {
        roll.remainingM = Math.round((roll.remainingM + allocation.lengthM) * 1000) / 1000;
      }
      await writeDb(fresh);
      return { status: 200, body: { data: { allocation, roll: roll || null } } };
    });
    return send(res, result.status, result.body);
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
