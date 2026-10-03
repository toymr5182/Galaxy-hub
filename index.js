const fs = require('fs')
const path = require('path')
/* ===========================
   MINECRAFT-DATA PIN (รองรับเวอร์ชัน 26.x จาก fork)
   ปัญหา: มีหลายแพ็กเกจ (prismarine-registry, pathfinder ฯลฯ) ดึง minecraft-data
   ตัวทางการ (ไม่มีข้อมูล 26.2) ทำให้ขึ้น "Do not have data for 26.2"
   ทางแก้: บังคับให้ทุก require('minecraft-data') ชี้ไปที่ตัวเดียวกับที่
   minecraft-protocol (fork) ใช้ — จะทำงานเฉพาะเมื่อตัวนั้นเป็น fork (+complexity)
   ถ้าใช้ไลบรารีทางการจะไม่ทำอะไรเลย
=========================== */
;(function pinMinecraftData() {
  try {
    const Module = require('module')
    const protoPath = require.resolve('minecraft-protocol')
    const dataEntry = require.resolve('minecraft-data', { paths: [path.dirname(protoPath)] })
    // หา package.json ของ minecraft-data ที่ตรงกับไฟล์ entry
    let dir = path.dirname(dataEntry)
    let pkg = null
    for (let i = 0; i < 4; i++) {
      const f = path.join(dir, 'package.json')
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (j.name === 'minecraft-data') { pkg = j; break }
      }
      dir = path.dirname(dir)
    }
    if (!pkg || !String(pkg.version).includes('complexity')) return
    const origResolve = Module._resolveFilename
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'minecraft-data') return dataEntry
      return origResolve.call(this, request, ...rest)
    }
    console.log(`[DATA] minecraft-data pinned -> ${pkg.version}`)
  } catch (e) {
    console.error('[DATA] pin skipped:', e.message)
  }
})()

const mineflayer = require('mineflayer')
const express = require('express')

/* ===========================
   CRASH SAFETY NET
   A bug deep inside a dependency (e.g. mineflayer-pathfinder's internal
   tool-selection logic) must never be allowed to kill the whole process —
   that would disconnect every managed bot at once. Log it and keep going.
=========================== */
process.on('uncaughtException', (err) => {
  console.error('[SAFETY-NET] Uncaught exception (server kept running):', err && err.stack ? err.stack : err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[SAFETY-NET] Unhandled rejection (server kept running):', reason)
})

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), bots: bots.size })
})

app.get('/styles.css', (req, res) => {
  const cssPath = path.join(__dirname, 'styles.css')
  if (fs.existsSync(cssPath)) {
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.sendFile(cssPath)
  } else {
    res.status(404).send('styles.css not found')
  }
})

/* ===========================
   CONFIG & PERSISTENCE
=========================== */

const BOTS_CONFIG_FILE = path.join(__dirname, 'bots_config.json')
const SERVER_CONFIG_FILE = path.join(__dirname, 'server_config.json')

let serverConfig = {
  host: 'play.amorycraft.com',
  port: 25565,
  defaultUsername: 'FGOP',
  version: '' // ว่าง = ตรวจเวอร์ชันอัตโนมัติ, หรือใส่เช่น '26.2' / '1.21.8'
}

// โหลด server config แยก
function loadServerConfig() {
  if (fs.existsSync(SERVER_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(SERVER_CONFIG_FILE, 'utf8')
      if (raw.trim()) {
        const data = JSON.parse(raw)
        if (data.host) serverConfig.host = data.host
        if (data.port) serverConfig.port = Number(data.port) || 25565
        if (data.defaultUsername) serverConfig.defaultUsername = data.defaultUsername
        if (data.version !== undefined && data.version !== null) serverConfig.version = String(data.version).trim()
      }
    } catch (e) {
      console.error('[ERROR] Failed to load server config:', e.message)
    }
  }
}

function saveServerConfig() {
  try {
    fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify(serverConfig, null, 2))
  } catch (e) {
    console.error('[ERROR] Failed to save server config:', e.message)
  }
}

let nextBotId = 1
const bots = new Map()

let saveTimeout = null
function scheduleSaveBots() {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    saveBots()
    saveTimeout = null
  }, 1000)
}

function saveBots() {
  try {
    const data = Array.from(bots.values()).map(b => ({
      username: b.state.originalUsername,
      accountType: b.state.accountType,
      theme: b.state.theme || 'galaxy',
      autoLogin: b.state.autoLogin,
      loginPassword: b.state.loginPassword,
      autoPin: b.state.autoPin,
      loginPin: b.state.loginPin,
      autoCommands: b.state.autoCommands,
      autoServerSelect: b.state.autoServerSelect,
      serverSelectItem: b.state.serverSelectItem,
      autoEat: b.state.autoEat,
      autoWalk: b.state.autoWalk
    }))
    const tmpFile = BOTS_CONFIG_FILE + '.tmp'
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2))
    fs.renameSync(tmpFile, BOTS_CONFIG_FILE)
  } catch (err) {
    console.error('[ERROR] Failed to save bots config:', err.message)
  }
}

function loadBots() {
  if (fs.existsSync(BOTS_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(BOTS_CONFIG_FILE, 'utf8')
      if (!raw.trim()) {
        console.log('[SYSTEM] Config file is empty, starting fresh')
        createManagedBot({ username: serverConfig.defaultUsername, accountType: 'offline' })
        return
      }
      const data = JSON.parse(raw)
      if (!Array.isArray(data) || data.length === 0) {
        console.log('[SYSTEM] No bots in config, creating default')
        createManagedBot({ username: serverConfig.defaultUsername, accountType: 'offline' })
        return
      }
      data.forEach(botCfg => createManagedBot(botCfg))
      console.log(`[SYSTEM] Restored ${data.length} bots from config.`)
    } catch (e) {
      console.error('[ERROR] Failed to load bots config:', e.message)
      try {
        const backupFile = BOTS_CONFIG_FILE + '.backup.' + Date.now()
        fs.copyFileSync(BOTS_CONFIG_FILE, backupFile)
        console.log(`[SYSTEM] Corrupted config backed up to ${backupFile}`)
      } catch {}
      createManagedBot({ username: serverConfig.defaultUsername, accountType: 'offline' })
    }
  } else {
    createManagedBot({ username: serverConfig.defaultUsername, accountType: 'offline' })
  }
}

/* ===========================
   AUTO-EAT DATA
=========================== */

const FOOD_PRIORITY = [
  'golden_apple', 'enchanted_golden_apple',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'baked_potato', 'bread', 'apple', 'carrot', 'potato', 'melon_slice', 'sweet_berries', 'glow_berries',
  'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
  'pumpkin_pie', 'cookie', 'dried_kelp', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'beetroot'
]
const FOOD_AVOID = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

/* ===========================
   HELPERS
=========================== */

const TIME_FMT_OPTS = { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }
function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/[&<>"']/g, c => HTML_ESC[c])
}

function stringifyMsg(msg) {
  try {
    if (!msg || msg === null) return 'Unknown message'
    if (typeof msg === 'string') return msg
    if (typeof msg === 'number' || typeof msg === 'boolean') return String(msg)
    if (msg.text) return msg.text
    if (msg.translate) {
      const translateWith = Array.isArray(msg.with)
        ? msg.with.map(w => typeof w === 'string' ? w : (w && w.text) ? w.text : '').join(', ')
        : ''
      return msg.translate + (translateWith ? ': ' + translateWith : '')
    }
    if (Array.isArray(msg.extra)) {
      return msg.extra.map(x => typeof x === 'string' ? x : (x.text || '')).join('')
    }
    if (msg.toJSON && typeof msg.toJSON === 'function') {
      const json = msg.toJSON()
      if (json && json.text) return json.text
    }
    if (typeof msg.toString === 'function') {
      const str = msg.toString()
      return str !== '[object Object]' ? str : JSON.stringify(msg)
    }
    return JSON.stringify(msg)
  } catch {
    return 'Unknown message'
  }
}

function getUptime(state) {
  if (!state.connectedAt) return '-'
  const sec = Math.floor((Date.now() - state.connectedAt) / 1000)
  if (sec < 0) return '-'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function pushLog(state, msg) {
  if (!msg) return
  state.lastMessage = msg
  const now = new Date()
  const hh = now.getHours().toString().padStart(2, '0')
  const mm = now.getMinutes().toString().padStart(2, '0')
  const ss = now.getSeconds().toString().padStart(2, '0')
  const line = `[${hh}:${mm}:${ss}] ${msg}`
  state.logs.unshift(line)
  if (/^\[(NPC|BUILD)\]/.test(msg)) {
    if (!state.npcLines) state.npcLines = []
    state.npcLines.unshift(line)
    if (state.npcLines.length > 80) state.npcLines.length = 80
  }
  // ✅ ข้อ 9: ลดจำนวน log สูงสุดเหลือ 100 บรรทัด
  if (state.logs.length > 100) state.logs.length = 100
}

/* ===========================
   BOT MANAGER CORE
=========================== */

function createManagedBot({ username, accountType, theme, autoLogin, loginPassword, autoPin, loginPin, autoCommands, autoServerSelect, serverSelectItem, autoEat, autoWalk }) {
  const state = {
    id: nextBotId++,
    username,
    originalUsername: username,
    accountType: accountType || 'offline',
    theme: theme || 'galaxy',
    status: 'starting',
    lastMessage: '-',
    connectedAt: null,
    logs: [],
    autoLogin: autoLogin === true || autoLogin === 'true',
    loginPassword: loginPassword || '',
    loginPin: String(loginPin || '').replace(/[^0-9]/g, '').slice(0, 8),
    autoPin: autoPin === undefined ? !!loginPin : (autoPin === true || autoPin === 'true'),
    autoCommands: Array.isArray(autoCommands) ? autoCommands : [],
    autoServerSelect: autoServerSelect === true || autoServerSelect === 'true',
    serverSelectItem: serverSelectItem || 'grass_block',
    autoEat: autoEat === undefined ? true : (autoEat === true || autoEat === 'true'),
    autoWalk: autoWalk === undefined ? true : (autoWalk === true || autoWalk === 'true') // เดินไปหา NPC เองหลังใส่ PIN เสร็จ
  }

  let bot = null
  let reconnectTimeout = null
  let autoCmdTimers = []
  let reconnectAttempts = 0
  let dialogAttempts = 0
  let dialogSeenPreSpawn = false // เจอ dialog ก่อน spawn -> ขยายเวลา timeout
  let pinCooldownUntil = 0
  let pinLatest = null
  let pinRecheck = null
  let pinSubmits = 0             // จำนวนครั้งที่บอทกรอก PIN ครบ 4 หลัก (กันโดนล็อก) — ข้าม reconnect
  let pinRun = null              // สถานะการกด PIN ที่กำลังทำอยู่
  let pinLastDialog = null       // dialog PIN ล่าสุดที่เซิร์ฟเวอร์ส่งมา (ปุ่ม + จำนวนครั้งที่เหลือ + จุดแสดงหลัก)
  let pinSoftFails = 0           // รอบที่เซิร์ฟเวอร์ "ไม่นับ" (คลิกไม่ครบ/ถูกรีเซ็ต) — ไม่เสียโอกาส แต่จำกัดไว้กันวน
  let pinWrong = false           // เซิร์ฟเวอร์ยืนยันแล้วว่า PIN ที่บันทึกไว้ผิด (กดครบทุกหลักและถูกนับว่าผิด)
  let pinDotsProven = false      // เคยเห็นจุดเปลี่ยนตามการกดจริง = เชื่อจุดได้ (ใช้ตัดสินว่าคลิกถูกรับหรือไม่)
  let pinDotEmpty = '○'          // สัญลักษณ์จุด "ว่าง" ในหน้า PIN
  let clickHexLogged = 0
  let physTicks = 0
  let forcedMoves = 0
  let groundFalse = 0            // จำนวน physics tick ที่ onGround=false (ใช้วัดอาการ "ลอย/ตก มาๆ หายๆ")
  let lastGround = false         // onGround ของ tick ล่าสุดก่อนเซิร์ฟเวอร์แก้ตำแหน่ง
  let lastVel = null             // ความเร็วแนวนอนของ tick ล่าสุด
  let softFixes = 0              // จำนวนครั้งที่ฟื้น onGround/ความเร็วหลังเซิร์ฟเวอร์แค่ "ซิงก์" ตำแหน่ง
  let outMoves = 0               // จำนวนแพ็กเก็ตเคลื่อนที่ที่บอทส่งออกไปจริง (position/look/flying)
  let sentLoaded = false         // บอทเคยส่ง player_loaded หรือยัง
  // --- ให้บอทส่งแพ็กเก็ตครบเหมือนไคลเอนต์จริง (ถ้า mineflayer ไม่ส่ง เราส่งแทนและ log บอก) ---
  let pullTimes = []             // เวลาที่เซิร์ฟเวอร์ดึงตำแหน่งบอท (forcedMove) ใน 10 วิล่าสุด
  let lastPullAt = 0
  let lastPullOut = 0            // outMoves ตอนถูกดึงครั้งก่อน
  let pullLogN = 0               // จำนวนครั้งที่ log รายละเอียดการถูกดึง (รีเซ็ตทุกครั้งที่เริ่มกดเดินใหม่)
  let outSeen = {}               // ชื่อแพ็กเก็ตใน play ที่บอทส่งออกไป -> จำนวน
  let settingsAny = false        // บอทเคยส่ง settings/client_information (state ไหนก็ได้) ในการเชื่อมต่อนี้
  let tpConfirmed = new Set()    // teleportId ที่บอทตอบ confirm แล้ว
  let tpSeenIn = 0, tpForced = 0
  let chunkBatchesIn = 0, chunkAcksOut = 0, chunkAcksForced = 0
  let pongSent = new Set(), pongForced = 0
  let tickEndOut = 0, tickEndForce = false, tickEndChecked = false, tickEndForced = 0
  let entryToken = 0
  let walkDiagDone = false
  let lastPhys = null            // ตำแหน่งล่าสุดที่ physics ของบอทคำนวณได้ (ก่อนเซิร์ฟเวอร์ดึงกลับ)
  let uiDialog = null          // dialog ล่าสุดที่เซิร์ฟเวอร์ส่งมา (ให้แดชบอร์ดแสดง/กดเอง)
  let pinManualUntil = 0       // ช่วงที่ให้คนกด PIN เอง — บอทจะไม่กดอัตโนมัติ
  let pinSeenAt = 0            // เวลาล่าสุดที่เซิร์ฟเวอร์ส่งหน้า PIN pad มา
  let pinClearedAt = 0         // เวลาที่เซิร์ฟเวอร์ปิดหน้า PIN (clear_dialog)
  let pinBlockedAt = 0         // เวลาล่าสุดที่เซิร์ฟเวอร์ตอบ "กรุณากรอกรหัส PIN ก่อนใช้งาน"
  let traceSeen = new Set()
  let dialogVariant = 0 // layout ของ payload ใน custom_click_action — จำข้ามการ reconnect (หมุนเมื่อเซิร์ฟเวอร์ decode ไม่ได้)
  let autoEatInterval = null
  const MAX_RECONNECT_ATTEMPTS = 100
  const BASE_RECONNECT_DELAY = 5000
  const MAX_RECONNECT_DELAY = 60000
  const STOPPED_STATES = new Set(['stopped', 'auth_failed', 'banned'])

  function cleanupBot() {
    if (autoEatInterval) { clearInterval(autoEatInterval); autoEatInterval = null }
    for (let i = 0; i < autoCmdTimers.length; i++) {
      try { clearTimeout(autoCmdTimers[i]) } catch {}
    }
    autoCmdTimers = []
    if (bot) {
      try {
        bot.removeAllListeners()
        if (bot._client && !bot._client.destroyed) {
          bot.quit()
        }
      } catch (err) {
        console.error(`[BOT ${state.id}] Cleanup error:`, err.message)
      }
      resetControls()
      bot = null
    }
  }

  function scheduleReconnect() {
    if (STOPPED_STATES.has(state.status) || reconnectTimeout) return
    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts),
      MAX_RECONNECT_DELAY
    )
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null
      reconnectAttempts++
      connect()
    }, delay)
    pushLog(state, `Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${reconnectAttempts + 1})`)
  }

  function runAutoCommands() {
    if (!state.autoCommands || state.autoCommands.length === 0) return
    for (let i = 0; i < state.autoCommands.length; i++) {
      const { delay, cmd } = state.autoCommands[i]
      if (!cmd || !cmd.trim()) continue
      const delayMs = Math.max(0, Number(delay) || 2000)
      const t = setTimeout(() => {
        if (bot && state.status === 'online') {
          bot.chat(cmd.trim())
          pushLog(state, `[AUTO] ${cmd.trim()}`)
        }
      }, delayMs)
      autoCmdTimers.push(t)
    }
  }

  function connect() {
    cleanupBot()
    if (state.status === 'starting') reconnectAttempts = 0

    state.status = 'connecting'
    state.connectedAt = null
    pushLog(state, 'Connecting...')

    // ✅ ข้อ 4: ใช้ serverConfig ปัจจุบัน
    const options = {
      host: serverConfig.host,
      port: serverConfig.port,
      username: state.originalUsername,
      version: serverConfig.version ? serverConfig.version : false,
      physicsEnabled: true,
      hideErrors: true
    }

    if (state.accountType === 'premium') {
      options.auth = 'microsoft'
    }

    try {
      bot = mineflayer.createBot(options)
      try { bot._client.setMaxListeners(100) } catch {}
      guardPacketHandlers(bot)
      traceOutbound(bot)
      dialogAttempts = 0
      dialogSeenPreSpawn = false
      pinRun = null
      pinLastDialog = null
      physTicks = 0
      outMoves = 0
      sentLoaded = false
      pullTimes = []; lastPullAt = 0; lastPullOut = 0; pullLogN = 0
      outSeen = {}; settingsAny = false
      tpConfirmed = new Set(); tpSeenIn = 0; tpForced = 0
      chunkBatchesIn = 0; chunkAcksOut = 0; chunkAcksForced = 0
      pongSent = new Set(); pongForced = 0
      tickEndOut = 0; tickEndForce = false; tickEndChecked = false; tickEndForced = 0
      walkDiagDone = false
      lastTickSeen = 0
      lastTickAt = Date.now()
      uiDialog = null
      pinBlockedAt = 0
      pinSeenAt = 0
      pinClearedAt = 0
      bot.on('windowOpen', (w) => { let t = ''; try { t = uiWinTitle(w) } catch {} pushLog(state, `[UI] เซิร์ฟเวอร์เปิดหน้าต่าง: ${t || w.type || '?'} — กดเองได้ที่แดชบอร์ด (Server UI)`) })
      bot.on('windowClose', () => pushLog(state, '[UI] หน้าต่างถูกปิด'))
      bot.on('physicsTick', () => {
        physTicks++
        try {
          const e = bot.entity
          if (e && e.position) {
            if (!e.onGround) groundFalse++
            lastGround = !!e.onGround
            lastVel = e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null
            lastPhys = { x: e.position.x, y: e.position.y, z: e.position.z }
          }
        } catch {}
        // ไคลเอนต์ 1.21.2+ ส่ง tick_end ท้ายทุก tick — ถ้า mineflayer ไม่ส่ง (ผ่านไป ~4 วิยังไม่มีเลย) เราส่งแทนหลังแพ็กเก็ตเดินของ tick นั้น
        try {
          const cl = bot._client
          if (!tickEndChecked && physTicks >= 80 && cl && cl.state === 'play') {
            tickEndChecked = true
            if (!tickEndOut && hasPacket('tick_end')) {
              tickEndForce = true
              pushLog(state, '[CTRL] 🔧 บอทไม่เคยส่ง tick_end (ไคลเอนต์จริงส่งทุก tick) — ส่งให้เองต่อจากนี้')
            }
          }
          if (tickEndForce && cl && cl.state === 'play') {
            setImmediate(() => { try { if (bot && bot._client === cl && cl.state === 'play') { cl.write('tick_end', {}); tickEndForced++ } } catch {} })
          }
        } catch {}
      })
      bot.on('forcedMove', () => {
        forcedMoves++
        const nowPull = Date.now()
        const dtPull = lastPullAt ? nowPull - lastPullAt : -1
        lastPullAt = nowPull
        pullTimes.push(nowPull)
        while (pullTimes.length && nowPull - pullTimes[0] > 10000) pullTimes.shift()
        const outSince = outMoves - lastPullOut
        lastPullOut = outMoves
        try { logPull(dtPull, outSince) } catch {}
        try { softenForcedMove() } catch {}
      })
      pushLog(state, '[BUILD] manual-control v2 (เดินเอง W A S D + คลิกขวา NPC เอง + จอพิกัด NPC · ส่ง teleport_confirm / chunk_batch_received / pong / tick_end / settings / player_loaded แทน mineflayer ถ้าขาด · log การถูกดึงกลับ + เวอร์ชัน/ความเร็วฟิสิกส์ตอนเริ่มเดิน)')
      traceSeen = new Set()
      setupDialogLogin(bot)
      setupAutoWalk(bot)
      setupResourcePack(bot)
    } catch (err) {
      state.status = 'error'
      pushLog(state, `[ERROR] Failed to create bot: ${err.message}`)
      scheduleReconnect()
      return
    }

    const connectionTimeout = setTimeout(() => {
      if (state.status === 'connecting' && dialogSeenPreSpawn && !connectionTimeout._extended) {
        connectionTimeout._extended = true
        pushLog(state, '[DIALOG] ยังรอ dialog ของเซิร์ฟเวอร์อยู่ — ขยายเวลารออีก 60 วินาที')
        connectionTimeout.refresh()
        return
      }
      if (state.status === 'connecting') {
        pushLog(state, 'Connection timed out after 30s' + (connectionTimeout._extended ? ' (+60s)' : ''))
        cleanupBot()
        state.status = 'error'
        scheduleReconnect()
      }
    }, 30000)

    let joined = false
    const onJoined = (viaFallback) => {
      if (joined) return
      joined = true
      clearTimeout(connectionTimeout)
      if (viaFallback) {
        pushLog(state, '[TRACE] ไม่ได้รับ event spawn แต่เซิร์ฟเวอร์ส่งข้อมูลโลกมาแล้ว — ถือว่าเข้าเซิร์ฟสำเร็จ (fallback)')
        sendPlayerLoadedIfMissing()
      }
      state.status = 'online'
      state.connectedAt = Date.now()
      reconnectAttempts = 0
      if (bot.username && bot.username !== state.username) {
        state.username = bot.username
      }
      pushLog(state, 'Connected successfully')

      if (autoEatInterval) clearInterval(autoEatInterval)
      autoEatInterval = setInterval(() => {
        tryAutoEat().catch(e => pushLog(state, `[AUTO-EAT] error: ${e.message}`))
      }, 4000)

      if (state.autoServerSelect) {
        const selectDelay = ((state.autoLogin && state.loginPassword) || (state.autoPin && state.loginPin)) ? 4500 : 2000
        const t = setTimeout(() => {
          if (bot && state.status === 'online') {
            joinServerSelector()
          }
        }, selectDelay)
        autoCmdTimers.push(t)
      }

      pushLog(state, '[CTRL] เดินเอง/คลิกขวาเอง ได้ที่แดชบอร์ด แท็บ Control (มีจอตำแหน่งตัวบอทและ NPC ใกล้ตัว)')

      setTimeout(() => {
        runAutoCommands()
      }, 2500)
    }
    bot.once('spawn', () => onJoined(false))

    // fallback: เข้า play state แล้วแต่ spawn ไม่ยิง (เกิดกับเวอร์ชันใหม่/เซิร์ฟที่ล็อกผู้เล่นไว้ที่หน้า login)
    // อย่าปล่อยให้ timeout 30s ตัดการเชื่อมต่อทิ้ง ไม่งั้นจะวนเข้า-ออกไม่จบและไม่เคยได้ตอบ dialog
    {
      const thisBot = bot
      let playSeen = false
      thisBot._client.on('packet', (d, m) => {
        if (playSeen || !m || m.state !== 'play') return
        playSeen = true
        const t = setTimeout(() => {
          if (bot === thisBot && state.status === 'connecting') onJoined(true)
        }, 8000)
        autoCmdTimers.push(t)
      })
    }

    bot.on('message', (jsonMsg) => {
      const msgText = stringifyMsg(jsonMsg)
      if (msgText && /กรุณากรอกรหัส\s*PIN|กรอกรหัส\s*PIN\s*ก่อน/i.test(msgText)) pinBlockedAt = Date.now()
      if (msgText && msgText !== state.lastMessage) {
        pushLog(state, msgText)
      }
    })

    bot.on('kicked', (reason) => {
      clearTimeout(connectionTimeout)
      const reasonStr = stringifyMsg(reason)
      if (reasonStr.toLowerCase().includes('ban')) {
        state.status = 'banned'
        pushLog(state, `BANNED: ${reasonStr}`)
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout)
          reconnectTimeout = null
        }
        return
      }
      state.status = 'kicked'
      pushLog(state, `KICKED: ${reasonStr}`)
      if (/custom_click_action/i.test(reasonStr) && /decode/i.test(reasonStr)) {
        const used = dialogVariant % CLICK_LAYOUTS.length
        dialogVariant++
        pushLog(state, `[DIALOG] server rejected layout #${used} (${CLICK_LAYOUTS[used]}) — next reconnect will try #${dialogVariant % CLICK_LAYOUTS.length} (${CLICK_LAYOUTS[dialogVariant % CLICK_LAYOUTS.length]})`)
      }
      if (/version|เวอร์ชัน|เวอร์ชั่น/i.test(reasonStr)) {
        pushLog(state, `[HINT] เซิร์ฟเวอร์ขอให้ใช้เวอร์ชันอื่น — ตั้งค่า Game Version ที่หน้า /config (ตอนนี้: ${serverConfig.version || 'auto'}) และต้องใช้ mineflayer ที่รองรับเวอร์ชันนั้น`)
      }
    })

    bot.on('error', (err) => {
      clearTimeout(connectionTimeout)
      const msg = err?.message || String(err)
      if (state.status === 'online' && /Serialization error|SizeOf error/i.test(msg)) { pushLog(state, `[ERROR] ${msg} (ข้าม ไม่ตัดการเชื่อมต่อ)`); return }
      if (msg.includes('profile') || msg.includes('auth') || msg.includes('token')) {
        state.status = 'auth_failed'
        pushLog(state, `[AUTH ERROR] ${msg}`)
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout)
          reconnectTimeout = null
        }
        return
      }
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT')) {
        state.status = 'connection_error'
        pushLog(state, `[CONNECTION] ${msg}`)
      } else {
        state.status = 'error'
        pushLog(state, `[ERROR] ${msg}`)
      }
      cleanupBot()
    })

    bot.on('end', (reason) => {
      clearTimeout(connectionTimeout)
      if (STOPPED_STATES.has(state.status)) return
      state.status = 'offline'
      pushLog(state, 'Disconnected. Reconnecting...')
      scheduleReconnect()
    })
  }

  /* ---- Server password dialog (Minecraft 1.21.6+ "Dialog" screen) ----
     Servers can pop up a native screen with a text box + buttons (this is what the
     "WELCOME TO ..." password screen is). The bot has no screen, so we read the
     show_dialog packet, fill the text input(s) with the saved password and
     "click" the confirm button by sending the same packet the real client would. */

  const NBT_TAGS = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'string', 'byteArray', 'intArray', 'longArray', 'list', 'compound'])

  function nbtToPlain(x) {
    if (x === null || x === undefined) return x
    if (Array.isArray(x)) return x.map(nbtToPlain)
    if (typeof x === 'object') {
      if (typeof x.type === 'string' && NBT_TAGS.has(x.type) && 'value' in x) {
        const v = x.value
        if (x.type === 'compound') {
          const o = {}
          const types = {}
          for (const k of Object.keys(v || {})) {
            o[k] = nbtToPlain(v[k])
            if (v[k] && typeof v[k].type === 'string') types[k] = v[k].type
          }
          // เก็บชนิดของ tag ไว้แบบไม่โผล่ใน JSON (ใช้ตอนส่งค่า additions กลับให้ตรงชนิดเดิม เช่น int array)
          Object.defineProperty(o, '__types', { value: types, enumerable: false })
          return o
        }
        if (x.type === 'list') {
          const items = v && Array.isArray(v.value) ? v.value : []
          return items.map(i => (v.type === 'compound' ? nbtToPlain({ type: 'compound', value: i }) : i))
        }
        if (Array.isArray(v)) {
          const arr = v.slice()
          Object.defineProperty(arr, '__nbt', { value: x.type, enumerable: false })
          return arr
        }
        return v
      }
      const o = {}
      for (const k of Object.keys(x)) o[k] = nbtToPlain(x[k])
      return o
    }
    return x
  }

  function textOf(c) {
    try {
      if (c === null || c === undefined) return ''
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.map(textOf).join('')
      return (c.text || c.translate || '') + (c.extra ? textOf(c.extra) : '')
    } catch { return '' }
  }

  function findDialogRoot(node) {
    // find the object that actually describes the dialog (has inputs/yes/action/actions)
    if (!node || typeof node !== 'object') return null
    if (node.inputs || node.yes || node.actions || (node.action && node.action.action) || node.type) {
      if (node.inputs || node.yes || node.actions || (node.action && node.action.action)) return node
    }
    for (const k of Object.keys(node)) {
      const r = findDialogRoot(node[k])
      if (r) return r
    }
    return null
  }

  function pickButton(dlg) {
    if (dlg.yes && dlg.yes.action) return dlg.yes                       // confirmation
    if (dlg.action && dlg.action.action) return dlg.action              // notice
    if (Array.isArray(dlg.actions) && dlg.actions.length) {             // multi_action
      return dlg.actions.find(a => a && a.action) || null
    }
    return null
  }

  function readVarInt(buf, pos) {
    let value = 0, shift = 0, len = 0
    for (;;) {
      const b = buf[pos + len]
      if (b === undefined) throw new Error('truncated varint')
      value |= (b & 0x7f) << shift
      len++
      if (!(b & 0x80)) break
      shift += 7
      if (shift > 35) throw new Error('varint too long')
    }
    return { value, len }
  }

  /* ---- custom_click_action (serverbound) ----
     สเปกจริง (vanilla 1.21.6+ / 26.x): Identifier + VarInt(ความยาว payload เป็นไบต์) + NBT แบบไม่มีชื่อ root
     ตัวอย่างไบต์: <id string> <varint len> 0x0A <entries...> 0x00
     ปัญหาเดิม: protocol definition ของ fork เขียน "0x01 + NBT" (option) โดยไม่มี length prefix
     → เซิร์ฟเวอร์อ่าน 0x01 เป็นความยาว payload = 1 ไบต์ แล้วอ่าน compound ไม่จบ
     → "Failed to decode packet 'serverbound/minecraft:custom_click_action'" (ตรงกับ log ทุกรอบ)
     และ log "payload layout already OK (marker byte 0x01)" ก็คือสัญญาณว่า fork เขียน layout ผิดนี้
     ทางแก้: ไม่พึ่ง serializer ของ fork ในส่วน payload — ดึงเฉพาะ packet-id + identifier จาก serializer
     (ได้ id ของ state ปัจจุบันถูกเสมอ) แล้วต่อ payload เองตาม layout ที่เลือก
     layout 0 = สเปก (length-prefixed NBT)  <- ค่าเริ่มต้น
     layout 1 = 0x01 + NBT (แบบเดิม)  layout 2 = NBT เปล่า
     ถ้าโดน kick ด้วย custom_click_action จะหมุนไป layout ถัดไปในการ reconnect รอบหน้า */

  const CLICK_LAYOUTS = ['length-prefixed NBT (spec)', '0x01 + NBT (legacy)', 'bare NBT']

  function writeVarInt(n) {
    const out = []
    n >>>= 0
    while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7 }
    out.push(n)
    return Buffer.from(out)
  }

  // NBT ใช้ "modified UTF-8" (NUL = C0 80, ตัวอักษรนอก BMP = surrogate คู่ละ 3 ไบต์)
  function mutf8(str) {
    const bytes = []
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i)
      if (ch >= 0x01 && ch <= 0x7f) bytes.push(ch)
      else if (ch === 0 || ch <= 0x7ff) bytes.push(0xc0 | (ch >> 6), 0x80 | (ch & 0x3f))
      else bytes.push(0xe0 | (ch >> 12), 0x80 | ((ch >> 6) & 0x3f), 0x80 | (ch & 0x3f))
    }
    return Buffer.from(bytes)
  }

  function nbtString(s) {
    const b = mutf8(String(s))
    if (b.length > 0xffff) throw new Error('NBT string too long')
    const len = Buffer.alloc(2)
    len.writeUInt16BE(b.length)
    return Buffer.concat([len, b])
  }

  const TAG_ID = { byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, byteArray: 7, string: 8, list: 9, compound: 10, intArray: 11, longArray: 12 }

  function i64(v) {
    const b = Buffer.alloc(8)
    if (Array.isArray(v)) { b.writeInt32BE(v[0] | 0, 0); b.writeInt32BE(v[1] | 0, 4) } else b.writeBigInt64BE(BigInt(v))
    return b
  }

  // plain value (+ชนิดเดิมถ้ารู้) -> {type, value} สำหรับ encoder
  function plainToField(v, tag) {
    if (!tag && Array.isArray(v) && v.__nbt) tag = v.__nbt
    if (!tag) {
      if (typeof v === 'string') tag = 'string'
      else if (typeof v === 'boolean') { tag = 'byte'; v = v ? 1 : 0 }
      else if (typeof v === 'number') tag = Number.isInteger(v) ? 'int' : 'double'
      else if (Array.isArray(v)) tag = 'intArray'
      else if (v && typeof v === 'object') tag = 'compound'
      else tag = 'string'
    }
    if (tag === 'compound') {
      const out = {}
      const types = (v && v.__types) || {}
      for (const k of Object.keys(v || {})) out[k] = plainToField(v[k], types[k])
      return { type: 'compound', value: out }
    }
    if (tag === 'list') throw new Error('list tag inside additions is not supported')
    return { type: tag, value: v }
  }

  function additionsToFields(add) {
    const fields = {}
    if (add && typeof add === 'object') {
      const types = add.__types || {}
      for (const k of Object.keys(add)) fields[k] = plainToField(add[k], types[k])
    }
    return fields
  }

  function encodeTagPayload(f) {
    switch (f.type) {
      case 'string': return nbtString(f.value)
      case 'byte': return Buffer.from([Number(f.value) & 0xff])
      case 'short': { const b = Buffer.alloc(2); b.writeInt16BE(Number(f.value) | 0); return b }
      case 'int': { const b = Buffer.alloc(4); b.writeInt32BE(Number(f.value) | 0); return b }
      case 'long': return i64(f.value)
      case 'float': { const b = Buffer.alloc(4); b.writeFloatBE(Number(f.value)); return b }
      case 'double': { const b = Buffer.alloc(8); b.writeDoubleBE(Number(f.value)); return b }
      case 'byteArray': { const a = f.value || []; const b = Buffer.alloc(4 + a.length); b.writeInt32BE(a.length, 0); a.forEach((x, i) => b.writeInt8(x, 4 + i)); return b }
      case 'intArray': { const a = f.value || []; const b = Buffer.alloc(4 + a.length * 4); b.writeInt32BE(a.length, 0); a.forEach((x, i) => b.writeInt32BE(x | 0, 4 + i * 4)); return b }
      case 'longArray': { const a = f.value || []; const h = Buffer.alloc(4); h.writeInt32BE(a.length, 0); return Buffer.concat([h, ...a.map(i64)]) }
      case 'compound': return encodeCompoundBody(f.value)
      default: throw new Error(`unsupported NBT type "${f.type}"`)
    }
  }

  function encodeCompoundBody(fields) {
    const parts = []
    for (const key of Object.keys(fields)) {
      const f = fields[key]
      const id = TAG_ID[f.type]
      if (!id) throw new Error(`unsupported NBT type "${f.type}" for key "${key}"`)
      parts.push(Buffer.from([id]), nbtString(key), encodeTagPayload(f))
    }
    parts.push(Buffer.from([0x00]))
    return Buffer.concat(parts)
  }

  // fields = { key: {type, value} } -> compound แบบ network NBT (ไม่มีชื่อ root)
  function encodeNbtCompound(fields) {
    return Buffer.concat([Buffer.from([0x0a]), encodeCompoundBody(fields)])
  }

  function buildClickPayload(nbt, layout) {
    if (layout === 1) return Buffer.concat([Buffer.from([0x01]), nbt])
    if (layout === 2) return nbt
    return Buffer.concat([writeVarInt(nbt.length), nbt])
  }

  function sendCustomClickAction(c, id, fields) {
    const packet = { name: 'custom_click_action', params: { id, nbt: { type: 'compound', name: '', value: {} } } }
    const canRaw = c.serializer && typeof c.serializer.createPacketBuffer === 'function' && typeof c.writeRaw === 'function'
    if (!canRaw) {
      c.write(packet.name, { id, nbt: { type: 'compound', name: '', value: fields } })
      pushLog(state, '[DIALOG] raw write unavailable — sent with the library serializer')
      return
    }
    let head
    try {
      const buf = c.serializer.createPacketBuffer(packet)
      const pid = readVarInt(buf, 0)
      const idLen = readVarInt(buf, pid.len)
      head = buf.subarray(0, pid.len + idLen.len + idLen.value) // packet id + identifier
    } catch (e) {
      pushLog(state, `[DIALOG] serialize failed (${e.message}) — falling back to library write`)
      c.write(packet.name, packet.params)
      return
    }
    const layout = dialogVariant % CLICK_LAYOUTS.length
    const payload = buildClickPayload(encodeNbtCompound(fields), layout)
    const outBuf = Buffer.concat([head, payload])
    c.writeRaw(outBuf)
    pushLog(state, `[DIALOG] payload layout #${layout}: ${CLICK_LAYOUTS[layout]}`)
    if (clickHexLogged < 3) { clickHexLogged++; pushLog(state, `[DIALOG] click bytes (${outBuf.length}B): ${outBuf.subarray(0, 96).toString('hex')}`) }
  }

  /* ---- PIN pad (dialog ที่เป็นปุ่มเลข 0-9 ไม่มีช่องพิมพ์) ---- */

  function collectButtons(dlg) {
    const out = []
    const add = (b, role) => { if (b && b.action && b.action.type) out.push({ role, label: textOf(b.label).replace(/§./g, '').trim(), action: b.action }) }
    add(dlg.yes, 'yes'); add(dlg.no, 'no'); add(dlg.action, 'action'); add(dlg.exit_action, 'exit')
    if (Array.isArray(dlg.actions)) dlg.actions.forEach(b => add(b, 'actions'))
    return out
  }

  function findPinPad(dlg) {
    const buttons = collectButtons(dlg)
    const byDigit = {}
    for (const b of buttons) if (/^[0-9]$/.test(b.label) && !byDigit[b.label]) byDigit[b.label] = b
    const ok = Object.keys(byDigit).length >= 9
    if (!ok) return null
    const clr = buttons.find(b => /ล้าง|clear|reset/i.test(b.label))
    if (clr) Object.defineProperty(byDigit, '__clear', { value: clr, enumerable: false })
    return byDigit
  }

  // อ่าน "จุด" แสดงจำนวนหลักที่กรอกแล้ว (เช่น ○ ○ ○ ○ -> ● ○ ○ ○). คืน null ถ้าอ่านไม่ได้
  function dotsText(plain) {
    try {
      const txt = collectTexts(plain, []).join('')
      const g = txt.match(/[\p{So}•◦·∘]/gu)
      return g ? g.join('') : ''
    } catch { return '' }
  }
  function parseDots(plain) {
    try {
      const txt = collectTexts(plain, []).join('')
      const g = txt.match(/[\p{So}•◦·∘]/gu)
      if (!g || g.length < 4 || g.length > 8) return null
      const distinct = new Set(g)
      if (distinct.size > 2) return null
      if (distinct.size === 1) return { total: g.length, filled: g[0] === pinDotEmpty ? 0 : g.length, text: g.join('') }
      if (!distinct.has(pinDotEmpty)) return null
      return { total: g.length, filled: g.filter(x => x !== pinDotEmpty).length, text: g.join('') }
    } catch { return null }
  }

  function pressButton(c, btn, values) {
    const act = btn.action
    const type = String(act.type || '').replace('minecraft:', '')
    if (type === 'dynamic/custom' || type === 'custom') {
      const fields = additionsToFields(act.additions)
      sendCustomClickAction(c, String(act.id), fields)
      return `custom_click_action id=${act.id}`
    }
    if (type === 'dynamic/run_command' || type === 'run_command') {
      let cmd = String(act.template || act.command || '').replace(/^\//, '')
      if (!bot) throw new Error('no bot')
      bot.chat('/' + cmd)
      return `command /${cmd.split(' ')[0]}`
    }
    throw new Error(`unsupported action ${type}`)
  }

  function collectTexts(node, out) {
    if (node === null || node === undefined) return out
    if (typeof node === 'string') return out
    if (Array.isArray(node)) { node.forEach(n => collectTexts(n, out)); return out }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (k === 'actions' || k === 'exit_action' || k === 'action' || k === 'yes' || k === 'no' || k === 'label' || k === 'tooltip') continue // ข้ามปุ่ม อ่านเฉพาะข้อความหัว/เนื้อหา
        if (k === 'text' && typeof node[k] === 'string') out.push(node[k])
        else collectTexts(node[k], out)
      }
    }
    return out
  }

  // อ่าน "เหลือโอกาสอีก N ครั้ง" จากข้อความใน dialog (null = อ่านไม่เจอ)
  function remainingAttempts(plain) {
    try {
      const txt = collectTexts(plain, []).join('')
      const m = txt.match(/เหลือโอกาสอีก\s*(\d+)/)
      return m ? Number(m[1]) : null
    } catch { return null }
  }

  // รอ dialog ใหม่ (Paper ส่งปุ่มชุดใหม่ id ใหม่มาทุกครั้ง — id เก่าใช้ซ้ำไม่ได้) สูงสุด ms
  function waitFresh(run, seqBefore, ms) {
    return new Promise(res => {
      if (run.seq > seqBefore || !run.active) return res(run.seq > seqBefore)
      const t = setTimeout(() => { run.wake = null; res(false) }, ms)
      run.wake = () => { clearTimeout(t); run.wake = null; res(true) }
    })
  }

  function finishEntry(run) {
    if (pinRun !== run || !run.settling) return
    run.settling = false
    const before = run.leftBefore
    const after = run.minLeft
    const counted = (before !== null && after !== null) ? (after < before) : null
    if (counted === true) {
      pinSubmits++
      if (run.verified) {
        pinWrong = true
        pushLog(state, `[PIN] ❌ เซิร์ฟเวอร์นับว่า PIN ผิด (เหลือ ${after} ครั้ง) ทั้งที่บอทกดครบทุกหลักและเซิร์ฟเวอร์ยืนยันทีละหลักแล้ว → PIN ที่บันทึกไว้ไม่ตรงกับของจริง หยุดไม่กดซ้ำ (แก้ PIN ใน Settings แล้วกด Save)`)
        return
      }
      pushLog(state, `[PIN] เซิร์ฟเวอร์นับว่าผิด (เหลือ ${after} ครั้ง) — ยังยืนยันการกดทีละหลักไม่ได้ จึงอาจกดผิดหลัก (รอบที่ ${pinSubmits}/2)`)
    } else if (counted === false) {
      pinSoftFails++
      pushLog(state, `[PIN] เซิร์ฟเวอร์ไม่นับรอบนี้ (ยังเหลือ ${after} ครั้ง) → คลิกไม่ครบ/ถูกรีเซ็ต ไม่เสียโอกาส (${pinSoftFails}/4) จะลองใหม่`)
    } else {
      pinSubmits++
      pushLog(state, `[PIN] อ่านจำนวนครั้งที่เหลือไม่ได้ — นับเป็น 1 รอบ (${pinSubmits}/2) เพื่อความปลอดภัย`)
    }
    const p = pinLastDialog
    if (p && bot) setTimeout(() => { try { if (bot) runPin(p.c, p.pad, p.stateName, p.plain) } catch {} }, 400)
  }

  function runPin(c, pad, stateName, plain) {
    if (Date.now() < pinManualUntil) return // ผู้ใช้กดเองอยู่ (หรือกดพักบอท) — ไม่กดอัตโนมัติ
    if (!state.autoPin) {
      pushLog(state, '[PIN] เซิร์ฟเวอร์ขอ PIN แต่ Auto PIN ปิดอยู่ — เปิดที่ Settings > Auto PIN')
      return
    }
    const pin = String(state.loginPin || '')
    if (!/^[0-9]{4,8}$/.test(pin)) {
      pushLog(state, '[PIN] เซิร์ฟเวอร์ขอ PIN แต่ยังไม่ได้ตั้ง PIN (ต้องเป็นตัวเลข 4-8 หลัก) — ใส่ที่ Settings > Auto PIN แล้วกด Save')
      return
    }
    const left = remainingAttempts(plain)
    const dots = parseDots(plain)
    pinLastDialog = { c, pad, stateName, plain, left, dots, at: Date.now() }

    // กำลังกดอยู่: ส่งปุ่มชุดใหม่ + จุดล่าสุดให้ลูปที่กำลังรอ
    if (pinRun && pinRun.active) {
      pinRun.pad = pad; pinRun.left = left; pinRun.dots = dots; pinRun.seq++
      if (pinRun.wake) pinRun.wake()
      return
    }
    // กดครบแล้ว กำลังรอผล: เก็บ "เหลือกี่ครั้ง" ที่ต่ำสุดที่เห็น
    if (pinRun && pinRun.settling) {
      if (left !== null) pinRun.minLeft = pinRun.minLeft === null ? left : Math.min(pinRun.minLeft, left)
      return
    }

    if (pinWrong) {
      pushLog(state, '[PIN] PIN ที่บันทึกไว้ถูกเซิร์ฟเวอร์ปฏิเสธแล้ว — ไม่กดซ้ำ (แก้ PIN ใน Settings แล้วกด Save)')
      return
    }
    if (left !== null) pushLog(state, `[PIN] เซิร์ฟเวอร์แจ้งว่าเหลือโอกาสอีก ${left} ครั้ง`)
    if (left !== null && left <= 2) {
      pushLog(state, `[PIN] เหลือโอกาสแค่ ${left} ครั้ง — บอทกดอัตโนมัติเฉพาะตอนเหลือ 3 ครั้งขึ้นไป เพื่อไม่ให้ถูกล็อก (ตรวจ PIN ให้แน่ใจแล้วกรอกเอง หรือ Save PIN ใหม่)`)
      return
    }
    if (pinSubmits >= 2) {
      pushLog(state, '[PIN] กรอก PIN ไปแล้ว 2 ครั้งแต่ยังไม่ผ่าน — หยุดเพื่อไม่ให้ถูกล็อก (เช็ค PIN แล้วกด Save ใหม่)')
      return
    }
    if (pinSoftFails >= 4) {
      pushLog(state, '[PIN] คลิกไม่ถูกรับ 4 รอบติด (เซิร์ฟเวอร์ไม่นับเลย) — หยุดแล้ว ส่ง log บรรทัด [PIN] จุด / [DIALOG] click bytes มาให้ดูต่อ')
      return
    }

    const run = {
      active: true, settling: false, pad, pin, wake: null, seq: 0,
      left, dots, leftBefore: left, minLeft: left, verified: true, startedAt: Date.now()
    }
    pinRun = run
    pushLog(state, `[PIN] เริ่มกด PIN ${pin.length} หลัก (state=${stateName}) จุดตอนนี้="${dots ? dots.text : dotsText(plain) || '?'}"`)
    if (!dots) pushLog(state, '[PIN] อ่านจุดแสดงหลักจาก dialog ไม่ได้ → ใช้โหมดกดแบบรอ dialog ใหม่ทุกหลัก (ไม่ยืนยันรายหลัก)')

    ;(async () => {
      // ถ้ามีเลขค้างอยู่ในช่องจากรอบก่อน ให้กด "ล้าง" ก่อน
      if (run.dots && run.dots.filled > 0 && run.pad.__clear) {
        const sb = run.seq
        try { pressButton(c, run.pad.__clear); pushLog(state, `[PIN] มีเลขค้าง ${run.dots.filled} หลัก — กด "ล้าง" ก่อน`) } catch (e) { pushLog(state, `[PIN] กดล้างไม่สำเร็จ: ${e.message}`) }
        await waitFresh(run, sb, 3000)
        await sleep(150)
      }
      let idx = 0
      let retries = 0
      while (run.active && bot && idx < pin.length) {
        const d = pin[idx]
        const btn = run.pad[d]
        if (!btn) { pushLog(state, `[PIN] ไม่พบปุ่มเลข ${d}`); run.active = false; return }
        const isLast = idx === pin.length - 1
        const seqBefore = run.seq
        const filledBefore = run.dots ? run.dots.filled : null
        try {
          const what = pressButton(c, btn)
          pushLog(state, `[PIN] กดหลักที่ ${idx + 1}/${pin.length} (${what})`)
        } catch (e) {
          pushLog(state, `[PIN] กดไม่สำเร็จ: ${e.message}`)
          run.active = false
          return
        }
        // รอ dialog ใหม่ก่อนกดหลักถัดไปเสมอ (ปุ่ม id เก่าอาจใช้ไม่ได้แล้ว)
        let got = await waitFresh(run, seqBefore, 3000)
        await sleep(150)
        if (!run.active) return // clear_dialog (ผ่าน) หรือถูกหยุด
        let filledAfter = run.dots ? run.dots.filled : null
        if (filledBefore !== null || filledAfter !== null) {
          pushLog(state, `[PIN] จุด ${filledBefore === null ? '?' : filledBefore} → ${filledAfter === null ? '?' : filledAfter} "${run.dots ? run.dots.text : ''}"${got ? '' : ' (ไม่มี dialog ตอบกลับใน 3 วิ)'}`)
        }
        if (isLast) {
          // หลักสุดท้าย: จุดอาจถูกรีเซ็ตเพราะเซิร์ฟเวอร์ตรวจแล้ว — ถ้าจุดยังค้างที่ n-1 แปลว่าคลิกไม่เข้า ลองใหม่ได้โดยไม่เสียโอกาส
          if (pinDotsProven && filledAfter === pin.length - 1 && retries < 3) {
            retries++
            pushLog(state, `[PIN] หลักสุดท้ายยังไม่เข้า (จุดค้าง ${filledAfter}) — กดซ้ำ (${retries}/3)`)
            continue
          }
          break
        }
        if (pinDotsProven && filledBefore !== null && filledAfter !== null) {
          if (filledAfter === filledBefore + 1) { idx++; retries = 0; continue }
          if (filledAfter === filledBefore) {
            // อาจเป็น dialog รีเฟรชที่มาก่อนคำตอบของคลิก — รออีกหนึ่งชุดก่อนตัดสินว่าคลิกไม่เข้า
            const sb2 = run.seq
            await waitFresh(run, sb2, 2500)
            await sleep(100)
            if (!run.active) return
            filledAfter = run.dots ? run.dots.filled : null
            if (filledAfter === filledBefore + 1) { idx++; retries = 0; continue }
            if (filledAfter === filledBefore && retries < 3) {
              retries++
              run.verified = false
              pushLog(state, `[PIN] คลิกหลักที่ ${idx + 1} ไม่เข้า (จุดไม่เพิ่ม) — กดซ้ำด้วยปุ่มชุดล่าสุด (${retries}/3)`)
              continue
            }
            if (filledAfter === filledBefore) { pushLog(state, '[PIN] คลิกไม่เข้า 3 ครั้งติด — หยุดรอบนี้ (ยังไม่ได้ส่งครบ 4 หลัก จึงไม่เสียโอกาส)'); run.active = false; pinSoftFails++; return }
          }
          if (filledAfter === 0 && filledBefore > 0) {
            pushLog(state, '[PIN] เซิร์ฟเวอร์รีเซ็ตช่อง PIN (น่าจะรีเฟรชหน้า) — เริ่มกดหลักแรกใหม่')
            run.verified = false
            idx = 0; retries = 0
            continue
          }
          if (filledAfter !== null && filledAfter >= 0 && filledAfter < pin.length) {
            pushLog(state, `[PIN] จุดไม่ตรงที่คาด (${filledAfter}) — ปรับตำแหน่งตามเซิร์ฟเวอร์`)
            run.verified = false
            idx = filledAfter; continue
          }
        }
        // ยังไม่เคยพิสูจน์ว่าจุดขยับตามการกด: เรียนรู้จากหลักแรก
        if (!pinDotsProven && filledBefore !== null && filledAfter !== null) {
          if (filledAfter === filledBefore + 1) { pinDotsProven = true; pushLog(state, '[PIN] ยืนยันแล้วว่าจุดขยับตามการกด — จะตรวจทีละหลักตั้งแต่นี้') }
          else run.verified = false
        } else if (!pinDotsProven) {
          run.verified = false
        }
        idx++
      }
      if (run.active && idx >= pin.length) {
        run.active = false
        run.settling = true
        run.minLeft = run.left
        pushLog(state, `[PIN] กดครบ ${pin.length} หลักแล้ว — รอผลจากเซิร์ฟเวอร์`)
        setTimeout(() => finishEntry(run), 2200)
      }
    })().catch(e => { run.active = false; pushLog(state, `[PIN] error: ${e.message}`) })
  }

  function handleDialog(c, data, stateName) {
    dialogSeenPreSpawn = true
    const plain = nbtToPlain(data && data.dialog !== undefined ? data.dialog : data)
    let dump = ''
    try { dump = JSON.stringify(plain) } catch { dump = String(plain) }
    pushLog(state, `[DIALOG] (${stateName}) ${dump.length > 700 ? dump.slice(0, 700) + '…' : dump}`)

    const dlg = findDialogRoot(plain)
    if (!dlg) {
      pushLog(state, '[DIALOG] Could not find inputs/buttons in this dialog (it may be a registry reference). Copy the [DIALOG] line above so the code can be adapted.')
      return
    }
    try { uiDialog = buildUiDialog(c, stateName, dlg, plain) } catch (e) { pushLog(state, `[UI] อ่าน dialog ไม่ได้: ${e.message}`) }
    const pad = findPinPad(dlg)
    if (pad) { pinSeenAt = Date.now(); runPin(c, pad, stateName, plain); return }
    if (!state.autoLogin || !state.loginPassword) {
      pushLog(state, '[DIALOG] Server opened a dialog but Server Login is off / no password saved (Settings tab).')
      return
    }
    if (dialogAttempts >= 3) {
      pushLog(state, '[DIALOG] Already tried 3 times on this connection — not trying again (wrong password?).')
      return
    }
    if (collectButtons(dlg).length > 1 && !(Array.isArray(dlg.inputs) && dlg.inputs.length) && !dlg.yes) {
      pushLog(state, '[DIALOG] dialog นี้มีหลายปุ่มแต่ไม่ใช่ช่องรหัสหรือปุ่ม PIN 0-9 — ไม่กดมั่ว (ส่งบรรทัด [DIALOG] ด้านบนมาให้ปรับโค้ด)')
      return
    }
    dialogAttempts++

    // fill inputs: text boxes get the password, others keep their default
    const values = {}
    for (const inp of (Array.isArray(dlg.inputs) ? dlg.inputs : [])) {
      if (!inp || !inp.key) continue
      const t = String(inp.type || '').replace('minecraft:', '')
      if (t === 'text') values[inp.key] = state.loginPassword
      else if (inp.initial !== undefined) values[inp.key] = inp.initial
    }

    const btn = pickButton(dlg)
    if (!btn) { pushLog(state, '[DIALOG] No clickable button found in this dialog.'); return }
    const act = btn.action
    const type = String(act.type || '').replace('minecraft:', '')
    const label = textOf(btn.label)
    pushLog(state, `[DIALOG] Pressing button "${label}" (action: ${type})`)

    try {
      if (type === 'dynamic/run_command' || type === 'run_command') {
        let cmd = String(act.template || act.command || '')
        cmd = cmd.replace(/\$\(([^)]+)\)/g, (_, k) => (values[k] !== undefined ? String(values[k]) : ''))
        cmd = cmd.replace(/^\//, '')
        if (stateName !== 'play') { pushLog(state, '[DIALOG] run_command action cannot be sent before joining the world.'); return }
        bot.chat('/' + cmd)
        pushLog(state, `[DIALOG] Sent command: /${cmd.split(' ')[0]} ****`)
      } else if (type === 'dynamic/custom' || type === 'custom') {
        // vanilla: payload = additions (ชนิดเดิม) + one entry per input key
        const fields = additionsToFields(act.additions)
        for (const k of Object.keys(values)) {
          const v = values[k]
          fields[k] = typeof v === 'boolean' ? { type: 'byte', value: v ? 1 : 0 }
            : typeof v === 'number' ? { type: 'float', value: v } : { type: 'string', value: String(v) }
        }
        sendCustomClickAction(c, String(act.id), fields)
        pushLog(state, `[DIALOG] Sent custom_click_action id=${act.id}`)
      } else {
        pushLog(state, `[DIALOG] Unsupported button action "${type}" — send the [DIALOG] line so support can be added.`)
      }
    } catch (e) {
      pushLog(state, `[DIALOG] Failed to answer dialog: ${e.message}`)
    }
  }

  /* ---- กัน handler ของ mineflayer พังแล้วลาก stream แพ็กเก็ตตายทั้งก้อน ----
     เคสจริง: เซิร์ฟเวอร์ส่งแพ็กเก็ต teams (scoreboard team "CMINP0" ...) มาตอนเข้าโลก
     mineflayer/team.js เรียก ChatMessage.fromNotch(undefined) -> TypeError ใน listener
     exception หลุดขึ้นไปที่ parser ของ minecraft-protocol (log "problem inflating chunk")
     แพ็กเก็ตที่ตามมา (position/health/show_dialog) ไม่ถูกประมวลผลอีกเลย -> ไม่ spawn -> timeout 30s
     ทางแก้: ครอบ emit ของ client ด้วย try/catch แล้วข้ามเฉพาะ handler ที่พัง */
  function guardPacketHandlers(b) {
    const c = b && b._client
    if (!c || c.__guarded) return
    c.__guarded = true
    const origEmit = c.emit
    const warned = new Set()
    c.emit = function (ev, ...args) {
      try {
        return origEmit.call(this, ev, ...args)
      } catch (e) {
        const k = String(ev)
        if (!warned.has(k) && warned.size < 25) {
          warned.add(k)
          pushLog(state, `[TRACE] ข้าม error ใน handler ของ "${k}": ${e && e.message}`)
        }
        return false
      }
    }
  }

  /* ---- ดูว่าบอท "ส่งอะไรออกไป" ตอนเซิร์ฟสั่งกลับเข้า configuration (หน้า PIN ใช้ช่วงนี้) ----
     log: [TRACE] -> <state>/<packet> และไบต์แรกของแพ็กเก็ตที่ส่งนอก play state
     + หยุดฟิสิกส์ของ mineflayer ระหว่างอยู่ใน configuration และไม่ปล่อยแพ็กเก็ตของ play (ขยับ/แชท ฯลฯ) ออกไปผิด state */
  const PLAY_ONLY_OUT = new Set(['position', 'position_look', 'look', 'flying', 'arm_animation', 'entity_action', 'held_item_slot',
    'block_dig', 'block_place', 'use_item', 'use_entity', 'teleport_confirm', 'chunk_batch_received', 'player_loaded', 'tick_end',
    'chat', 'chat_message', 'chat_command', 'chat_command_signed', 'window_click', 'close_window', 'steer_vehicle', 'vehicle_move',
    'abilities', 'client_command', 'set_creative_slot', 'spectate', 'pick_item', 'message_acknowledgement'])

  function traceOutbound(b) {
    const c = b && b._client
    if (!c || c.__outTrace) return
    c.__outTrace = true
    const seen = new Set()
    let hexLogged = 0
    const origWrite = c.write
    c.write = function (name, params) {
      if (name === 'settings' || name === 'client_information') settingsAny = true
      if (this.state === 'play') {
        if (name === 'position' || name === 'position_look' || name === 'look' || name === 'flying') outMoves++
        else if (name === 'player_loaded') sentLoaded = true
        outSeen[name] = (outSeen[name] || 0) + 1
        if (name === 'teleport_confirm' || name === 'accept_teleportation') {
          if (params && params.teleportId !== undefined) { if (tpConfirmed.size > 500) tpConfirmed.clear(); tpConfirmed.add(String(params.teleportId)) }
        } else if (name === 'chunk_batch_received') chunkAcksOut++
        else if (name === 'pong') { if (params && params.id !== undefined) { if (pongSent.size > 500) pongSent.clear(); pongSent.add(String(params.id)) } }
        else if (name === 'tick_end') tickEndOut++
      }
      if (this.state !== 'play' && PLAY_ONLY_OUT.has(name)) {
        if (!seen.has('drop:' + name) && seen.size < 80) {
          seen.add('drop:' + name)
          pushLog(state, `[TRACE] ไม่ส่ง "${name}" เพราะตอนนี้อยู่ใน state ${this.state}`)
        }
        return
      }
      if ((this.state !== 'play' || name === 'configuration_acknowledged') && seen.size < 80) {
        const k = this.state + ':' + name
        if (!seen.has(k)) { seen.add(k); pushLog(state, `[TRACE] -> ${this.state}/${name}`) }
      }
      return origWrite.call(this, name, params)
    }
    const hookSerializer = () => {
      try {
        const ser = c.serializer
        if (!ser || ser.__hexHook) return
        ser.__hexHook = true
        ser.on('data', (buf) => {
          if (c.state !== 'play' && hexLogged < 25 && Buffer.isBuffer(buf)) {
            hexLogged++
            pushLog(state, `[TRACE] bytes(${c.state}) len=${buf.length} ${buf.subarray(0, 20).toString('hex')}`)
          }
        })
      } catch {}
    }
    hookSerializer()
    c.on('state', (ns) => {
      hookSerializer()
      try {
        if (ns === 'configuration') { b.clearControlStates && b.clearControlStates(); b.physicsEnabled = false }
        else if (ns === 'play') { b.physicsEnabled = true; schedulePlayEntryChecks() }
      } catch {}
    })
  }

  function setupDialogLogin(b) {
    const c = b && b._client
    if (!c) return
    c.on('state', (ns, old) => pushLog(state, `[TRACE] state ${old} -> ${ns}`))
    c.on('packet', (data, meta) => {
      if (!meta) return
      // log ชื่อ packet ที่เจอครั้งแรกในแต่ละ state (ช่วยดูว่าค้างตรงไหนถ้าไม่ spawn)
      const key = meta.state + ':' + meta.name
      if (!traceSeen.has(key) && traceSeen.size < 150) {
        traceSeen.add(key)
        pushLog(state, `[TRACE] <- ${meta.state}/${meta.name}`)
      }
      if (/resource_pack|cookie_request|transfer/i.test(meta.name) && !traceSeen.has('x' + key)) {
        traceSeen.add('x' + key)
        let d = ''; try { d = JSON.stringify(data).slice(0, 300) } catch {}
        pushLog(state, `[TRACE] ${meta.state}/${meta.name} ${d}`)
      }
      if (meta.state === 'play') { try { watchInbound(c, data, meta) } catch {} }
      if (meta.name === 'show_dialog') {
        try { handleDialog(c, data, meta.state) } catch (e) { pushLog(state, `[DIALOG] error: ${e.message}`) }
      } else if (meta.name === 'clear_dialog') {
        pushLog(state, '[DIALOG] server closed the dialog')
        pushLog(state, '[PIN] เซิร์ฟเวอร์ปิดหน้า PIN — ยังยืนยันไม่ได้ว่าผ่าน (ถ้าแชทยังบอก "กรุณากรอกรหัส PIN" = ยังไม่ผ่าน; ถ้ามีหน้าต่างเปิดตามมาให้ดู Server UI ในแดชบอร์ด)')
        if (uiDialog) uiDialog.closedAt = Date.now() // ค้างโชว์สั้น ๆ (ดู uiState) — ไม่ให้แผงหายวับ
        if (pinSeenAt) pinClearedAt = Date.now()
        pinManualUntil = 0
        if (pinRun) { pinRun.active = false; pinRun.settling = false; if (pinRun.wake) pinRun.wake() }
        pinSubmits = 0
        pinCooldownUntil = 0
        pinLatest = null
        pinSoftFails = 0
        pinWrong = false
        pinLastDialog = null
      }
    })
    c.on('error', (e) => pushLog(state, `[TRACE] client error: ${e && e.message}`))
    c.on('end', (r) => pushLog(state, `[TRACE] socket ended: ${r || ''}`))
  }

  /* ---- Auto server-select (right-click item, then click a slot in the menu) ---- */

  function waitForWindow(timeoutMs) {
    return new Promise((resolve) => {
      if (bot.currentWindow) return resolve(bot.currentWindow)
      const onOpen = (win) => { cleanup(); resolve(win) }
      const timer = setTimeout(() => { cleanup(); resolve(null) }, timeoutMs)
      function cleanup() { clearTimeout(timer); bot.removeListener('windowOpen', onOpen) }
      bot.once('windowOpen', onOpen)
    })
  }

  async function joinServerSelector() {
    if (!bot) return
    const heldItem = bot.heldItem
    pushLog(state, `[AUTO] Held item: ${heldItem ? heldItem.name : '(empty hand)'}`)
    const wanted = (state.serverSelectItem || 'grass_block').toLowerCase().trim()
    const MAX_ATTEMPTS = 4
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (!bot || state.status !== 'online') return
      try {
        pushLog(state, `[AUTO] Right-clicking to open server selector... (try ${attempt}/${MAX_ATTEMPTS})`)
        bot.activateItem()
        const win = await waitForWindow(6000)
        if (!win) {
          pushLog(state, '[AUTO] No menu opened yet, retrying...')
          await sleep(2000)
          continue
        }
        await sleep(600)
        const target = win.slots.find(s => s && s.name && s.name.toLowerCase().includes(wanted))
        if (!target) {
          const seen = win.slots.filter(s => s).map(s => s.name).join(', ') || '(empty)'
          pushLog(state, `[AUTO] Menu opened but "${wanted}" not found. Slots seen: ${seen}`)
          try { bot.closeWindow(win) } catch {}
          return
        }
        await bot.clickWindow(target.slot, 0, 0)
        pushLog(state, `[AUTO] Selected server (clicked ${target.name})`)
        return
      } catch (e) {
        pushLog(state, `[AUTO] Attempt ${attempt} failed: ${e.message}`)
        await sleep(2000)
      }
    }
    pushLog(state, '[AUTO] Server selector menu did not open after several tries. Check the item name in Settings, or the bot may not have received the menu item yet.')
  }

  /* ===========================
     MANUAL CONTROL — บังคับเอง (ระบบเดินไปพิกัด/วาป/คลิก NPC อัตโนมัติ + Auto-run ถูกรื้อออกทั้งหมดแล้ว)
       - เดิน: แดชบอร์ดส่งชุดปุ่มที่กดค้างอยู่มาเป็นระยะ (manualMove) — เงียบเกิน MOVE_DEADMAN_MS = ปล่อยปุ่มเอง
       - หัน / คลิกขวา NPC / คลิกขวาของในมือ: manualLook / manualInteract / manualUse
       - จอตำแหน่ง: controlState() ส่งพิกัด+ทิศของบอทและ entity ใกล้ตัวให้แท็บ Control
  =========================== */

  const NPC_SKIP = /^(item|item_entity|experience_orb|arrow|spectral_arrow|trident|text_display|item_display|block_display|interaction|marker|armor_stand|area_effect_cloud|lightning_bolt|ender_pearl|snowball|egg|firework_rocket|fishing_bobber|falling_block)$/i
  const D2R = Math.PI / 180
  let lastTickSeen = 0
  let lastTickAt = Date.now()
  let lastKick = 0
  const withTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)])
  const numOrNull = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v)
  const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
  function setCtl(k, on) { try { if (bot) bot.setControlState(k, on) } catch {} }
  function releaseAllKeys() { ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].forEach(k => setCtl(k, false)) }
  let moveTimer = null
  let moveBeat = 0
  const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump']
  const MOVE_DEADMAN_MS = 1200

  function stopMoveTimer() { if (moveTimer) { clearInterval(moveTimer); moveTimer = null } }

  // บอทถูกทิ้งแล้ว (cleanupBot): หยุดตัวจับเวลา ไม่แตะตัวบอท
  function resetControls() {
    stopMoveTimer()
  }

  // คืนข้อความเหตุผลถ้ายังควบคุมไม่ได้ (null = พร้อม)
  function controlReady() {
    if (!bot || state.status !== 'online') return 'บอทยังไม่ออนไลน์'
    if (!bot.entity || !bot.entity.position) return 'บอทยังไม่ได้ spawn (รอเซิร์ฟเวอร์ส่งตำแหน่งมา)'
    const c = bot._client
    if (c && c.state && c.state !== 'play') return `เซิร์ฟเวอร์อยู่ในหน้า "${c.state}" (หน้า PIN / ตั้งค่า) — ยังเดินไม่ได้ ใส่ PIN ให้เสร็จก่อน`
    return null
  }

  // physics loop ของ mineflayer บางเวอร์ชันใหม่ไม่เริ่มเอง (spawn ไม่ยิง) -> ไม่มี tick = สั่งเดินแล้วไม่ขยับ
  function ensurePhysics() {
    if (!bot) return
    if (!bot.physicsEnabled) bot.physicsEnabled = true
    const now = Date.now()
    if (physTicks !== lastTickSeen) { lastTickSeen = physTicks; lastTickAt = now; return }
    if (now - lastTickAt > 1500 && now - lastKick > 5000) {
      lastKick = now
      pushLog(state, '[CTRL] ⚠️ physics loop ไม่ทำงาน (ไม่มี tick) — กระตุ้นด้วย spawn event')
      try { bot.emit('spawn') } catch {}
      bot.physicsEnabled = true
    }
  }

  // mineflayer (physics.js) ตั้ง onGround=false และล้างความเร็วทุกครั้งที่ได้ position packet จากเซิร์ฟเวอร์
  // แม้เซิร์ฟเวอร์แค่ "ซิงก์" ตำแหน่งเดิมของบอท → pathfinder เห็นบอท "ลอย" 1 tick ต่อการแก้ 1 ครั้ง
  // (กระโดดไม่ได้ ความเร็วหาย จุดเริ่ม A* เพี้ยน) ถ้าแก้แค่นิดเดียวและใต้เท้ายังเป็นบล็อกตัน ให้ฟื้นค่าเดิม
  // เทเลพอร์ตจริง (ไกล/สูงต่างกัน) ปล่อยตามเซิร์ฟเวอร์ — physics tick ถัดไปคำนวณ onGround ใหม่เองอยู่แล้ว
  function softenForcedMove() {
    if (!bot || !bot.entity || !bot.entity.position || !lastPhys || !lastGround) return
    const e = bot.entity, o = lastPhys
    if (Math.hypot(e.position.x - o.x, e.position.z - o.z) > 0.6 || Math.abs(e.position.y - o.y) > 0.1) return
    const below = bot.blockAt(e.position.offset(0, -0.05, 0))
    if (!below || below.boundingBox !== 'block') return
    e.onGround = true
    // ต้องคืน vel.y ด้วย: prismarine-physics ตัดสิน onGround จาก "เคลื่อนลงแล้วชนพื้น" — vel.y ถูกล้างเป็น 0 → tick ถัดไปไม่ได้เคลื่อนลง → onGround=false อยู่ดี
    if (lastVel && e.velocity) { e.velocity.x = lastVel.x; e.velocity.y = lastVel.y; e.velocity.z = lastVel.z }
    softFixes++
  }

  function toServerTypes() {
    return bot && bot.registry && bot.registry.protocol && bot.registry.protocol.play && bot.registry.protocol.play.toServer && bot.registry.protocol.play.toServer.types
  }
  function hasPacket(n) { const t = toServerTypes(); return !!(t && t['packet_' + n]) }
  function firstPacket(names) { return names.find(hasPacket) }
  const pullsRecent = (ms) => { const n = Date.now(); return pullTimes.filter(t => n - t <= ms).length }

  // log การถูกเซิร์ฟเวอร์ดึงตำแหน่งกลับ — เฉพาะตอนกำลังเดินเอง (สูงสุด 12 ครั้งต่อการกดเดิน 1 รอบ)
  function logPull(dtPull, outSince) {
    if (pullLogN >= 12 || !bot || !bot.entity || !moveBeat || Date.now() - moveBeat > 4000) return
    pullLogN++
    const n = bot.entity.position, o = lastPhys
    const dxz = o ? Math.hypot(n.x - o.x, n.z - o.z) : 0
    const dy = o ? n.y - o.y : 0
    let hint = ''
    if (o) hint = (dxz < 0.05 && Math.abs(dy) < 0.05) ? ' · ตำแหน่งเดิมซ้ำ' : dxz < 0.8 ? ' · ดึงสั้น ๆ (ความเร็ว/สถานะวิ่งของบอทไม่ตรงเซิร์ฟเวอร์ หรือเซิร์ฟเวอร์จำกัดการเดิน)' : ' · ดึงไกล'
    pushLog(state, `[CTRL] 🔎 ถูกดึงกลับ #${pullLogN}: บอทคิดว่าอยู่ ${o ? fmt3(o) : '?'} → เซิร์ฟเวอร์สั่ง ${fmt3(n)}${o ? ' (ห่าง ' + dxz.toFixed(2) + ' · สูงต่าง ' + dy.toFixed(2) + ')' : ''} · ห่างครั้งก่อน ${dtPull < 0 ? '-' : dtPull + 'ms'} · บอทส่งแพ็กเก็ตเดิน +${outSince} · 10 วิล่าสุด ${pullTimes.length} ครั้ง${hint}`)
  }
  const fmt3 = (p) => `${(+p.x).toFixed(2)} ${(+p.y).toFixed(2)} ${(+p.z).toFixed(2)}`

  // ตอนเข้า play state (รวมรอบที่กลับมาจาก configuration หลัง PIN): ไคลเอนต์จริงส่ง player_loaded / settings ทุกครั้ง
  function schedulePlayEntryChecks() {
    const b = bot
    const token = ++entryToken
    sentLoaded = false
    setTimeout(() => { try { ensureEntryPackets(b, token) } catch (e) { pushLog(state, `[CTRL] ตรวจแพ็กเก็ตตอนเข้าโลกไม่สำเร็จ: ${e.message}`) } }, 2500)
  }
  function ensureEntryPackets(b, token) {
    if (!bot || b !== bot || token !== entryToken) return
    const c = bot._client
    if (!c || c.state !== 'play') return
    const fixed = []
    if (!sentLoaded && hasPacket('player_loaded')) { sendPlayerLoadedIfMissing(); fixed.push('player_loaded') }
    if (!settingsAny && (hasPacket('settings') || hasPacket('client_information'))) {
      try { bot.setSettings({}); fixed.push('settings') } catch (e) { pushLog(state, `[CTRL] ส่ง settings ไม่สำเร็จ: ${e.message}`) }
    }
    if (fixed.length) pushLog(state, `[CTRL] 🔧 เข้าโลกแล้วบอทยังไม่ได้ส่ง ${fixed.join(', ')} — ส่งให้เอง`)
  }

  // ดูแพ็กเก็ตขาเข้าที่ "ต้องตอบ" แล้วเช็คว่า mineflayer ตอบจริงไหม (handler ของ mineflayer อาจพังเงียบ ๆ เพราะ guardPacketHandlers กลืน error)
  // ถ้าไม่ตอบภายใน 120ms เราตอบแทน — ถ้า mineflayer ตอบแล้วจะไม่ส่งซ้ำ
  function watchInbound(c, data, meta) {
    const n = meta.name
    const alive = () => bot && bot._client === c && c.state === 'play'
    if (data && data.teleportId !== undefined && /^(position|player_position|position_look|sync_player_position)$/.test(n)) {
      const id = String(data.teleportId)
      tpSeenIn++
      setTimeout(() => {
        if (!alive() || tpConfirmed.has(id)) return
        const out = firstPacket(['teleport_confirm', 'accept_teleportation'])
        if (!out) return
        try {
          c.write(out, { teleportId: data.teleportId })
          tpForced++
          if (tpForced <= 5) pushLog(state, `[CTRL] 🔧 mineflayer ไม่ได้ตอบ teleport #${id} — ส่ง ${out} แทน (ครั้งที่ ${tpForced})`)
        } catch (e) { pushLog(state, `[CTRL] ส่ง ${out} ไม่สำเร็จ: ${e.message}`) }
      }, 120)
    } else if (n === 'chunk_batch_finished') {
      const want = ++chunkBatchesIn
      setTimeout(() => {
        if (!alive() || chunkAcksOut >= want || !hasPacket('chunk_batch_received')) return
        try {
          c.write('chunk_batch_received', { chunksPerTick: 20 })
          chunkAcksForced++
          if (chunkAcksForced <= 3) pushLog(state, `[CTRL] 🔧 mineflayer ไม่ได้ตอบ chunk batch — ส่ง chunk_batch_received แทน (ครั้งที่ ${chunkAcksForced})`)
        } catch (e) { pushLog(state, `[CTRL] ส่ง chunk_batch_received ไม่สำเร็จ: ${e.message}`) }
      }, 120)
    } else if (n === 'ping' && data && data.id !== undefined) {
      const id = String(data.id)
      setTimeout(() => {
        if (!alive() || pongSent.has(id) || !hasPacket('pong')) return
        try {
          c.write('pong', { id: data.id })
          pongForced++
          if (pongForced <= 3) pushLog(state, `[CTRL] 🔧 ไม่มีใครตอบ ping #${id} — ส่ง pong แทน (ครั้งที่ ${pongForced})`)
        } catch (e) { pushLog(state, `[CTRL] ส่ง pong ไม่สำเร็จ: ${e.message}`) }
      }, 120)
    }
  }

  // รายงานครั้งเดียวหลังเริ่มเดินครั้งแรก (รอ 2.5 วิให้แพ็กเก็ตเดินถูกส่งก่อน): เวอร์ชัน/ความเร็ว/แพ็กเก็ตที่ขาด
  function walkDiag(b) {
    if (!bot || b !== bot) return
    const L = (m) => pushLog(state, '[CTRL] 🔎 ' + m)
    let rv = '?', proto = '?'
    try { rv = bot.registry.version.minecraftVersion || bot.registry.version.version || '?'; proto = bot.registry.version.version !== undefined ? bot.registry.version.version : '?' } catch {}
    const cfg = serverConfig.version || '(อัตโนมัติ)'
    L(`เวอร์ชัน: bot.version=${bot.version} · registry=${rv} · protocol=${proto} · ตั้งค่าไว้=${cfg}`)
    if (serverConfig.version && String(bot.version) !== String(serverConfig.version)) L(`⚠️ เวอร์ชันที่ใช้จริงไม่ตรงกับที่ตั้งไว้ — ฟิสิกส์อาจไม่ตรงเซิร์ฟเวอร์`)
    let spd = ''
    try {
      const at = bot.entity.attributes || {}
      const k = Object.keys(at).find(x => /movement_speed/i.test(x))
      spd = k ? `${k}=${at[k].value}` : `ไม่พบ attribute movement_speed (มี ${Object.keys(at).length} ตัว) — ฟิสิกส์ใช้ความเร็วเริ่มต้น อาจไม่ตรงเซิร์ฟเวอร์`
    } catch { spd = '?' }
    L(`ความเร็ว: ${spd}`)
    L('แพ็กเก็ตที่บอทส่ง (play): ' + (Object.keys(outSeen).map(k => `${k}×${outSeen[k]}`).join(' ').slice(0, 600) || '(ไม่มีเลย)'))
    const cand = ['teleport_confirm', 'player_loaded', 'tick_end', 'player_input', 'player_command', 'entity_action', 'chunk_batch_received', 'pong']
    const never = cand.filter(n => hasPacket(n) && !outSeen[n])
    if (!settingsAny && (hasPacket('settings') || hasPacket('client_information'))) never.push('settings')
    L('โปรโตคอลมีแต่บอทยังไม่เคยส่ง: ' + (never.join(', ') || '(ไม่มี)') + ' — บางตัวส่งเฉพาะตอนมีเหตุการณ์ (เช่น teleport_confirm/pong/player_command) ไม่ได้แปลว่าผิดเสมอไป')
    L(`ตอบแทนเซิร์ฟเวอร์: teleport ${tpSeenIn} ครั้ง (เราตอบแทน ${tpForced}) · chunk batch ${chunkBatchesIn} (แทน ${chunkAcksForced}) · tick_end ที่บอทส่ง ${tickEndOut} (แทน ${tickEndForced}) · pong แทน ${pongForced}`)
  }

  // 1.21.4+: เซิร์ฟเวอร์ไม่รับการโต้ตอบ (คลิก NPC/บล็อก) จนกว่าไคลเอนต์จะส่ง player_loaded — mineflayer ส่งตอนได้ update_health
  // ถ้า event spawn ไม่ยิง (fallback) แพ็กเก็ตนี้จึงไม่ถูกส่ง ส่งเองให้เฉพาะเมื่อโปรโตคอลมีแพ็กเก็ตนี้จริงและยังไม่เคยส่ง
  function sendPlayerLoadedIfMissing() {
    try {
      if (!bot || sentLoaded) return
      const types = bot.registry && bot.registry.protocol && bot.registry.protocol.play && bot.registry.protocol.play.toServer && bot.registry.protocol.play.toServer.types
      if (!types || !types.packet_player_loaded) return
      bot._client.write('player_loaded', {})
      pushLog(state, '[TRACE] ส่ง player_loaded ให้เอง (mineflayer ไม่ได้ส่งเพราะ event spawn ไม่ยิง)')
    } catch (e) { pushLog(state, `[TRACE] ส่ง player_loaded ไม่สำเร็จ: ${e.message}`) }
  }

  // เดินเอง: o = { keys: ['forward','left',...], sprint: bool, sneak: bool } = ปุ่มที่ "กดค้างอยู่ตอนนี้" (ว่าง = ปล่อยทุกปุ่ม)
  function manualMove(o) {
    o = o || {}
    const keys = Array.isArray(o.keys) ? o.keys.filter(k => MOVE_KEYS.includes(k)) : []
    if (!keys.length) { releaseAllKeys(); stopMoveTimer(); return { ok: true } }
    autoWalkCancel('คุณกดเดินเอง')
    const why = controlReady()
    if (why) { releaseAllKeys(); stopMoveTimer(); return { ok: false, error: why } }
    ensurePhysics()
    MOVE_KEYS.forEach(k => setCtl(k, keys.includes(k)))
    setCtl('sprint', !!o.sprint && keys.includes('forward'))
    setCtl('sneak', !!o.sneak)
    moveBeat = Date.now()
    if (!moveTimer) {
      pullLogN = 0
      moveTimer = setInterval(() => {
        if (!bot || Date.now() - moveBeat > MOVE_DEADMAN_MS) { releaseAllKeys(); stopMoveTimer() }
      }, 200)
    }
    if (!walkDiagDone) {
      walkDiagDone = true
      const b = bot
      setTimeout(() => { try { walkDiag(b) } catch (e) { pushLog(state, `[CTRL] วินิจฉัยไม่สำเร็จ: ${e.message}`) } }, 2500)
    }
    return { ok: true }
  }

  function manualStop() {
    autoWalkCancel()
    releaseAllKeys()
    stopMoveTimer()
    pushLog(state, '[CTRL] หยุดทุกการเคลื่อนไหว')
    return { ok: true }
  }


  // หัน: face=N/E/S/W | dyaw/dpitch = หมุนเพิ่ม (องศา, dyaw + = เลี้ยวขวา, dpitch + = เงย) | yaw/pitch = ค่าแบบ F3 | entity = หันหา entity id
  async function manualLook(o) {
    const why = controlReady()
    if (why) return { ok: false, error: why }
    o = o || {}
    const e = bot.entity
    let yaw = e.yaw, pitch = e.pitch
    const eid = numOrNull(o.entity)
    if (eid !== null) {
      const t = bot.entities && bot.entities[eid]
      if (!t || !t.position) return { ok: false, error: 'ไม่พบ entity นี้แล้ว (หลุดจากระยะ)' }
      await withTimeout(bot.lookAt(t.position.offset(0, (t.height || 1.5) * 0.6, 0), true), 1500)
      return { ok: true }
    }
    if (typeof o.face === 'string') {
      const faces = { N: 0, W: Math.PI / 2, S: Math.PI, E: 3 * Math.PI / 2 }
      if (!has(faces, o.face)) return { ok: false, error: 'ทิศไม่ถูกต้อง' }
      yaw = faces[o.face]
    }
    const ay = numOrNull(o.yaw), ap = numOrNull(o.pitch), dy = numOrNull(o.dyaw), dp = numOrNull(o.dpitch)
    if (ay !== null) yaw = (180 - ay) * D2R   // F3 yaw -> mineflayer yaw
    if (ap !== null) pitch = -ap * D2R        // F3 pitch (+ = ก้ม) -> mineflayer pitch (+ = เงย)
    if (dy !== null) yaw -= dy * D2R
    if (dp !== null) pitch += dp * D2R
    pitch = Math.max(-1.5, Math.min(1.5, pitch))
    await withTimeout(bot.look(yaw, pitch, true), 800)
    return { ok: true }
  }

  function entLabel(e) { return String(e.name || e.displayName || e.username || e.entityType || e.type || '').toLowerCase() }

  // entity ใกล้ตัว (ไม่รวมของที่ตกพื้น/แพ็กเก็ตตกแต่ง) เรียงตามระยะ
  function nearbyEntities(radius, limit) {
    if (!bot || !bot.entity || !bot.entity.position) return []
    const me = bot.entity.position
    const myYaw = wrap180(180 - bot.entity.yaw / D2R)
    const out = []
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || !e.position) continue
      const label = entLabel(e)
      if (NPC_SKIP.test(label)) continue
      const d = me.distanceTo(e.position)
      if (d > radius) continue
      const bearing = wrap180(-Math.atan2(e.position.x - me.x, e.position.z - me.z) / D2R)   // ทิศแบบ F3 จากบอทไปหา entity
      out.push({
        id: e.id, label: label || '?', type: String(e.type || ''), d: Math.round(d * 10) / 10,
        x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1),
        dir: compass(bearing), rel: Math.round(wrap180(bearing - myYaw))                       // rel + = อยู่ทางขวาของที่บอทหัน
      })
    }
    out.sort((a, b) => a.d - b.d)
    return out.slice(0, limit)
  }

  // ---- คลิกขวา entity: สร้างแพ็กเก็ตตาม schema ของโปรโตคอลที่ใช้อยู่จริง ----
  // เวอร์ชันใหม่ (26.x) เปลี่ยนรูปแบบแพ็กเก็ต use_entity/interact (ต้องมีตำแหน่งที่คลิก) ทำให้ bot.activateEntity ของ mineflayer
  // serialize ไม่ได้ ("Cannot read properties of undefined (reading 'x')") และ error นั้นเคยทำให้บอทหลุด
  function buildInteractParams(types, packetName, npc, hit, sneaking) {
    const resolve = (t) => (typeof t === 'string' && types[t] && types[t] !== 'native') ? types[t] : t
    const num = (name) => (/entity|target|^id$/i.test(String(name || '')) ? npc.id : 0)
    const fill = (type, name, parent) => {
      type = resolve(type)
      if (typeof type === 'string') {
        if (type === 'bool') return /sneak|secondary|shift/i.test(name) ? !!sneaking : false
        if (/^(vec3|lpvec3|position)/i.test(type)) return { x: hit.x, y: hit.y, z: hit.z }
        if (type === 'f32' || type === 'f64') return /y$/i.test(name) ? hit.y : /z$/i.test(name) ? hit.z : hit.x
        if (/^(varint|varlong|i8|u8|i16|u16|i32|u32|i64|u64|li32|lu32)$/.test(type)) return num(name)
        return undefined
      }
      if (!Array.isArray(type)) return undefined
      const kind = type[0], arg = type[1]
      if (kind === 'container') {
        const o = {}
        for (const f of arg) {
          const v = fill(f.type, f.name || '', o)
          if (f.anon) { if (v && typeof v === 'object') Object.assign(o, v) } else if (v !== undefined) o[f.name] = v
        }
        return o
      }
      if (kind === 'switch') {
        const key = String(arg.compareTo || '').split('/').pop()
        const val = parent ? parent[key] : undefined
        const t = (arg.fields && arg.fields[String(val)] !== undefined) ? arg.fields[String(val)] : arg.default
        return t === undefined ? undefined : fill(t, name, parent)
      }
      if (kind === 'option') return fill(arg, name, parent)
      if (kind === 'mapper') {
        const m = arg.mappings || {}
        const k = Object.keys(m).find(x => /^interact$/i.test(String(m[x])))
        return k !== undefined ? Number(k) : fill(arg.type, name, parent)
      }
      return undefined
    }
    return fill(types['packet_' + packetName], '', null)
  }

  function interactNpc(npc) {
    const c = bot && bot._client
    const types = bot && bot.registry && bot.registry.protocol && bot.registry.protocol.play && bot.registry.protocol.play.toServer && bot.registry.protocol.play.toServer.types
    if (!c || !types) throw new Error('อ่าน schema ของโปรโตคอลไม่ได้')
    const names = ['use_entity', 'interact', 'interact_entity'].filter(n => types['packet_' + n])
    if (!names.length) throw new Error('ไม่พบแพ็กเก็ตคลิก entity ใน protocol (ลองดู log ถัดไป)')
    const hit = { x: 0, y: (npc.height || 1) / 2, z: 0 }
    const sneaking = !!(bot.getControlState && bot.getControlState('sneak'))
    const errs = []
    for (const name of names) {
      try {
        const params = buildInteractParams(types, name, npc, hit, sneaking)
        c.serializer.createPacketBuffer({ name, params }) // ลอง serialize ก่อน — ถ้าผิดรูปจะ throw ตรงนี้ (ไม่ทำให้ client error)
        c.write(name, params)
        return `${name} ${JSON.stringify(params)}`
      } catch (e) { errs.push(`${name}: ${e.message}`) }
    }
    try { pushLog(state, `[CTRL] schema ${names[0]}: ${JSON.stringify(types['packet_' + names[0]]).slice(0, 500)}`) } catch {}
    throw new Error('สร้างแพ็กเก็ตคลิกไม่ได้ — ' + errs.join(' | '))
  }

  function waitForJoinEvidence(ms) {
    const b = bot
    return new Promise(resolve => {
      let done = false
      const onWin = () => fin('เมนูเปิดขึ้น')
      const onResp = () => fin('respawn/ย้ายโลก')
      const onEnd = () => fin('การเชื่อมต่อถูกตัด (อาจถูกส่งไปเซิร์ฟเวอร์อื่น)')
      const onMsg = (m) => {
        let t = ''; try { t = stringifyMsg(m) } catch {}
        if (/connect|เชื่อมต่อ|กำลังส่ง|กำลังเข้า|sending|joining|teleporting/i.test(t)) fin('แชท: ' + t.slice(0, 80))
      }
      const timer = setTimeout(() => fin(null), ms)
      function fin(why) {
        if (done) return
        done = true
        clearTimeout(timer)
        try { b.removeListener('windowOpen', onWin); b.removeListener('respawn', onResp); b.removeListener('end', onEnd); b.removeListener('message', onMsg) } catch {}
        resolve(why)
      }
      b.once('windowOpen', onWin); b.once('respawn', onResp); b.once('end', onEnd); b.on('message', onMsg)
    })
  }

  // คลิกขวา entity (เช่น NPC เลือกเซิร์ฟ) — หันหน้าหา entity ก่อนแล้วค่อยคลิก; ผลที่เซิร์ฟเวอร์ตอบจะขึ้นใน log
  async function manualInteract(id) {
    const why = controlReady()
    if (why) return { ok: false, error: why }
    const npc = bot.entities && bot.entities[id]
    if (!npc || !npc.position) return { ok: false, error: 'ไม่พบ entity นี้แล้ว (หลุดจากระยะ) — รอรายการอัปเดตแล้วลองใหม่' }
    const reach = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(npc.position.offset(0, (npc.height || 1.5) / 2, 0))
    const dist = reach()
    if (dist > 6) return { ok: false, error: `ไกลเกินไป (${dist.toFixed(1)} บล็อก) — เดินเข้าไปใกล้ก่อน (ต้องห่างไม่เกิน ~6 บล็อก)` }
    await withTimeout(bot.lookAt(npc.position.offset(0, (npc.height || 1.5) * 0.6, 0), true), 1500)
    await sleep(150)
    const evidence = waitForJoinEvidence(5000)
    let what
    try { what = interactNpc(npc) } catch (e) { pushLog(state, `[CTRL] คลิกไม่สำเร็จ: ${e.message}`); return { ok: false, error: e.message } }
    pushLog(state, `[CTRL] คลิกขวา ${entLabel(npc)} (id ${npc.id}, ห่าง ${dist.toFixed(1)}) → ${what}`)
    evidence.then(w => pushLog(state, w ? `[CTRL] ✅ เซิร์ฟเวอร์ตอบสนอง: ${w}` : '[CTRL] ยังไม่เห็นการตอบสนองจากเซิร์ฟเวอร์ใน 5 วิ'))
    return { ok: true }
  }

  function manualUse() {
    const why = controlReady()
    if (why) return { ok: false, error: why }
    try {
      bot.activateItem()
      pushLog(state, `[CTRL] คลิกขวาของในมือ: ${bot.heldItem ? bot.heldItem.name : '(มือเปล่า)'}`)
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  }

  function manualDismount() {
    if (!bot) return { ok: false, error: 'บอทยังไม่ออนไลน์' }
    if (!bot.vehicle) return { ok: false, error: 'บอทไม่ได้นั่งยานพาหนะ' }
    try { bot.dismount(); pushLog(state, '[CTRL] ลงจากยานพาหนะ'); return { ok: true } } catch (e) { return { ok: false, error: e.message } }
  }

  /* ===========================
     AUTO-WALK — เดินไปหา NPC เองหลังใส่ PIN เสร็จ (เดินอย่างเดียว ไม่คลิก — คลิกขวาเองที่แท็บ Control)
       - ใช้ปุ่มควบคุมแบบเดียวกับเดินเอง (ไม่ใช้ pathfinder) หันหา NPC + เดินหน้า + กระโดดเมื่อติด
       - กด "หยุดทุกอย่าง" หรือกดเดินเอง = ยกเลิกทันที
  =========================== */
  const WALK_STOP_DIST = 2.0     // หยุดเมื่อห่าง NPC (แนวนอน) ไม่เกินนี้
  const WALK_MAX_MS = 60000
  let walkRun = null             // { token, label, startedAt, target, d }
  let walkToken = 0
  let walkArmed = true           // เดินหลัง PIN ครั้งเดียวต่อการเชื่อมต่อ

  function autoWalkCancel(why) {
    if (!walkRun) return
    walkToken++
    walkRun = null
    if (why) pushLog(state, `[WALK] ยกเลิกการเดินอัตโนมัติ — ${why}`)
  }

  // เลือกเป้าหมาย: allay ก่อน → ไม่ใช่ผู้เล่น → อะไรก็ได้ที่ใกล้สุด
  function pickWalkTarget() {
    const list = nearbyEntities(64, 40)
    return list.find(e => /allay/.test(e.label)) || list.find(e => e.type !== 'player' && e.label !== 'player') || list[0] || null
  }

  function startWalk(label) {
    const why = controlReady()
    if (why) return { ok: false, error: why }
    autoWalkCancel()
    const token = ++walkToken
    walkRun = { token, label, startedAt: Date.now(), target: '', d: null }
    runWalk(token).catch(e => {
      pushLog(state, `[WALK] error: ${e.message}`)
      if (walkToken === token) { releaseAllKeys(); walkRun = null }
    })
    return { ok: true }
  }

  async function runWalk(token) {
    const b = bot
    const alive = () => bot === b && walkToken === token && b && b.entity && b.entity.position
    pushLog(state, `[WALK] เริ่มหา NPC (${walkRun.label})`)
    let tgtId = null, tgtLabel = ''
    const findUntil = Date.now() + 15000
    while (alive() && Date.now() < findUntil) {
      const t = pickWalkTarget()
      if (t) { tgtId = t.id; tgtLabel = t.label; break }
      await sleep(500)
    }
    if (!alive()) return
    if (tgtId === null) { pushLog(state, '[WALK] ไม่เจอ NPC/entity ในรัศมี 64 บล็อกภายใน 15 วิ — ไม่เดิน'); walkRun = null; return }
    walkRun.target = tgtLabel
    pushLog(state, `[WALK] เป้าหมาย: ${tgtLabel} (id ${tgtId})`)
    ensurePhysics()

    const startAt = Date.now()
    let lastPos = b.entity.position.clone(), lastCheck = Date.now()
    let stuckN = 0, jumpUntil = 0, sideUntil = 0, sideKey = 'left', lostN = 0
    let result = '', arrived = false, lastD = null
    while (alive()) {
      if (Date.now() - startAt > WALK_MAX_MS) { result = 'หมดเวลา 60 วิ'; break }
      const why = controlReady()
      if (why) { result = why; break }
      if (pullsRecent(5000) >= 8) { result = 'เซิร์ฟเวอร์ดึงตำแหน่งกลับรัว ๆ (ดู log [CTRL] ถูกดึงกลับ)'; break }
      const t = b.entities && b.entities[tgtId]
      if (!t || !t.position) {
        setCtl('forward', false)
        if (++lostN > 20) { result = 'NPC หลุดจากระยะ'; break }
        await sleep(150); continue
      }
      lostN = 0
      const me = b.entity.position
      const dx = t.position.x - me.x, dz = t.position.z - me.z
      const d = Math.hypot(dx, dz)
      lastD = d
      walkRun.d = Math.round(d * 10) / 10
      if (d <= WALK_STOP_DIST) { arrived = true; break }
      await withTimeout(b.lookAt(me.offset(dx, 1.62, dz), true), 300)
      const now = Date.now()
      if (now - lastCheck >= 700) {
        const moved = Math.hypot(me.x - lastPos.x, me.z - lastPos.z)
        lastPos = me.clone(); lastCheck = now
        if (moved < 0.15) {
          stuckN++
          jumpUntil = now + 400
          if (stuckN >= 3 && stuckN % 2 === 1) { sideKey = sideKey === 'left' ? 'right' : 'left'; sideUntil = now + 500 }
          if (stuckN === 3) pushLog(state, '[WALK] ติดอะไรอยู่ — ลองกระโดด/เบี่ยงข้าง')
          if (stuckN >= 12) { result = 'ติดนานเกิน (เดินต่อไม่ได้)'; break }
        } else stuckN = 0
      }
      setCtl('sprint', true) // เซิร์ฟเวอร์นี้ดึงกลับถ้าเดินธรรมดา แต่ถ้าวิ่งไม่โดน
      setCtl('back', false)
      setCtl('forward', true)
      setCtl('jump', now < jumpUntil)
      setCtl('left', now < sideUntil && sideKey === 'left')
      setCtl('right', now < sideUntil && sideKey === 'right')
      await sleep(80)
    }
    if (walkToken !== token) return // ถูกยกเลิก/แทนที่ — คนที่ยกเลิกจัดการปุ่มเอง
    releaseAllKeys()
    walkRun = null
    if (arrived) {
      pushLog(state, `[WALK] ✅ ถึงแล้ว ห่าง ${lastD.toFixed(1)} บล็อก — กด 🖱 คลิกขวา ที่แท็บ Control ได้เลย`)
      try { await withTimeout(b.lookAt(b.entities[tgtId].position.offset(0, ((b.entities[tgtId].height || 1.5) * 0.6), 0), true), 500) } catch {}
    } else {
      pushLog(state, `[WALK] หยุดเดิน: ${result || 'ไม่ทราบสาเหตุ'}${lastD !== null ? ` (ยังห่าง ${lastD.toFixed(1)} บล็อก)` : ''}`)
    }
  }

  // PIN ผ่านแล้ว = เซิร์ฟเวอร์ปิดหน้า PIN (clear_dialog) → รอกลับเข้าโลก/ไม่มีหน้า PIN เด้งใหม่ → เดิน
  async function waitPinThenWalk(b) {
    const clearedAt = pinClearedAt
    const notPassed = () => pinSeenAt > clearedAt || pinBlockedAt > clearedAt
    const giveUp = (m) => { pushLog(state, `[WALK] ${m}`); walkArmed = true }
    const until = Date.now() + 40000
    while (bot === b && Date.now() < until) {
      if (notPassed()) return giveUp('PIN ยังไม่ผ่าน — ไม่เดิน (จะลองใหม่เมื่อเซิร์ฟเวอร์ปิดหน้า PIN อีกครั้ง)')
      if (!controlReady() && Date.now() - clearedAt >= 3000) break
      await sleep(500)
    }
    if (bot !== b || controlReady()) return giveUp('รอเข้าโลกนานเกิน 40 วิ — ไม่เดิน (กดปุ่ม "เดินไปหา NPC ตอนนี้" ที่แท็บ Control ได้)')
    await sleep(1500) // เผื่อเซิร์ฟเวอร์ตอบ "กรุณากรอกรหัส PIN" ช้า
    if (bot !== b) return
    if (notPassed()) return giveUp('PIN ยังไม่ผ่าน — ไม่เดิน')
    if (!state.autoWalk) return
    const r = startWalk('หลังใส่ PIN เสร็จ')
    if (!r.ok) giveUp(`เดินไม่ได้: ${r.error}`)
  }

  function setupAutoWalk(b) {
    const c = b && b._client
    if (!c) return
    walkArmed = true
    autoWalkCancel()
    c.on('packet', (data, meta) => {
      if (!meta || meta.name !== 'clear_dialog') return
      if (!pinSeenAt || !walkArmed || !state.autoWalk) return
      walkArmed = false
      pushLog(state, '[WALK] เซิร์ฟเวอร์ปิดหน้า PIN — ถ้า PIN ผ่านและเข้าโลกแล้ว จะเดินไปหา NPC เอง')
      waitPinThenWalk(b).catch(e => pushLog(state, `[WALK] error: ${e.message}`))
    })
  }

  function setAutoWalk(on) {
    state.autoWalk = !!on
    if (!on) autoWalkCancel('ปิดระบบ')
    scheduleSaveBots()
    pushLog(state, `[WALK] เดินไปหา NPC อัตโนมัติหลังใส่ PIN: ${on ? 'เปิด' : 'ปิด'}`)
    return { ok: true, on: !!on }
  }
  /* ---- end AUTO-WALK ---- */

  /* ===========================
     RESOURCE PACK — ตอบรับอัตโนมัติ (ไม่ดาวน์โหลดไฟล์จริง)
       เซิร์ฟเวอร์ส่ง add_resource_pack (1.20.3+) หรือ resource_pack_send (เก่ากว่า) มา ทั้งใน configuration และ play
       บอทตอบ accepted → downloaded → loaded เหมือนไคลเอนต์ที่โหลดเสร็จ เซิร์ฟที่บังคับ resource pack จะปล่อยให้เข้า
  =========================== */
  function setupResourcePack(b) {
    const c = b && b._client
    if (!c) return
    c.on('packet', (data, meta) => {
      if (!meta) return
      if (meta.name === 'remove_resource_pack') return
      if (meta.name !== 'add_resource_pack' && meta.name !== 'resource_pack_send') return
      const st = meta.state || c.state
      const uuid = data && data.uuid
      let url = ''; try { url = String((data && data.url) || '').slice(0, 120) } catch {}
      const forced = data && data.forced !== undefined ? ` · บังคับ=${!!data.forced}` : ''
      pushLog(state, `[RP] เซิร์ฟเวอร์ส่ง resource pack (${st}/${meta.name}${forced}) ${url} — ตอบรับให้อัตโนมัติ (ไม่โหลดไฟล์จริง)`)
      // 3 = accepted, 4 = downloaded (มีเฉพาะ 1.20.3+ ที่มี uuid), 0 = loaded สำเร็จ
      const steps = uuid !== undefined && uuid !== null ? [[3, 50], [4, 400], [0, 800]] : [[3, 50], [0, 600]]
      steps.forEach(([result, delay]) => {
        setTimeout(() => {
          try {
            if (bot !== b || c.destroyed || c.state !== st) return
            const params = { result }
            if (uuid !== undefined && uuid !== null) params.uuid = uuid
            c.write('resource_pack_receive', params)
            if (result === 0) pushLog(state, '[RP] ✅ ตอบว่าโหลด resource pack สำเร็จแล้ว')
          } catch (e) { pushLog(state, `[RP] ตอบไม่สำเร็จ (result ${result}): ${e.message}`) }
        }, delay)
      })
    })
  }
  /* ---- end RESOURCE PACK ---- */

  function compass(f3yaw) {
    const names = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE']
    return names[Math.round((((f3yaw % 360) + 360) % 360) / 45) % 8]
  }

  // สถานะให้แท็บ Control (poll ทุก ~600ms)
  function controlState() {
    const why = controlReady()
    const out = { ts: Date.now(), ready: !why, why: why || '', status: state.status, forced: forcedMoves, ticks: physTicks, gfalse: groundFalse, softFixes, pulls10: pullsRecent(10000), pos: null, entities: [] }
    try {
      if (bot && bot.entity && bot.entity.position) {
        const p = bot.entity.position
        const yaw = wrap180(180 - bot.entity.yaw / D2R)
        out.pos = { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) }
        out.yaw = +yaw.toFixed(1)
        out.pitch = +(-bot.entity.pitch / D2R).toFixed(1)
        out.dir = compass(yaw)
        out.onGround = !!bot.entity.onGround
        out.vehicle = bot.vehicle ? String(bot.vehicle.name || bot.vehicle.type || 'มี') : ''
        if (!why) out.entities = nearbyEntities(32, 20)
      }
    } catch (e) { out.error = e.message }
    out.autoWalk = !!state.autoWalk
    out.walk = walkRun ? { running: true, target: walkRun.target, d: walkRun.d } : { running: false }
    return out
  }
  /* ---- end MANUAL CONTROL ---- */

  /* ---- Auto-eat: keep the bot fed without interrupting whatever it's doing ---- */

  let eatingNow = false
  async function tryAutoEat() {
    if (!bot || !state.autoEat || eatingNow) return
    if (typeof bot.food !== 'number') return
    if (bot.food >= 18) return
    let foodItem = null
    const items = bot.inventory.items()
    for (const name of FOOD_PRIORITY) {
      foodItem = items.find(i => i.name === name)
      if (foodItem) break
    }
    if (!foodItem) {
      foodItem = items.find(i => !FOOD_AVOID.includes(i.name) && /^(cooked_|baked_)/.test(i.name))
    }
    if (!foodItem) {
      if (bot.food <= 6) pushLog(state, '[AUTO-EAT] Hungry but no food in inventory!')
      return
    }
    eatingNow = true
    const prevHeld = bot.heldItem
    try {
      await bot.equip(foodItem, 'hand')
      await bot.consume()
      pushLog(state, `[AUTO-EAT] Ate ${foodItem.name} (food: ${bot.food}/20)`)
      if (prevHeld) { try { await bot.equip(prevHeld, 'hand') } catch {} }
    } catch (e) {
      pushLog(state, `[AUTO-EAT] Failed to eat: ${e.message}`)
    } finally {
      eatingNow = false
    }
  }

  /* ---- Server UI (dashboard): แสดง dialog/หน้าต่างของเซิร์ฟเวอร์ให้กดเอง ---- */
  function uiWinTitle(w) {
    let t = w && w.title
    if (t && typeof t === 'object' && !t.text && t.toString) t = t.toString()
    if (typeof t === 'string') {
      const q = t.trim()
      if (q[0] === '{' || q[0] === '[' || q[0] === '"') { try { t = textOf(JSON.parse(q)) } catch {} }
    } else t = textOf(t)
    return String(t || '').replace(/§./g, '').trim()
  }

  function itemLabel(it) {
    try {
      let n = it.customName
      if (n) {
        if (typeof n === 'string') {
          const q = n.trim()
          if (q[0] === '{' || q[0] === '[' || q[0] === '"') { try { n = textOf(JSON.parse(q)) } catch {} }
        } else n = textOf(n)
        n = String(n).replace(/§./g, '').trim()
        if (n) return n
      }
    } catch {}
    return String(it.displayName || it.name || '?')
  }

  function buildUiDialog(c, stateName, dlg, plain) {
    const pieces = (node) => collectTexts(node, []).map(t => String(t).replace(/§./g, '')).join('')
    let text = ''
    try {
      const parts = []
      if (dlg.title) parts.push(pieces(dlg.title))
      const body = Array.isArray(dlg.body) ? dlg.body : (dlg.body ? [dlg.body] : [])
      body.forEach(b => parts.push(pieces(b)))
      text = parts.map(x => x.trim()).filter(Boolean).join('\n')
    } catch {}
    if (!text) text = collectTexts(plain, []).map(t => String(t).replace(/§./g, '')).join('').trim()
    return { at: Date.now(), c, stateName, buttons: collectButtons(dlg), text, left: remainingAttempts(plain), dots: parseDots(plain), clickedAt: 0, closedAt: 0 }
  }

  function uiState() {
    const out = { ts: Date.now(), dialog: null, window: null }
    try {
      // dialog ที่เซิร์ฟเวอร์เพิ่งปิด (clear_dialog) ค้างไว้โชว์ ~2.5 วิ — เซิร์ฟเวอร์มักปิดแล้วส่งหน้าใหม่ตามมาทันที
      // เดิมตั้ง null ทันที แผงจึง "หายวับ" แล้วโผล่กลับมาทุกครั้งที่กดเลข
      if (uiDialog && uiDialog.closedAt && Date.now() - uiDialog.closedAt > 2500) uiDialog = null
      if (uiDialog && Date.now() - uiDialog.at < 120000) {
        out.dialog = {
          text: uiDialog.text, left: uiDialog.left, dots: uiDialog.dots ? uiDialog.dots.text : '',
          closed: !!uiDialog.closedAt, held: Date.now() < pinManualUntil,
          buttons: uiDialog.buttons.map((b, i) => ({ i, role: b.role, label: b.label }))
        }
      }
      const w = bot && bot.currentWindow
      if (w) {
        const end = typeof w.inventoryStart === 'number' ? w.inventoryStart : (w.slots || []).length
        const type = String(w.type || '')
        const cols = /hopper/.test(type) ? 5 : /3x3/.test(type) ? 3 : 9
        const slots = []
        for (let i = 0; i < end; i++) {
          const it = w.slots[i]
          slots.push(it ? { s: i, label: itemLabel(it), n: it.count || 1 } : { s: i, label: '' })
        }
        out.window = { title: uiWinTitle(w), type, cols, slots }
      }
    } catch (e) { out.error = e.message }
    return out
  }

  // รอ dialog ที่ "ยังกดได้" (ไม่ได้ปิด และยังไม่ถูกกดไป — ปุ่มของ Paper ใช้ได้ครั้งเดียว ต้องรอหน้าชุดใหม่)
  // ถ้าหน้านี้ถูกกดไปแล้วเกิน 2.5 วิแต่เซิร์ฟเวอร์ไม่ส่งหน้าใหม่ ก็ยอมให้ลองกดซ้ำ
  async function waitDialogReady(ms) {
    const t0 = Date.now()
    for (;;) {
      const d = uiDialog
      if (!d) return null
      if (!d.closedAt && (!d.clickedAt || Date.now() - d.clickedAt > 2500)) return d
      if (Date.now() - t0 >= ms) return null
      await sleep(40)
    }
  }

  // กดปุ่มจากแดชบอร์ด: เข้าคิว (กดรัว ๆ ได้ ลำดับเลขไม่เพี้ยน) — เดิมกดถี่เกินไปจะโดนปฏิเสธแล้วเลขตกหล่น
  // ปุ่มเลือกจาก "ข้อความบนปุ่ม" ในหน้าล่าสุด ไม่ใช่ตำแหน่ง (id/ลำดับของปุ่มเปลี่ยนทุกหน้า)
  let uiClickChain = Promise.resolve()
  function uiDialogClick(i, label) {
    if (!bot || !uiDialog) return Promise.resolve({ ok: false, error: 'ตอนนี้เซิร์ฟเวอร์ไม่ได้เปิดหน้าต่างให้กด' })
    pinManualUntil = Date.now() + 40000 // คนกดแล้ว — บอทเลิกกด PIN อัตโนมัติทันที (กันกดชนกันจนเลขมั่ว/โดนล็อก)
    if (pinRun) { pinRun.active = false; pinRun.settling = false; if (pinRun.wake) pinRun.wake() }
    const job = uiClickChain.then(() => uiDialogClickNow(i, label))
    uiClickChain = job.catch(() => {})
    return job
  }

  async function uiDialogClickNow(i, label) {
    const d = await waitDialogReady(3500)
    if (!bot || !d) return { ok: false, error: 'เซิร์ฟเวอร์ยังไม่ส่งหน้าใหม่มา (หรือปิดหน้านี้แล้ว) — ลองกดอีกครั้ง' }
    const want = (label === undefined || label === null) ? '' : String(label)
    let b = null
    if (want) b = d.buttons.find(x => x.label === want)
    else { const cand = d.buttons[i]; b = (cand && cand.label === '') ? cand : d.buttons.find(x => x.label === '') }
    if (!b) return { ok: false, error: 'ไม่พบปุ่มนี้แล้ว (หน้าเปลี่ยน) ลองกดใหม่' }
    try {
      const what = pressButton(d.c, b)
      d.clickedAt = Date.now()
      pinManualUntil = Date.now() + 40000
      pushLog(state, `[PIN] (กดมือ) ${/^[0-9]$/.test(b.label) ? 'ปุ่มเลข' : `ปุ่ม "${b.label}"`} → ${what}`)
      return { ok: true }
    } catch (e) {
      pushLog(state, `[PIN] (กดมือ) ล้มเหลว: ${e.message}`)
      return { ok: false, error: e.message }
    }
  }

  // คลิกช่องในหน้าต่าง: ถ้าส่งข้อความบนปุ่มมาด้วย จะหาช่องที่ข้อความตรงในหน้าต่าง "ตอนนี้" (เซิร์ฟเวอร์บางเจ้าสลับตำแหน่งเลขทุกครั้งที่กด)
  async function uiWindowClick(slot, label) {
    const w = bot && bot.currentWindow
    if (!w) return { ok: false, error: 'ไม่มีหน้าต่างเปิดอยู่' }
    pinManualUntil = Date.now() + 40000
    let s = Number(slot)
    const want = (label === undefined || label === null) ? '' : String(label)
    if (want) {
      const end = typeof w.inventoryStart === 'number' ? w.inventoryStart : (w.slots || []).length
      const cur = w.slots[s]
      if (!cur || itemLabel(cur) !== want) {
        s = -1
        for (let k = 0; k < end; k++) { if (w.slots[k] && itemLabel(w.slots[k]) === want) { s = k; break } }
        if (s < 0) return { ok: false, error: 'หน้าต่างเปลี่ยนแล้ว ไม่พบช่องนี้ ลองกดใหม่' }
      }
    }
    try { await withTimeout(bot.clickWindow(s, 0, 0), 3000) } catch {}
    pushLog(state, `[UI] (กดมือ) คลิกช่อง ${s}${want ? ` "${want}"` : ''} ในหน้าต่าง`)
    return { ok: true }
  }

  function uiWindowClose() {
    const w = bot && bot.currentWindow
    if (!w) return { ok: false, error: 'ไม่มีหน้าต่างเปิดอยู่' }
    try { bot.closeWindow(w) } catch (e) { return { ok: false, error: e.message } }
    return { ok: true }
  }

  function pinHold(ms) {
    pinManualUntil = Date.now() + (ms || 300000)
    if (pinRun) { pinRun.active = false; pinRun.settling = false; if (pinRun.wake) pinRun.wake() }
    pushLog(state, `[PIN] พักการกด PIN อัตโนมัติ ${Math.round((ms || 300000) / 1000)} วินาที — ใส่เองที่แดชบอร์ด`)
    return { ok: true }
  }
  function pinResume() {
    pinManualUntil = 0
    pushLog(state, '[PIN] ให้บอทกลับมากด PIN อัตโนมัติได้แล้ว')
    return { ok: true }
  }
  /* ---- end Server UI ---- */

  const managed = {
    uiState,
    uiDialogClick,
    uiWindowClick,
    uiWindowClose,
    pinHold,
    state,
    manualMove, manualLook, manualStop, manualInteract, manualUse, manualDismount, controlState,
    startWalkNow: () => startWalk('กดปุ่มเอง'), setAutoWalk,
    pinResume,
    resetPin: () => { pinSubmits = 0; pinCooldownUntil = 0; pinLatest = null; pinSoftFails = 0; pinWrong = false; if (pinRun) { pinRun.active = false; pinRun.settling = false; if (pinRun.wake) pinRun.wake() } },
    connect: () => {
      reconnectAttempts = 0
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
        reconnectTimeout = null
      }
      if (STOPPED_STATES.has(state.status)) {
        state.status = 'starting'
      }
      connect()
    },
    stop: () => {
      state.status = 'stopped'
      state.connectedAt = null
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
        reconnectTimeout = null
      }
      cleanupBot()
      pushLog(state, 'Bot stopped')
    },
    sendChat: (msg) => {
      if (bot && state.status === 'online') {
        const trimmed = msg.trim().substring(0, 256)
        if (trimmed) {
          bot.chat(trimmed)
          pushLog(state, `> ${trimmed}`)
        }
      } else {
        pushLog(state, `[FAILED] Bot offline, cannot send: ${msg}`)
      }
    },
    get bot() { return bot }
  }

  bots.set(state.id, managed)
  connect()
  scheduleSaveBots()
  return managed
}

/* ===========================
   WEB API & ROUTES
=========================== */

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    bots: bots.size
  })
})

app.get('/api/status/:id', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' })
  const managed = bots.get(id)
  if (!managed) return res.status(404).json({ error: 'Bot not found' })
  const { state, bot } = managed
  let inventory = []
  try {
    if (bot?.inventory && state.status === 'online') {
      const rawItems = bot.inventory.items()
      for (let i = 0; i < rawItems.length; i++) {
        const item = rawItems[i]
        if (item) {
          inventory.push({
            name: item.displayName || item.name || 'Unknown',
            count: item.count || 1
          })
        }
      }
    }
  } catch (err) {}
  res.json({
    id: state.id,
    status: state.status,
    uptime: getUptime(state),
    lastMessage: state.lastMessage,
    logs: state.logs.slice(0, 50),
    ui: managed.uiState(),
    health: bot?.health ?? 0,
    food: bot?.food ?? 0,
    inventory,
    autoLogin: state.autoLogin,
    loginPassword: state.loginPassword ? '********' : '',
    autoPin: state.autoPin,
    loginPin: state.loginPin ? '****' : '',
    autoCommands: state.autoCommands,
    autoServerSelect: state.autoServerSelect,
    serverSelectItem: state.serverSelectItem,
    autoEat: state.autoEat
  })
})

app.post('/bot/:id/command', async (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' })
  const managed = bots.get(id)
  if (!managed) return res.status(404).json({ error: 'Bot not found' })
  const cmd = req.body.cmd?.trim()
  if (!cmd) return res.status(400).json({ error: 'Empty command' })
  managed.sendChat(cmd)
  res.json({ success: true })
})

app.post('/add-bot', (req, res) => {
  const username = req.body.username?.trim()
  if (!username) {
    if (req.accepts('html')) return res.redirect('/?error=Username+required')
    return res.status(400).json({ error: 'Username required' })
  }
  const sanitized = username.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 16)
  if (!sanitized) {
    if (req.accepts('html')) return res.redirect('/?error=Invalid+username')
    return res.status(400).json({ error: 'Invalid username' })
  }
  createManagedBot({
    username: sanitized,
    accountType: req.body.accountType === 'premium' ? 'premium' : 'offline',
    autoLogin: false,
    loginPassword: '',
    autoCommands: []
  })
  if (req.accepts('html')) return res.redirect('/')
  res.json({ success: true })
})

app.post('/bot/:id/start', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (managed) managed.connect()
  res.redirect(`/bot/${id}`)
})

app.post('/bot/:id/stop', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (managed) managed.stop()
  res.redirect(`/bot/${id}`)
})

const uiRoute = (fn) => async (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (!managed) return res.sendStatus(404)
  try { res.json(await fn(managed, req.body || {})) } catch (e) { res.json({ ok: false, error: e.message }) }
}
app.post('/bot/:id/ui-dialog-click', uiRoute((m, b) => m.uiDialogClick(Number(b.i), b.label)))
app.post('/bot/:id/ui-window-click', uiRoute((m, b) => m.uiWindowClick(Number(b.slot), b.label)))
app.post('/bot/:id/ui-window-close', uiRoute((m) => m.uiWindowClose()))
app.post('/bot/:id/pin-hold', uiRoute((m) => m.pinHold(300000)))
app.post('/bot/:id/pin-resume', uiRoute((m) => m.pinResume()))

// ---- Manual control (แท็บ Control) ----
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1'
app.post('/bot/:id/ctrl-move', uiRoute((m, b) => m.manualMove(b)))
app.post('/bot/:id/ctrl-look', uiRoute((m, b) => m.manualLook(b)))
app.post('/bot/:id/ctrl-stop', uiRoute((m) => m.manualStop()))
app.post('/bot/:id/ctrl-interact', uiRoute((m, b) => m.manualInteract(Number(b.id))))
app.post('/bot/:id/ctrl-use', uiRoute((m) => m.manualUse()))
app.post('/bot/:id/ctrl-dismount', uiRoute((m) => m.manualDismount()))
app.post('/bot/:id/ctrl-walk-npc', uiRoute((m) => m.startWalkNow()))
app.post('/bot/:id/auto-walk', uiRoute((m, b) => m.setAutoWalk(truthy(b.on))))

// poll เบา ๆ สำหรับแผง Server UI (PIN) และแท็บ Control
app.get('/api/ui/:id', (req, res) => {
  const managed = bots.get(Number(req.params.id))
  if (!managed) return res.status(404).json({ error: 'Bot not found' })
  res.json(managed.uiState())
})
app.get('/api/ctrl/:id', (req, res) => {
  const managed = bots.get(Number(req.params.id))
  if (!managed) return res.status(404).json({ error: 'Bot not found' })
  res.json(managed.controlState())
})

app.post('/bot/:id/delete', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (managed) {
    managed.stop()
    bots.delete(id)
    saveBots()
  }
  if (req.accepts('html')) return res.redirect('/')
  res.json({ success: true })
})

app.post('/bot/:id/theme', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (!managed || !req.body.theme) return res.sendStatus(404)
  if (THEMES[req.body.theme]) {
    managed.state.theme = req.body.theme
    scheduleSaveBots()
    res.json({ success: true })
  } else {
    res.status(400).json({ error: 'Invalid theme' })
  }
})

app.post('/bot/:id/settings', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (!managed) return res.sendStatus(404)
  const { autoLogin, loginPassword, autoPin, loginPin, autoCommands, autoServerSelect, serverSelectItem, autoEat } = req.body
  managed.state.autoLogin = autoLogin === 'true' || autoLogin === true || autoLogin === '1'
  managed.state.loginPassword = typeof loginPassword === 'string' ? loginPassword : ''
  if (autoPin !== undefined || loginPin !== undefined) {
    const newPin = typeof loginPin === 'string' ? loginPin.replace(/[^0-9]/g, '').slice(0, 8) : managed.state.loginPin
    const newAuto = autoPin === undefined ? managed.state.autoPin : (autoPin === 'true' || autoPin === true || autoPin === '1')
    if (newPin !== managed.state.loginPin || newAuto !== managed.state.autoPin) managed.resetPin() // เปลี่ยน PIN/เปิดใหม่ -> เริ่มนับครั้งที่กรอกใหม่
    managed.state.loginPin = newPin
    managed.state.autoPin = newAuto
  }
  managed.state.autoServerSelect = autoServerSelect === 'true' || autoServerSelect === true || autoServerSelect === '1'
  if (autoEat !== undefined) {
    managed.state.autoEat = autoEat === 'true' || autoEat === true || autoEat === '1'
  }
  if (typeof serverSelectItem === 'string' && serverSelectItem.trim()) {
    managed.state.serverSelectItem = serverSelectItem.trim().toLowerCase()
  }
  try {
    let parsed = autoCommands
    if (typeof autoCommands === 'string') {
      parsed = JSON.parse(autoCommands)
    }
    if (Array.isArray(parsed)) {
      managed.state.autoCommands = parsed
        .filter(cmd => cmd && typeof cmd.cmd === 'string' && cmd.cmd.trim())
        .map(cmd => ({
          delay: Math.max(0, Number(cmd.delay) || 2000),
          cmd: cmd.cmd.trim()
        }))
    } else {
      managed.state.autoCommands = []
    }
  } catch {
    managed.state.autoCommands = []
  }
  scheduleSaveBots()
  res.json({ success: true })
})

app.get('/api/bots', (req, res) => {
  const summary = Array.from(bots.values()).map(({ state }) => ({
    id: state.id,
    username: state.originalUsername,
    status: state.status,
    uptime: getUptime(state),
    theme: state.theme
  }))
  res.json(summary)
})

// ✅ ข้อ 4: หน้าและ API สำหรับตั้งค่า Server
app.get('/config', (req, res) => {
  const escapedHost = escapeHtml(serverConfig.host)
  const escapedUser = escapeHtml(serverConfig.defaultUsername)
  const escapedVersion = escapeHtml(serverConfig.version || '')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Server Config – Galaxy Hub</title>
  <link rel="stylesheet" href="/styles.css">
  <style>:root{${getThemeVars('galaxy')}}body{overflow-x:hidden;}</style>
</head>
<body>
  ${BG_SCRIPT}
  <nav class="navbar">
    <a href="/" class="back-link">← HUB</a>
    <div class="navbar-brand">⚙️ Server Configuration</div>
  </nav>
  <div class="page-wrap">
    <div class="glow-line"></div>
    <div class="panel" style="max-width:500px;margin:20px auto;">
      <div class="section-title">🌐 Minecraft Server</div>
      <form method="POST" action="/api/config" style="display:flex;flex-direction:column;gap:12px;">
        <div class="form-group">
          <label>Host / IP</label>
          <input class="input" name="host" value="${escapedHost}" required>
        </div>
        <div class="form-group">
          <label>Port</label>
          <input class="input" type="number" name="port" value="${serverConfig.port}" min="1" max="65535" required>
        </div>
        <div class="form-group">
          <label>Default Username</label>
          <input class="input" name="defaultUsername" value="${escapedUser}" maxlength="16">
        </div>
        <div class="form-group">
          <label>Game Version (ว่าง = auto, เช่น 26.2)</label>
          <input class="input" name="version" value="${escapedVersion}" maxlength="16" placeholder="auto">
        </div>
        <button class="btn btn-primary" type="submit">💾 Save & Reconnect All</button>
      </form>
      <div style="font-size:12px;color:var(--text-dim);margin-top:12px;">
        ⚠️ Saving will disconnect all bots and reconnect them to the new address.
      </div>
    </div>
  </div>
</body>
</html>`)
})

app.post('/api/config', (req, res) => {
  const { host, port, defaultUsername, version } = req.body
  if (!host || !port) {
    return res.status(400).send('Host and port are required')
  }
  serverConfig.host = String(host).trim()
  serverConfig.port = Number(port) || 25565
  if (defaultUsername) serverConfig.defaultUsername = String(defaultUsername).trim()
  if (version !== undefined) serverConfig.version = String(version).trim()
  saveServerConfig()

  // Reconnect all bots
  bots.forEach(managed => {
    managed.stop()
    managed.connect()
  })

  if (req.accepts('html')) return res.redirect('/')
  res.json({ success: true })
})

/* ===========================
   THEME DEFINITIONS
=========================== */

const THEMES = {
  galaxy: {
    name: '🌌 Galaxy',
    bg: 'radial-gradient(ellipse at top, #1a1a3a 0%, #050510 60%)',
    panel: 'rgba(20,20,45,0.85)',
    accent1: '#a855f7',
    accent2: '#3b82f6',
    accent3: '#10b981',
    border: 'rgba(168,85,247,0.3)',
    glow: '#a855f7',
    titleGrad: 'linear-gradient(135deg, #3b82f6, #a855f7, #10b981)',
    stars: true
  },
  nebula: {
    name: '🔴 Nebula',
    bg: 'radial-gradient(ellipse at top, #3a1a1a 0%, #100505 60%)',
    panel: 'rgba(45,20,20,0.85)',
    accent1: '#f43f5e',
    accent2: '#fb923c',
    accent3: '#fbbf24',
    border: 'rgba(244,63,94,0.3)',
    glow: '#f43f5e',
    titleGrad: 'linear-gradient(135deg, #f43f5e, #fb923c, #fbbf24)',
    stars: true
  },
  matrix: {
    name: '💚 Matrix',
    bg: 'radial-gradient(ellipse at top, #001a00 0%, #000500 60%)',
    panel: 'rgba(0,20,0,0.9)',
    accent1: '#00ff41',
    accent2: '#00cc33',
    accent3: '#39ff14',
    border: 'rgba(0,255,65,0.3)',
    glow: '#00ff41',
    titleGrad: 'linear-gradient(135deg, #00ff41, #39ff14, #00cc33)',
    stars: false
  },
  ocean: {
    name: '🌊 Ocean',
    bg: 'radial-gradient(ellipse at top, #0a1628 0%, #020810 60%)',
    panel: 'rgba(10,22,45,0.9)',
    accent1: '#06b6d4',
    accent2: '#0ea5e9',
    accent3: '#38bdf8',
    border: 'rgba(6,182,212,0.3)',
    glow: '#06b6d4',
    titleGrad: 'linear-gradient(135deg, #0ea5e9, #06b6d4, #38bdf8)',
    stars: false
  },
  gold: {
    name: '👑 Gold',
    bg: 'radial-gradient(ellipse at top, #1a1500 0%, #0a0800 60%)',
    panel: 'rgba(30,25,0,0.9)',
    accent1: '#f59e0b',
    accent2: '#fcd34d',
    accent3: '#d97706',
    border: 'rgba(245,158,11,0.3)',
    glow: '#f59e0b',
    titleGrad: 'linear-gradient(135deg, #f59e0b, #fcd34d, #d97706)',
    stars: true
  }
}

const THEME_VARS_CACHE = {}
function buildThemeVars(t) {
  return `
    --bg: ${t.bg};
    --panel: ${t.panel};
    --accent1: ${t.accent1};
    --accent2: ${t.accent2};
    --accent3: ${t.accent3};
    --border: ${t.border};
    --glow: ${t.glow};
    --title-grad: ${t.titleGrad};
    --show-stars: ${t.stars ? '1' : '0'};
  `
}
for (const key of Object.keys(THEMES)) {
  THEME_VARS_CACHE[key] = buildThemeVars(THEMES[key])
}

function getThemeVars(themeKey) {
  return THEME_VARS_CACHE[themeKey] || THEME_VARS_CACHE.galaxy
}

const ITEM_ICONS = {
  sword: '⚔️', axe: '🪓', pickaxe: '⛏️', shovel: '🔧', hoe: '🌾',
  bow: '🏹', crossbow: '🏹', trident: '🔱', shield: '🛡️',
  helmet: '⛑️', chestplate: '🦺', leggings: '👖', boots: '👢',
  apple: '🍎', bread: '🍞', steak: '🥩', chicken: '🍗', fish: '🐟',
  salmon: '🐟', cod: '🐟', carrot: '🥕', potato: '🥔',
  mushroom: '🍄', cake: '🎂', cookie: '🍪', melon: '🍉', pumpkin: '🎃',
  diamond: '💎', emerald: '💚', gold: '🟡', iron: '🔩', coal: '🪨',
  netherite: '🖤', wood: '🪵', log: '🪵', plank: '🪵', stick: '🥢',
  stone: '🪨', cobblestone: '🪨', gravel: '🪨', sand: '🏖️',
  glass: '🔮', wool: '🧶', leather: '🟫',
  torch: '🔦', lantern: '🏮', chest: '📦', book: '📚',
  enchanted_book: '✨', paper: '📄', feather: '🪶', ink: '🖊️',
  arrow: '➶', flint: '💠', string: '🧵', slimeball: '🟢',
  blaze_rod: '🔥', ender_pearl: '🔮', eye_of_ender: '👁️',
  nether_star: '⭐', beacon: '🔆', compass: '🧭', clock: '🕐',
  map: '🗺️', bucket: '🪣', water_bucket: '💧', lava_bucket: '🌋',
  potion: '🧪', splash_potion: '💥', lingering_potion: '🌀',
  experience_bottle: '✨', golden_apple: '🍎', totem: '🗿',
  elytra: '🦋', firework: '🎆', egg: '🥚', snowball: '❄️',
  bone: '🦴', gunpowder: '💣', tnt: '💣', redstone: '🔴',
  glowstone: '💡', quartz: '🔷', prismarine: '🔵',
  default: '📦'
}

const SORTED_ITEM_KEYS = Object.keys(ITEM_ICONS)
  .filter(k => k !== 'default')
  .sort((a, b) => b.length - a.length)

function getItemIcon(itemName) {
  if (!itemName) return ITEM_ICONS.default
  const lower = itemName.toLowerCase()
  for (let i = 0; i < SORTED_ITEM_KEYS.length; i++) {
    if (lower.includes(SORTED_ITEM_KEYS[i])) return ITEM_ICONS[SORTED_ITEM_KEYS[i]]
  }
  return ITEM_ICONS.default
}

/* ===========================
   HTML TEMPLATE PARTS
=========================== */

const BG_SCRIPT = `
<canvas id="stars-canvas" style="position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;opacity:var(--show-stars,1);"></canvas>
<script>
(function(){
  var c = document.getElementById('stars-canvas');
  if (!c) return;
  var ctx = c.getContext('2d');
  var W, H;
  function resize(){ W = c.width = window.innerWidth; H = c.height = window.innerHeight; }
  resize(); window.addEventListener('resize', resize);
  var stars = [];
  for (var i = 0; i < 120; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.5 + 0.2,
      a: Math.random() * 0.7 + 0.1,
      s: Math.random() * 0.003 + 0.001
    });
  }
  var then = Date.now();
  function draw() {
    var now = Date.now();
    then = now;
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.a += Math.sin(now * s.s) * 0.002;
      s.a = s.a < 0.05 ? 0.05 : (s.a > 0.8 ? 0.8 : s.a);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + s.a + ')';
      ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  draw();
})();
</script>
`

// Home page
app.get('/', (req, res) => {
  const allBots = [...bots.values()]
  const online = allBots.filter(b => b.state.status === 'online').length
  const total = allBots.length

  const cardParts = []
  for (let i = 0; i < allBots.length; i++) {
    const { state } = allBots[i]
    const t = THEMES[state.theme] || THEMES.galaxy
    const escapedName = escapeHtml(state.username)
    const escapedMsg = escapeHtml(state.lastMessage || '-')
    const shortMsg = escapedMsg.length > 24 ? escapedMsg.substring(0, 24) + '…' : escapedMsg
    const uptime = getUptime(state)

    cardParts.push(`
    <div class="bot-card" id="bot-card-${state.id}" style="--glow: ${t.glow}; --glow-dim: ${t.glow}22;">
      <div class="bot-card-header">
        <div class="bot-avatar" style="background: linear-gradient(135deg, ${t.accent1}44 0%, ${t.accent2}22 50%, ${t.accent1}33 100%); --glow: ${t.glow};">🤖</div>
        <div>
          <div class="bot-name">${escapedName}</div>
          <div class="bot-type">${state.accountType === 'premium' ? '🔑 Microsoft' : '🔓 Offline'}</div>
        </div>
        <div style="margin-left:auto;">
          <div id="badge-${state.id}" class="badge badge-${state.status}">${state.status}</div>
        </div>
      </div>
      <div class="bot-card-body">
        <div class="stat-row"><span>⏱ Uptime</span><strong id="uptime-${state.id}">${uptime}</strong></div>
        <div class="stat-row"><span>💬 Last msg</span><strong style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapedMsg}">${shortMsg}</strong></div>
        <div class="stat-row" style="margin-top:4px;">
          <span style="font-size:10px;color:${t.accent1};opacity:0.7;">● ${t.name}</span>
          <span style="font-size:10px;color:var(--text-dim);">${state.autoLogin ? '🔐 auto-login' : ''}${state.autoCommands && state.autoCommands.length ? ' ⚡'+state.autoCommands.length+' cmds' : ''}</span>
        </div>
      </div>
      <div class="bot-card-footer">
        <a href="/bot/${state.id}" class="btn-manage" style="background:linear-gradient(135deg,${t.accent2},${t.accent1});">MANAGE CONTROL →</a>
        <button class="btn-delete-card" onclick="confirmDelete(${state.id},'${escapedName}')">🗑 DELETE BOT</button>
      </div>
    </div>`)
  }
  const cards = cardParts.join('')

  // ✅ ข้อ 4: ลิงก์ไป Server Config
  const serverConfigLink = `<a href="/config" style="margin-left:12px;font-size:13px;color:var(--accent1);">⚙️ Server</a>`

  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>🌌 Galaxy AFK Hub</title>
  <link rel="stylesheet" href="/styles.css">
  <style>:root{${getThemeVars('galaxy')}}body{overflow-x:hidden;}</style>
</head>
<body>
  ${BG_SCRIPT}
  
  <div class="modal-overlay" id="delete-modal">
    <div class="modal-box">
      <h3>🗑 Delete Bot?</h3>
      <p id="modal-msg">Are you sure you want to delete this bot?<br>This action cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-danger" id="modal-confirm-btn">Delete</button>
        <button class="btn btn-success" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  </div>

  <nav class="navbar">
    <div class="navbar-brand">🌌 GALAXY AFK HUB</div>
    <div class="navbar-stats">
      <div>Bots: <span>${total}</span></div>
      <div>Online: <span>${online}</span></div>
      ${serverConfigLink}
    </div>
  </nav>

  <div class="page-wrap">
    <div class="glow-line"></div>

    <div class="panel" style="margin-bottom:20px;">
      <div class="section-title">⊕ ADD NEW BOT</div>
      <form method="POST" action="/add-bot">
        <div class="add-form">
          <div class="form-group">
            <label>Username / Email</label>
            <input class="input" name="username" placeholder="Enter username..." required maxlength="16" pattern="[a-zA-Z0-9_]{3,16}" />
          </div>
          <div class="form-group">
            <label>Account Type</label>
            <select class="input select" name="accountType">
              <option value="offline">🔓 Offline</option>
              <option value="premium">🔑 Microsoft</option>
            </select>
          </div>
          <div class="form-group" style="justify-content:flex-end;">
            <button class="btn btn-primary" type="submit">ADD BOT</button>
          </div>
        </div>
      </form>
    </div>

    <div class="section-title">🤖 ACTIVE BOTS</div>
    <div class="bot-grid" id="bot-grid">
      ${cards || '<div style="color:var(--text-dim);font-size:14px;padding:20px 0;">No bots found. Add one above.</div>'}
    </div>
  </div>

  <script>
    var deleteTarget = null;
    function confirmDelete(id,name) {
      deleteTarget = id;
      document.getElementById('modal-msg').innerHTML = 'Delete <strong>' + name + '</strong>?<br>This cannot be undone.';
      document.getElementById('delete-modal').classList.add('open');
      document.getElementById('modal-confirm-btn').onclick = function() {
        if (deleteTarget) fetch('/bot/'+deleteTarget+'/delete',{method:'POST'}).then(function(){location.reload()});
        closeModal();
      };
    }
    function closeModal() {
      document.getElementById('delete-modal').classList.remove('open');
      deleteTarget = null;
    }
    document.getElementById('delete-modal').addEventListener('click',function(e) {
      if (e.target === this) closeModal();
    });

    var pollTimer = null;
    function pollStatus() {
      fetch('/api/bots')
        .then(function(r){ return r.json() })
        .then(function(bots){
          for (var i = 0; i < bots.length; i++) {
            var b = bots[i];
            var badge = document.getElementById('badge-' + b.id);
            if (badge) { badge.textContent = b.status; badge.className = 'badge badge-' + b.status; }
            var uptime = document.getElementById('uptime-' + b.id);
            if (uptime) uptime.textContent = b.uptime;
          }
        })
        .catch(function(){});
      pollTimer = setTimeout(pollStatus, 3000);
    }
    pollStatus();
  </script>
</body></html>`)
})

// ==================== BOT DETAIL PAGE WITH TABS (PROPERLY WORKING) ====================
app.get('/bot/:id', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.redirect('/')
  
  const managed = bots.get(id)
  if (!managed) return res.redirect('/')
  
  const { state } = managed
  const t = THEMES[state.theme] || THEMES.galaxy
  const escapedName = escapeHtml(state.username)
  const escapedPass = escapeHtml(state.loginPassword)
  const escapedPin = escapeHtml(state.loginPin || '')

  const themeKeys = Object.keys(THEMES)
  const themeButtonParts = []
  for (let i = 0; i < themeKeys.length; i++) {
    const key = themeKeys[i]
    const th = THEMES[key]
    const isActive = key === state.theme
    themeButtonParts.push(`<button class="theme-btn ${isActive ? 'active' : ''}" onclick="setTheme('${key}')" style="background:linear-gradient(135deg,${th.accent1}22,${th.accent2}22);color:${th.accent1};border-color:${isActive ? th.accent1 : 'transparent'};">${th.name}</button>`)
  }
  const themeButtons = themeButtonParts.join('')

  const initCmds = JSON.stringify(state.autoCommands || [])
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')

  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${escapedName} – Galaxy Hub</title>
  <link rel="stylesheet" href="/styles.css">
  <style>
    :root{${getThemeVars(state.theme)}}
    body{transition:background 0.5s;}
    .tab-nav {
      display: flex;
      gap: 4px;
      margin-bottom: 16px;
      background: var(--panel);
      border-radius: 12px;
      padding: 4px;
      border: 1px solid var(--border);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .tab-btn {
      flex: 1;
      padding: 10px 8px;
      background: transparent;
      border: none;
      color: var(--text-dim);
      font-size: 13px;
      cursor: pointer;
      border-radius: 8px;
      transition: all 0.2s;
      white-space: nowrap;
      min-width: 70px;
    }
    .tab-btn:hover {
      background: rgba(255,255,255,0.05);
      color: #fff;
    }
    .tab-btn.active {
      background: linear-gradient(135deg, var(--accent1), var(--accent2));
      color: #fff;
      font-weight: bold;
      box-shadow: 0 0 12px var(--glow);
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    /* ---- Server UI (PIN pad) ---- */
    .ui-text{white-space:pre-wrap;font-size:14px;margin-bottom:8px;text-align:center;}
    .ui-dots{text-align:center;font-size:26px;letter-spacing:6px;margin-bottom:6px;}
    .ui-left{text-align:center;color:#facc15;font-size:13px;margin-bottom:8px;}
    .kp-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px;}
    .kp-btn{min-height:56px;font-size:22px;font-weight:700;border-radius:10px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:inherit;touch-action:manipulation;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;cursor:pointer;}
    .kp-btn:active,.kp-btn.pressed{background:rgba(255,255,255,0.28);transform:scale(0.96);}
    .kp-btn[disabled]{opacity:0.35;}
    .kp-btn.empty{visibility:hidden;}
    .kp-exit{width:100%;margin-top:4px;font-size:13px;padding:8px;border-radius:8px;border:1px solid rgba(239,68,68,0.45);background:transparent;color:inherit;}
    .kp-hold{width:100%;margin-top:8px;font-size:13px;padding:8px;border-radius:8px;border:1px dashed rgba(255,255,255,0.3);background:transparent;color:inherit;}
    /* ---- Manual control ---- */
    .ctl-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:320px;margin:0 auto 12px;}
    .ctl-btn{min-height:60px;font-size:22px;font-weight:700;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:inherit;touch-action:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;cursor:pointer;}
    .ctl-btn.on{background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;box-shadow:0 0 12px var(--glow);}
    .ctl-btn.small{min-height:48px;font-size:15px;}
    .ctl-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
    .ctl-row > *{flex:1;min-width:84px;}
    .ctl-sub{font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin:6px 0 8px;}
    .mv-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px;max-width:320px;}
    .mv-btn{min-height:52px;font-size:15px;display:flex;align-items:center;justify-content:center;gap:4px;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;}
    .mv-btn small{opacity:.6;font-size:10px;}
    .btn.mv-on{background:rgba(99,102,241,0.6)!important;color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,0.25);}
    .ent-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:13px;}
    /* ✅ ข้อ 10: Responsive สำหรับมือถือ */
    @media (max-width: 600px) {
      .tab-btn { font-size: 11px; padding: 8px 4px; min-width: 60px; }
      .bot-info-panel .bot-info-header {
        flex-direction: column;
        align-items: flex-start;
      }
      .bot-info-panel .bot-info-details {
        margin-left: 0;
        margin-top: 8px;
      }
      .bot-info-panel .badge {
        align-self: flex-start;
        margin-top: 8px;
      }
      .info-stats-row {
        flex-wrap: wrap;
      }
      .info-stat {
        min-width: 80px;
      }
      .btn-block {
        padding: 12px;
        font-size: 14px;
      }
      .chat-input-wrap {
        flex-direction: column;
      }
      .chat-input-wrap .input {
        width: 100%;
        margin-bottom: 8px;
      }
      .chat-input-wrap .btn-icon-send {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  ${BG_SCRIPT}

  <div class="modal-overlay" id="delete-modal">
    <div class="modal-box">
      <h3>🗑 Delete Bot?</h3>
      <p>Delete <strong>${escapedName}</strong>?<br>This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-danger" onclick="deleteBotNow()">Delete</button>
        <button class="btn btn-success" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">✅ Settings Saved</div>

  <nav class="navbar">
    <a href="/" class="back-link">← HUB</a>
    <div class="navbar-brand" style="font-size:clamp(12px,2.5vw,18px);">${escapedName}</div>
    <div id="nav-badge" class="badge badge-${state.status}">${state.status}</div>
  </nav>

  <div class="page-wrap">
    <div class="glow-line"></div>
    
    <!-- Info Header (always visible) -->
    <div class="panel bot-info-panel" style="margin-bottom: 20px;">
      <div class="bot-info-header">
        <div class="bot-avatar bot-avatar-lg" style="background:linear-gradient(135deg,${t.accent1}44 0%,${t.accent2}22 50%,${t.accent1}33 100%);--glow:${t.glow};">🤖</div>
        <div class="bot-info-details">
          <div class="bot-info-name">${escapedName}</div>
          <div class="bot-info-type">${state.accountType === 'premium' ? '🔑 Microsoft Account' : '🔓 Offline Mode'}</div>
          <div style="font-size:12px;color:var(--text-dim);margin-top:4px;">${escapeHtml(serverConfig.host)}:${serverConfig.port}</div>
        </div>
        <div id="nav-badge-lg" class="badge badge-${state.status}" style="align-self:flex-start;margin-left:auto;">${state.status}</div>
      </div>
      <div class="divider"></div>
      <div class="info-stats-row">
        <div class="info-stat">
          <div class="info-stat-label">⏱ Uptime</div>
          <div class="info-stat-value" id="stat-uptime">-</div>
        </div>
        <div class="info-stat">
          <div class="info-stat-label">❤️ Health</div>
          <div class="info-stat-value hp-color" id="stat-hp">0</div>
        </div>
        <div class="info-stat">
          <div class="info-stat-label">🍖 Food</div>
          <div class="info-stat-value food-color" id="stat-food">0</div>
        </div>
      </div>
    </div>

    <!-- Tab Navigation -->
    <div class="tab-nav" id="tab-nav">
      <button class="tab-btn active" data-tab="dashboard">📊 Dashboard</button>
      <button class="tab-btn" data-tab="control">🕹 Control</button>
      <button class="tab-btn" data-tab="chat">💬 Chat</button>
      <button class="tab-btn" data-tab="inventory">🎒 Inventory</button>
      <button class="tab-btn" data-tab="settings">⚙️ Settings</button>
    </div>

    <!-- Tab Contents -->
    <div class="tab-content active" id="tab-dashboard">
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="panel" id="ui-panel" style="display:none;border-color:rgba(250,204,21,0.45);">
          <div class="section-title" style="font-size:13px;">🔐 SERVER UI — กดเองได้ (PIN / เมนู)</div>
          <div id="ui-dialog-box" style="display:none;">
            <div id="ui-text" class="ui-text"></div>
            <div id="ui-dots" class="ui-dots" style="display:none;"></div>
            <div id="ui-left" class="ui-left" style="display:none;"></div>
            <div id="kp-grid" class="kp-grid" style="display:none;"></div>
            <div id="ui-extra" class="kp-grid" style="display:none;"></div>
            <button id="ui-exit" type="button" class="kp-exit" style="display:none;"></button>
            <button id="ui-hold" type="button" class="kp-hold"></button>
          </div>
          <div id="ui-window-box" style="display:none;"></div>
        </div>

        <div class="panel">
          <div class="section-title" style="font-size:13px;">⚡ QUICK CONTROLS</div>
          <form method="POST" action="/bot/${state.id}/start" style="margin-bottom:10px;">
            <button class="btn btn-success btn-block" type="submit">▶ START BOT</button>
          </form>
          <form method="POST" action="/bot/${state.id}/stop" style="margin-bottom:10px;">
            <button class="btn btn-danger btn-block" type="submit">⏹ STOP BOT</button>
          </form>
        </div>

        <div class="panel">
          <div class="section-title" style="font-size:13px;">🎨 THEME</div>
          <div class="theme-picker" id="theme-picker">${themeButtons}</div>
        </div>

        <div class="panel" style="background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);">
          <button class="btn btn-block" onclick="document.getElementById('delete-modal').classList.add('open')" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444;font-size:13px;">🗑 DELETE THIS BOT</button>
        </div>
      </div>
    </div>

    <div class="tab-content" id="tab-control">
      <div class="panel">
        <div class="section-title">🎮 CONTROL (บังคับเอง)</div>
        <div id="ctl-status" style="font-size:13px;margin-bottom:4px;">กำลังโหลด…</div>
        <div id="ctl-pos" style="font-size:12px;color:var(--text-dim);margin-bottom:12px;word-break:break-word;"></div>

        <div class="ctl-sub">🚶 เดิน (กดค้าง = เดิน · ปล่อย = หยุด · คีย์บอร์ด W A S D / Space)</div>
        <div class="mv-pad">
          <span></span>
          <button type="button" class="btn mv-btn" data-mv="forward">▲ <small>W</small></button>
          <span></span>
          <button type="button" class="btn mv-btn" data-mv="left">◀ <small>A</small></button>
          <button type="button" class="btn mv-btn" data-mv="back">▼ <small>S</small></button>
          <button type="button" class="btn mv-btn" data-mv="right">▶ <small>D</small></button>
          <button type="button" class="btn mv-btn" onclick="toggleMv('sprint', this)">วิ่ง</button>
          <button type="button" class="btn mv-btn" data-mv="jump">กระโดด</button>
          <button type="button" class="btn mv-btn" onclick="toggleMv('sneak', this)">ย่อ</button>
        </div>
        <button type="button" class="btn btn-sm" style="background:rgba(239,68,68,0.25);width:100%;max-width:320px;margin-bottom:14px;" onclick="ctrlStop()">■ หยุดทุกอย่าง</button>
        <div class="ctl-sub">🤖 เดินไปหา NPC อัตโนมัติ (หลังใส่ PIN เสร็จ)</div>
        <div class="ctl-row">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" id="autowalk-on" ${state.autoWalk ? 'checked' : ''} onchange="setAutoWalk(this.checked)"> เปิดใช้</label>
          <button type="button" class="btn btn-sm btn-primary" onclick="ctrlPost('/ctrl-walk-npc', {})">เดินไปหา NPC ตอนนี้</button>
        </div>
        <div id="walk-status" style="font-size:11px;color:var(--text-dim);margin-bottom:14px;"></div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:14px;">วิ่งทำงานตอนกดเดินหน้า · ถ้าเน็ตหลุด/ปิดหน้านี้ บอทจะหยุดเดินเองภายใน ~1 วิ · ผลขึ้นในแท็บ Chat (บรรทัด [CTRL])</div>

        <div class="ctl-sub">👀 หัน (ปรับเอง)</div>
        <div class="ctl-row">
          <button type="button" class="btn btn-sm" onclick="ctrlLook({dyaw:-lookStep()})">◀</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({dyaw:lookStep()})">▶</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({dpitch:lookStep()})">▲</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({dpitch:-lookStep()})">▼</button>
          <select id="look-step" class="input input-sm"><option value="5">5°</option><option value="15" selected>15°</option><option value="45">45°</option><option value="90">90°</option></select>
        </div>
        <div class="ctl-row">
          <button type="button" class="btn btn-sm" onclick="ctrlLook({face:'N'})">N เหนือ</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({face:'E'})">E ตะวันออก</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({face:'S'})">S ใต้</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({face:'W'})">W ตะวันตก</button>
        </div>

        <div class="ctl-sub">🖱 คลิกขวา</div>
        <div class="ctl-row">
          <button type="button" class="btn btn-sm" onclick="ctrlUse()">ของในมือ</button>
          <button type="button" class="btn btn-sm" onclick="ctrlDismount()">ลงจากพาหนะ</button>
        </div>
      </div>

      <div class="panel" style="margin-top:16px;">
        <div class="section-title">🧍 NPC / ENTITY ใกล้ตัว (พร้อมตำแหน่ง)</div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">ใต้ชื่อแต่ละตัวคือพิกัด X Y Z + ทิศ/องศาเทียบกับที่บอทหันอยู่ (เดินไปหาเองแล้วกด 🖱 คลิกขวาเมื่อห่างไม่เกิน ~6 บล็อก) — ผลที่เซิร์ฟเวอร์ตอบจะขึ้นในแท็บ Chat (บรรทัด [CTRL]) และเมนูที่เปิดจะโผล่ในแผง SERVER UI ที่แท็บ Dashboard</div>
        <div id="ent-list"></div>
      </div>
    </div>

    <div class="tab-content" id="tab-chat">
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div class="section-title" style="margin-bottom:0;">💬 CHAT</div>
          <div style="font-size:11px;color:var(--text-dim);">Live feed</div>
        </div>
        <div class="chat-container">
          <div class="chat-viewport" id="log-box">
            <div class="chat-msg placeholder" style="color:var(--text-dim);text-align:center;padding:40px 20px;">
              <span style="font-size:24px;display:block;margin-bottom:8px;">📡</span>
              <span>Bot is Offline</span><br>
              <span style="font-size:11px;">Start the bot to connect to chat</span>
            </div>
          </div>
        </div>
        <div class="chat-input-wrap">
          <input id="cmd-in" class="input" placeholder="Send chat or command (prefix with /)" maxlength="256" />
          <button class="btn btn-primary btn-icon-send" onclick="sendCmd()">SEND</button>
        </div>
      </div>
    </div>

    <div class="tab-content" id="tab-inventory">
      <div class="panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div class="section-title" style="margin-bottom:0;">🎒 INVENTORY</div>
          <div class="inv-stat-chip" id="inv-count-chip">Items: <span id="inv-count">0</span></div>
        </div>
        <div class="inv-stats-bar" id="inv-stats-bar"></div>
        <div class="inv-panel">
          <div class="inv-grid" id="inv-grid">
            <div class="inv-empty-msg" style="grid-column:1/-1;">
              <span class="inv-empty-icon">🎒</span>
              Loading inventory...
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="tab-content" id="tab-settings">
      <div class="panel">
        <div class="section-title">⚙️ SETTINGS</div>

        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🔐 Server Login (password screen)</div>
          <div class="toggle-wrap" style="margin-bottom:10px;">
            <label class="toggle">
              <input type="checkbox" id="toggle-autologin" ${state.autoLogin ? 'checked' : ''} onchange="onToggleLogin(this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label" id="autologin-label">${state.autoLogin ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div id="login-pass-wrap" style="display:${state.autoLogin ? 'flex' : 'none'};gap:8px;align-items:center;">
            <input class="input input-sm" id="login-password" type="password" placeholder="Server password..." value="${escapedPass}" style="flex:1;" />
            <button class="btn btn-sm btn-primary" onclick="saveSettings()">Save</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">When the server opens its password dialog (text box + confirm button), the bot fills in this password and presses confirm automatically. Max 3 tries per connection.</div>
        </div>

        <div class="divider"></div>

        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🔢 Auto PIN (PIN pad screen)</div>
          <div class="toggle-wrap" style="margin-bottom:10px;">
            <label class="toggle">
              <input type="checkbox" id="toggle-autopin" ${state.autoPin ? 'checked' : ''} onchange="onTogglePin(this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label" id="autopin-label">${state.autoPin ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div id="login-pin-wrap" style="display:${state.autoPin ? 'flex' : 'none'};gap:8px;align-items:center;">
            <input class="input input-sm" id="login-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="PIN 4-8 digits..." value="${escapedPin}" style="flex:1;" />
            <button class="btn btn-sm btn-primary" onclick="saveSettings()">Save</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">When the server shows the number-pad screen (buttons 0-9), the bot presses the digits of this PIN one by one. It stops by itself after 2 full entries that did not get through, so your remaining attempts are not used up.</div>
        </div>

        <div class="divider"></div>

        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🚪 Auto-Join Server (right-click menu)</div>
          <div class="toggle-wrap" style="margin-bottom:10px;">
            <label class="toggle">
              <input type="checkbox" id="toggle-serverselect" ${state.autoServerSelect ? 'checked' : ''} onchange="onToggleServerSelect(this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label" id="serverselect-label">${state.autoServerSelect ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div id="serverselect-item-wrap" style="display:${state.autoServerSelect ? 'flex' : 'none'};gap:8px;align-items:center;">
            <input class="input input-sm" id="serverselect-item" type="text" placeholder="Item to click, e.g. grass_block" value="${escapeHtml(state.serverSelectItem || 'grass_block')}" style="flex:1;" />
            <button class="btn btn-sm btn-primary" onclick="saveSettings()">Save</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">After login, the bot right-clicks its held item to open the server-selector menu, then clicks the slot whose item name contains the text above.</div>
        </div>

        <div class="divider"></div>

        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🍗 Auto-Eat</div>
          <div class="toggle-wrap" style="margin-bottom:6px;">
            <label class="toggle">
              <input type="checkbox" id="toggle-autoeat" ${state.autoEat ? 'checked' : ''} onchange="onToggleAutoEat(this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label" id="autoeat-label">${state.autoEat ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div style="font-size:11px;color:var(--text-dim);">Eats the best food it's carrying whenever hunger drops below 18/20. Works in the background.</div>
        </div>

        <div class="divider"></div>

        <div>
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">⚡ Auto Commands</div>
          <div class="autocmd-list" id="autocmd-list"></div>
          <button class="btn-icon-add" onclick="addCmdRow()">+ Add Command</button>
          <div style="margin-top:12px;display:flex;gap:8px;">
            <button class="btn btn-sm btn-primary" style="flex:1;" onclick="saveSettings()">💾 Save Settings</button>
            <button class="btn btn-sm btn-warning" onclick="saveAndReconnect()">💾 + Reconnect</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    var STATE = {
      id: ${state.id},
      autoCommands: ${initCmds || '[]'},
      autoLoginOn: ${state.autoLogin},
      autoPinOn: ${state.autoPin},
      autoServerSelectOn: ${state.autoServerSelect},
      autoEatOn: ${state.autoEat},
      lastLogHash: '',
      toastTimer: null
    };

    // Tab switching
    (function() {
      var tabNav = document.getElementById('tab-nav');
      if (tabNav) {
        tabNav.addEventListener('click', function(e) {
          var btn = e.target.closest('.tab-btn');
          if (!btn) return;
          var tabName = btn.getAttribute('data-tab');
          if (!tabName) return;
          
          document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          
          document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
          var target = document.getElementById('tab-' + tabName);
          if (target) target.classList.add('active');
          
          if (typeof onTabChange === 'function') onTabChange(tabName);
          if (tabName === 'chat') {
            var logBox = document.getElementById('log-box');
            if (logBox) logBox.scrollTop = 0;
          }
        });
      }
    })();

    // ✅ แก้ XSS: ใช้ DOM API สร้าง element
    function renderCmds() {
      var list = document.getElementById('autocmd-list');
      list.innerHTML = '';
      STATE.autoCommands.forEach(function(row, idx) {
        var div = document.createElement('div');
        div.className = 'autocmd-row';

        var delayInput = document.createElement('input');
        delayInput.className = 'input input-sm autocmd-delay';
        delayInput.type = 'number';
        delayInput.min = '0';
        delayInput.step = '500';
        delayInput.value = row.delay || 2000;
        delayInput.addEventListener('input', function() {
          STATE.autoCommands[idx].delay = Number(this.value);
        });

        var cmdInput = document.createElement('input');
        cmdInput.className = 'input input-sm';
        cmdInput.type = 'text';
        cmdInput.placeholder = '/command...';
        cmdInput.value = row.cmd || '';
        cmdInput.addEventListener('input', function() {
          STATE.autoCommands[idx].cmd = this.value;
        });

        var removeBtn = document.createElement('button');
        removeBtn.className = 'btn-icon';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remove';
        removeBtn.onclick = function() { removeCmdRow(idx); };

        div.appendChild(delayInput);
        div.appendChild(cmdInput);
        div.appendChild(removeBtn);
        list.appendChild(div);
      });
    }

    function addCmdRow() { STATE.autoCommands.push({delay:2000,cmd:''}); renderCmds(); }
    function removeCmdRow(i) { STATE.autoCommands.splice(i,1); renderCmds(); }

    function onToggleLogin(checked) {
      STATE.autoLoginOn = checked;
      document.getElementById('autologin-label').textContent = checked ? 'Enabled' : 'Disabled';
      document.getElementById('login-pass-wrap').style.display = checked ? 'flex' : 'none';
    }

    function onToggleServerSelect(checked) {
      STATE.autoServerSelectOn = checked;
      document.getElementById('serverselect-label').textContent = checked ? 'Enabled' : 'Disabled';
      document.getElementById('serverselect-item-wrap').style.display = checked ? 'flex' : 'none';
    }

    function onToggleAutoEat(checked) {
      STATE.autoEatOn = checked;
      document.getElementById('autoeat-label').textContent = checked ? 'Enabled' : 'Disabled';
    }

    function onTogglePin(checked) {
      STATE.autoPinOn = checked;
      document.getElementById('autopin-label').textContent = checked ? 'Enabled' : 'Disabled';
      document.getElementById('login-pin-wrap').style.display = checked ? 'flex' : 'none';
    }

    function saveSettings() {
      var password = document.getElementById('login-password').value;
      var pinVal = document.getElementById('login-pin').value.replace(/[^0-9]/g, '');
      var serverSelectItem = document.getElementById('serverselect-item').value;
      fetch('/bot/' + STATE.id + '/settings', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({autoLogin:STATE.autoLoginOn,loginPassword:password,autoPin:STATE.autoPinOn,loginPin:pinVal,autoCommands:STATE.autoCommands,autoServerSelect:STATE.autoServerSelectOn,serverSelectItem:serverSelectItem,autoEat:STATE.autoEatOn})
      }).then(function(){
        showToast('✅ Settings Saved');
      });
    }

    function saveAndReconnect() {
      saveSettings();
      fetch('/bot/' + STATE.id + '/start', {method:'POST'}).then(function(){
        showToast('✅ Reconnecting...');
        setTimeout(function(){location.reload();},1200);
      });
    }

    function showToast(msg) {
      var t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      if (STATE.toastTimer) clearTimeout(STATE.toastTimer);
      STATE.toastTimer = setTimeout(function(){t.classList.remove('show');},2500);
    }

    function closeModal() { document.getElementById('delete-modal').classList.remove('open'); }
    function deleteBotNow() {
      fetch('/bot/' + STATE.id + '/delete', {method:'POST'}).then(function(){window.location.href='/';});
    }
    document.getElementById('delete-modal').addEventListener('click',function(e){if(e.target===this)closeModal();});

    function parseLogs(logs) {
      if (!logs || !logs.length) return '<div class="chat-msg placeholder" style="color:var(--text-dim);text-align:center;">No messages yet</div>';
      var parts = [];
      var limit = Math.min(logs.length, 50);
      for (var i = 0; i < limit; i++) {
        var raw = logs[i];
        var m = raw.match(/^(\[[\d:]+\])\s*([\s\S]*)$/i);
        if (m) {
          parts.push('<div class="chat-msg"><span class="chat-ts">' + m[1] + '</span><span class="chat-text">' + m[2] + '</span></div>');
        } else {
          parts.push('<div class="chat-msg"><span class="chat-text">' + raw + '</span></div>');
        }
      }
      return parts.join('');
    }

    function renderInventory(items) {
      var grid = document.getElementById('inv-grid');
      var countEl = document.getElementById('inv-count');
      var statsBar = document.getElementById('inv-stats-bar');

      if (!items || !items.length) {
        grid.innerHTML = '<div class="inv-empty-msg" style="grid-column:1/-1;"><span class="inv-empty-icon">🎒</span>Empty Inventory</div>';
        countEl.textContent = '0';
        statsBar.innerHTML = '';
        return;
      }

      countEl.textContent = items.length;
      var totalCount = 0;
      for (var i = 0; i < items.length; i++) totalCount += (items[i].count || 1);
      
      statsBar.innerHTML = '<div class="inv-stat-chip">Types: <span>' + items.length + '</span></div>' +
        '<div class="inv-stat-chip">Total: <span>' + totalCount + '</span></div>';

      var maxSlots = Math.min(36, Math.max(items.length, 9));
      var htmlParts = [];
      for (var i = 0; i < maxSlots; i++) {
        var item = items[i];
        if (item) {
          var icon = getItemIcon(item.name);
          var displayName = item.name.replace(/_/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2');
          htmlParts.push('<div class="inv-slot filled" title="' + item.name + ' x' + item.count + '">' +
            '<div class="inv-icon">' + icon + '</div>' +
            '<div class="inv-name">' + displayName + '</div>' +
            (item.count > 1 ? '<div class="inv-count">' + item.count + '</div>' : '') +
            '</div>');
        } else {
          htmlParts.push('<div class="inv-slot inv-empty-slot"><div class="inv-icon">▪</div></div>');
        }
      }
      grid.innerHTML = htmlParts.join('');
    }

    var _iconKeys = ['netherite','enchanted_book','experience_bottle','water_bucket','lava_bucket','splash_potion','lingering_potion','golden_apple','cobblestone','blaze_rod','ender_pearl','eye_of_ender','nether_star','glowstone','prismarine','firework','snowball','gunpowder','redstone','quartz','compass','diamond','emerald','crossbow','trident','chestplate','leggings','chicken','mushroom','pumpkin','leather','feather','string','totem','elytra','beacon','sword','axe','pickaxe','shovel','hoe','bow','shield','helmet','boots','apple','bread','steak','fish','salmon','cod','carrot','potato','cake','cookie','melon','gold','iron','coal','wood','log','plank','stick','stone','gravel','sand','glass','wool','torch','lantern','chest','book','paper','arrow','flint','potion','totem','bone','tnt','clock','map','bucket','egg','bow'];
    var _iconMap = {sword:'⚔️',axe:'🪓',pickaxe:'⛏️',shovel:'🔧',hoe:'🌾',bow:'🏹',crossbow:'🏹',trident:'🔱',shield:'🛡️',helmet:'⛑️',chestplate:'🦺',leggings:'👖',boots:'👢',apple:'🍎',bread:'🍞',steak:'🥩',chicken:'🍗',fish:'🐟',salmon:'🐟',cod:'🐟',carrot:'🥕',potato:'🥔',mushroom:'🍄',cake:'🎂',cookie:'🍪',melon:'🍉',pumpkin:'🎃',diamond:'💎',emerald:'💚',gold:'🟡',iron:'🔩',coal:'🪨',netherite:'🖤',wood:'🪵',log:'🪵',plank:'🪵',stick:'🥢',stone:'🪨',cobblestone:'🪨',gravel:'🪨',sand:'🏖️',glass:'🔮',wool:'🧶',leather:'🟫',torch:'🔦',lantern:'🏮',chest:'📦',book:'📚',enchanted_book:'✨',paper:'📄',feather:'🪶',arrow:'➶',flint:'💠',string:'🧵',slimeball:'🟢',blaze_rod:'🔥',ender_pearl:'🔮',eye_of_ender:'👁️',nether_star:'⭐',beacon:'🔆',compass:'🧭',clock:'🕐',map:'🗺️',bucket:'🪣',water_bucket:'💧',lava_bucket:'🌋',potion:'🧪',splash_potion:'💥',lingering_potion:'🌀',experience_bottle:'✨',golden_apple:'🍎',totem:'🗿',elytra:'🦋',firework:'🎆',egg:'🥚',snowball:'❄️',bone:'🦴',gunpowder:'💣',tnt:'💣',redstone:'🔴',glowstone:'💡',quartz:'🔷',prismarine:'🔵'};
    function getItemIcon(name) {
      if (!name) return '📦';
      var lower = name.toLowerCase();
      for (var i = 0; i < _iconKeys.length; i++) {
        if (lower.includes(_iconKeys[i])) return _iconMap[_iconKeys[i]] || '📦';
      }
      return '📦';
    }

    var _lastInvHash = '';
    function invHash(items) {
      if (!items || !items.length) return '';
      var s = '';
      for (var i = 0; i < items.length; i++) s += items[i].name + ':' + items[i].count + ',';
      return s;
    }

    /* ---- Server UI (PIN pad / เมนูเซิร์ฟเวอร์) ----
       แก้อาการ "ปุ่มสลับมั่ว/หาย":
       1) แป้นเลขสร้างครั้งเดียว ตำแหน่งตายตัวแบบโทรศัพท์ (1-9 / ล้าง 0 ลบ) ไม่ตามลำดับที่เซิร์ฟเวอร์ส่งมา และไม่ rebuild ตอนข้อมูลอัปเดต
       2) ส่งคำสั่งด้วย "ข้อความบนปุ่ม" ไม่ใช่ตำแหน่ง — เซิร์ฟเวอร์เลือกปุ่มจากหน้าล่าสุดเอง (id ปุ่มเปลี่ยนทุกหน้า)
       3) ผลตอบกลับที่มาช้า/สลับลำดับถูกทิ้ง (เทียบ ts) — เดิมผล poll เก่าเขียนทับหน้าใหม่ได้
       4) หน้า PIN ที่เซิร์ฟเวอร์เพิ่งปิดจะค้างโชว์แบบจางสั้น ๆ แทนที่จะหายวับ */
    var _uiTs = 0, _uiKey = '', _kpBuilt = false, _kpCells = {};
    function $(id) { return document.getElementById(id); }
    function uiMk(tag, text, css) {
      var e = document.createElement(tag);
      if (text) e.textContent = text;
      if (css) e.style.cssText = css;
      return e;
    }
    function uiPost(path, body) {
      return fetch('/bot/' + STATE.id + path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {})})
        .then(function(r){ return r.json(); })
        .then(function(d){ if (d && !d.ok && d.error) showToast('⚠️ ' + d.error); uiPoll(); return d; })
        .catch(function(){ showToast('⚠️ ส่งคำสั่งไม่สำเร็จ'); });
    }
    function uiPoll() {
      fetch('/api/ui/' + STATE.id).then(function(r){ return r.json(); })
        .then(function(u){ if (u && !u.error) renderUI(u); }).catch(function(){});
    }
    function flash(el) { el.classList.add('pressed'); setTimeout(function(){ el.classList.remove('pressed'); }, 160); }
    function tapButton(el) {
      var b = el._btn; if (!b || el.disabled) return;
      flash(el);
      uiPost('/ui-dialog-click', {i: b.i, label: b.label});
    }
    function buildKeypad() {
      if (_kpBuilt) return; _kpBuilt = true;
      var g = $('kp-grid');
      ['1','2','3','4','5','6','7','8','9','L','0','R'].forEach(function(k){
        var el = uiMk('button', '', ''); el.type = 'button'; el.className = 'kp-btn empty';
        el.addEventListener('click', function(){ tapButton(el); });
        g.appendChild(el); _kpCells[k] = el;
      });
      var ex = $('ui-exit');
      ex.addEventListener('click', function(){
        var b = ex._btn; if (!b) return;
        if (!ex._armed) {
          ex._armed = true; ex._label = ex.textContent; ex.textContent = 'แตะอีกครั้งเพื่อยืนยัน: ' + ex._label;
          setTimeout(function(){ if (ex._armed) { ex._armed = false; ex.textContent = ex._label; } }, 3000);
          return;
        }
        ex._armed = false; ex.textContent = ex._label;
        uiPost('/ui-dialog-click', {i: b.i, label: b.label});
      });
      $('ui-hold').addEventListener('click', function(){ uiPost(this._held ? '/pin-resume' : '/pin-hold', {}); });
    }
    function setCell(k, b, closed) {
      var el = _kpCells[k];
      el._btn = b || null;
      if (!b) { el.className = 'kp-btn empty'; el.textContent = ''; el.disabled = true; return; }
      el.className = 'kp-btn'; el.textContent = b.label || '⌫'; el.disabled = !!closed;
    }
    function renderDialog(d) {
      var box = $('ui-dialog-box');
      if (!d) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      buildKeypad();
      $('ui-text').textContent = d.closed ? 'เซิร์ฟเวอร์ปิดหน้านี้แล้ว — รอหน้าใหม่…' : (d.text || '(dialog)');
      var dots = $('ui-dots'); dots.textContent = d.dots || ''; dots.style.display = d.dots ? 'block' : 'none';
      var left = $('ui-left');
      if (d.left !== null && d.left !== undefined) { left.textContent = 'เหลือโอกาสอีก ' + d.left + ' ครั้ง'; left.style.display = 'block'; } else left.style.display = 'none';

      var normal = [], exits = [], digits = {}, nd = 0;
      d.buttons.forEach(function(b){
        if (b.role === 'exit') { exits.push(b); return; }
        normal.push(b);
        if (/^[0-9]$/.test(b.label) && !digits[b.label]) { digits[b.label] = b; nd++; }
      });
      var isPad = nd >= 9;
      $('kp-grid').style.display = isPad ? 'grid' : 'none';
      var rest = normal;
      if (isPad) {
        var clr = null, back = null;
        rest = [];
        normal.forEach(function(b){
          if (digits[b.label] === b) return;
          if (!clr && /ล้าง|clear|reset/i.test(b.label)) clr = b;
          else if (!back && (b.label === '' || /ลบ|back|del|⌫/i.test(b.label))) back = b;
          else rest.push(b);
        });
        for (var k = 0; k <= 9; k++) setCell(String(k), digits[String(k)], d.closed);
        setCell('L', clr, d.closed); setCell('R', back, d.closed);
      }
      var extra = $('ui-extra'); extra.innerHTML = '';
      extra.style.display = rest.length ? 'grid' : 'none';
      rest.forEach(function(b){
        var el = uiMk('button', b.label || '⌫', ''); el.type = 'button'; el.className = 'kp-btn';
        el.style.fontSize = '15px'; el._btn = b; el.disabled = !!d.closed;
        el.addEventListener('click', function(){ tapButton(el); });
        extra.appendChild(el);
      });
      var ex = $('ui-exit');
      ex._armed = false;
      if (exits.length) { ex.style.display = 'block'; ex._btn = exits[0]; ex.textContent = exits[0].label || 'เมนูแบบเก่า'; ex.disabled = !!d.closed; } else { ex.style.display = 'none'; ex._btn = null; }
      var hold = $('ui-hold');
      hold._held = !!d.held;
      hold.textContent = d.held ? '✋ บอทพักกด PIN อยู่ — แตะเพื่อให้บอทกลับมากดเอง' : '✋ ให้บอทพักกด PIN อัตโนมัติ 5 นาที (กันบอทกดแย่ง)';
    }
    function renderWindow(w) {
      var box = $('ui-window-box');
      if (!w) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.style.display = 'block'; box.innerHTML = '';
      box.appendChild(uiMk('div', '🪟 หน้าต่าง: ' + (w.title || w.type), 'font-size:14px;margin:4px 0 8px;font-weight:700;'));
      var itemCss = 'min-height:44px;font-size:13px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:inherit;padding:4px;word-break:break-word;';
      function slotBtn(sl) {
        var el = uiMk('button', sl.label + (sl.n > 1 ? ' ×' + sl.n : ''), itemCss);
        el.type = 'button';
        el.onclick = function(){ uiPost('/ui-window-click', {slot: sl.s, label: sl.label}); };
        return el;
      }
      var digitSlots = {}, nd = 0;
      w.slots.forEach(function(sl){ if (/^[0-9]$/.test(sl.label) && !digitSlots[sl.label]) { digitSlots[sl.label] = sl; nd++; } });
      if (nd >= 9) {
        // หน้าต่างแบบแป้นเลข: จัดเรียงแบบโทรศัพท์ตายตัว (เซิร์ฟเวอร์อาจสลับตำแหน่งเลขทุกครั้ง) — คลิกด้วยข้อความบนปุ่ม
        var pad = uiMk('div', '', 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px;');
        ['1','2','3','4','5','6','7','8','9','','0',''].forEach(function(k){
          if (!k) { pad.appendChild(uiMk('div', '', '')); return; }
          var el = slotBtn(digitSlots[k]); el.style.minHeight = '56px'; el.style.fontSize = '22px'; el.style.fontWeight = '700';
          pad.appendChild(el);
        });
        box.appendChild(pad);
        var others = uiMk('div', '', 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px;');
        w.slots.forEach(function(sl){ if (sl.label && digitSlots[sl.label] !== sl) others.appendChild(slotBtn(sl)); });
        box.appendChild(others);
      } else {
        var wg = uiMk('div', '', 'display:grid;grid-template-columns:repeat(' + w.cols + ',1fr);gap:6px;');
        w.slots.forEach(function(sl){
          if (!sl.label) { wg.appendChild(uiMk('div', '', 'min-height:44px;border-radius:6px;background:rgba(255,255,255,0.03);')); return; }
          wg.appendChild(slotBtn(sl));
        });
        box.appendChild(wg);
      }
      var cl = uiMk('button', 'ปิดหน้าต่าง', 'width:100%;margin-top:8px;font-size:14px;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.25);background:transparent;color:inherit;');
      cl.onclick = function(){ uiPost('/ui-window-close', {}); };
      box.appendChild(cl);
    }
    function renderUI(ui) {
      var panel = $('ui-panel');
      if (ui && typeof ui.ts === 'number') { if (ui.ts < _uiTs) return; _uiTs = ui.ts; }
      if (!ui || (!ui.dialog && !ui.window)) { panel.style.display = 'none'; _uiKey = ''; return; }
      var key = JSON.stringify({d: ui.dialog, w: ui.window});
      if (key === _uiKey) return;
      _uiKey = key;
      panel.style.display = 'block';
      renderDialog(ui.dialog);
      renderWindow(ui.window);
    }

    function update() {
      fetch('/api/status/' + STATE.id)
        .then(function(r){return r.json()})
        .then(function(data){
          if (data.error) return;

          document.getElementById('nav-badge').textContent = data.status;
          document.getElementById('nav-badge').className = 'badge badge-' + data.status;
          document.getElementById('nav-badge-lg').textContent = data.status;
          document.getElementById('nav-badge-lg').className = 'badge badge-' + data.status;
          document.getElementById('stat-uptime').textContent = data.uptime;
          document.getElementById('stat-hp').textContent = Math.round(data.health);
          document.getElementById('stat-food').textContent = Math.round(data.food);
          renderUI(data.ui);

          if (data.logs[0] !== STATE.lastLogHash) {
            document.getElementById('log-box').innerHTML = parseLogs(data.logs);
            STATE.lastLogHash = data.logs[0] || '';
            document.getElementById('log-box').scrollTop = 0;
          }

          var h = invHash(data.inventory);
          if (h !== _lastInvHash) {
            _lastInvHash = h;
            renderInventory(data.inventory || []);
          }

        })
        .catch(function(){});
    }

    function sendCmd() {
      var cmd = document.getElementById('cmd-in').value.trim();
      if (!cmd) return;
      fetch('/bot/' + STATE.id + '/command', {
        method: 'POST',
        headers: {'Content-Type':'application/x-www-form-urlencoded'},
        body: 'cmd=' + encodeURIComponent(cmd)
      });
      document.getElementById('cmd-in').value = '';
      setTimeout(update, 300);
    }

    document.getElementById('cmd-in').addEventListener('keydown',function(e){if(e.key==='Enter')sendCmd();});

    function setTheme(key) {
      fetch('/bot/' + STATE.id + '/theme', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({theme:key})
      }).then(function(){location.reload();});
    }

    /* ---- เดินเอง + หัน/คลิกเอง (แท็บ Control) ---- */
    var CTRL = { active: false, entKey: '' };
    function ctrlPost(path, body, quiet) {
      return fetch('/bot/' + STATE.id + path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {})})
        .then(function(r){ return r.json(); })
        .then(function(d){ if (d && !d.ok && d.error && !quiet) showToast('⚠️ ' + d.error); return d; })
        .catch(function(){ if (!quiet) showToast('⚠️ ส่งคำสั่งไม่สำเร็จ'); });
    }
    function ctrlStop() { releaseMove(); ctrlPost('/ctrl-stop', {}); }
    function ctrlLook(o) { ctrlPost('/ctrl-look', o); }
    function lookStep() { return Number($('look-step').value) || 15; }
    function ctrlUse() { ctrlPost('/ctrl-use', {}); }
    function setAutoWalk(on) { ctrlPost('/auto-walk', {on: on}); }
    function ctrlDismount() { ctrlPost('/ctrl-dismount', {}); }

    /* เดินเอง: กดค้าง = เดิน, ปล่อย = หยุด — ส่งชุดปุ่มที่กดอยู่ทุก ~300ms (เซิร์ฟเวอร์หยุดเองถ้าเงียบเกิน 1.2 วิ) */
    var MV = { keys: {}, sprint: false, sneak: false, timer: null };
    function mvList() { return Object.keys(MV.keys).filter(function(k){ return MV.keys[k]; }); }
    function mvSend() {
      fetch('/bot/' + STATE.id + '/ctrl-move', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({keys: mvList(), sprint: MV.sprint, sneak: MV.sneak})}).catch(function(){});
    }
    function mvRefresh() {
      var any = mvList().length > 0;
      document.querySelectorAll('[data-mv]').forEach(function(b){ b.classList.toggle('mv-on', !!MV.keys[b.getAttribute('data-mv')]); });
      if (any && !MV.timer) MV.timer = setInterval(mvSend, 300);
      if (!any && MV.timer) { clearInterval(MV.timer); MV.timer = null; }
    }
    function mvSet(k, on) { if (!!MV.keys[k] === on) return; MV.keys[k] = on; mvRefresh(); mvSend(); }
    function releaseMove() { if (!mvList().length && !MV.timer) return; MV.keys = {}; mvRefresh(); mvSend(); }
    function toggleMv(name, btn) { MV[name] = !MV[name]; btn.classList.toggle('mv-on', MV[name]); if (mvList().length) mvSend(); }
    document.querySelectorAll('[data-mv]').forEach(function(b){
      var k = b.getAttribute('data-mv');
      b.addEventListener('pointerdown', function(e){ e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (x) {} mvSet(k, true); });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function(ev){ b.addEventListener(ev, function(){ mvSet(k, false); }); });
      b.addEventListener('contextmenu', function(e){ e.preventDefault(); });
    });
    var KEYMAP = { w: 'forward', s: 'back', a: 'left', d: 'right', ' ': 'jump' };
    document.addEventListener('keydown', function(e){
      if (!CTRL.active) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      var k = KEYMAP[String(e.key).toLowerCase()];
      if (!k) return;
      e.preventDefault(); mvSet(k, true);
    });
    document.addEventListener('keyup', function(e){ var k = KEYMAP[String(e.key).toLowerCase()]; if (k) mvSet(k, false); });
    window.addEventListener('blur', releaseMove);
    document.addEventListener('visibilitychange', function(){ if (document.hidden) releaseMove(); });

    function entPosText(e) {
      var r = e.rel;
      var side = Math.abs(r) < 8 ? 'ตรงหน้า' : (Math.abs(r) > 150 ? 'อยู่ข้างหลัง' : (r > 0 ? 'ขวา ' : 'ซ้าย ') + Math.round(Math.abs(r)) + '°');
      return '📍 X ' + e.x + '  Y ' + e.y + '  Z ' + e.z + '  ·  🧭 ' + e.dir + ' · ' + side;
    }

    function renderCtrl(st) {
      var s = $('ctl-status');
      if (!st.ready) { s.textContent = '⚠️ ' + (st.why || 'ยังควบคุมไม่ได้'); s.style.color = '#facc15'; }
      else { s.textContent = '🟢 พร้อมควบคุม'; s.style.color = ''; }
      var w = st.walk, ws = $('walk-status');
      if (ws) ws.textContent = (w && w.running)
        ? '🚶 กำลังเดินไป ' + (w.target || 'NPC') + (w.d != null ? ' (เหลือ ' + w.d + ' บล็อก)' : '') + ' — กด ■ หยุดทุกอย่าง เพื่อยกเลิก'
        : 'เดินอย่างเดียว ไม่คลิกให้ — พอถึงแล้วกด 🖱 คลิกขวา ที่รายการ NPC ด้านล่างเอง';
      var p = st.pos;
      $('ctl-pos').textContent = p
        ? 'ตัวบอท: X ' + p.x + '  Y ' + p.y + '  Z ' + p.z + '  ·  หัน ' + st.dir + ' (yaw ' + st.yaw + ', pitch ' + st.pitch + ')' + (st.onGround ? '' : '  ·  ลอย/ตก') + (st.vehicle ? '  ·  นั่ง ' + st.vehicle : '') + (st.pulls10 ? '  ·  ⚠️ ถูกดึงกลับ ' + st.pulls10 + ' ครั้งใน 10 วิ' : '')
        : 'ยังไม่มีตำแหน่ง';
      var ents = st.entities || [];
      var key = ents.map(function(e){ return e.id + ':' + e.label; }).join('|');
      var box = $('ent-list');
      if (key !== CTRL.entKey) {
        CTRL.entKey = key;
        box.innerHTML = '';
        if (!ents.length) box.appendChild(uiMk('div', st.ready ? 'ไม่มี entity อยู่ใกล้ตัว (รัศมี 32 บล็อก)' : '—', 'font-size:12px;color:var(--text-dim);padding:6px 0;'));
        ents.forEach(function(e){
          var row = uiMk('div', '', ''); row.className = 'ent-row';
          row.appendChild(uiMk('span', e.label + (e.type && e.type !== e.label ? ' (' + e.type + ')' : ''), 'flex:1;word-break:break-word;'));
          var ds = uiMk('span', '', 'color:var(--text-dim);min-width:46px;text-align:right;'); ds.id = 'ent-d-' + e.id; row.appendChild(ds);
          var b1 = uiMk('button', '👀', ''); b1.className = 'btn btn-sm'; b1.title = 'หันหา';
          b1.onclick = function(){ ctrlLook({entity: e.id}); };
          var b2 = uiMk('button', '🖱 คลิกขวา', ''); b2.className = 'btn btn-sm btn-primary';
          b2.onclick = function(){ ctrlPost('/ctrl-interact', {id: e.id}); };
          row.appendChild(b1); row.appendChild(b2);
          var ps = uiMk('div', '', 'width:100%;font-size:11px;color:var(--text-dim);'); ps.id = 'ent-p-' + e.id; row.appendChild(ps);
          box.appendChild(row);
        });
      }
      ents.forEach(function(e){
        var d = $('ent-d-' + e.id); if (d) d.textContent = e.d + 'm';
        var q = $('ent-p-' + e.id); if (q) q.textContent = entPosText(e);
      });
    }
    var _ctrlTs = 0;
    function ctrlTick() {
      if (!CTRL.active) return;
      fetch('/api/ctrl/' + STATE.id).then(function(r){ return r.json(); })
        .then(function(st){ if (!st || st.error) return; if (st.ts < _ctrlTs) return; _ctrlTs = st.ts; renderCtrl(st); }).catch(function(){});
    }
    function onTabChange(name) {
      if (name !== 'control') releaseMove();
      CTRL.active = (name === 'control');
      if (CTRL.active) ctrlTick();
    }
    setInterval(ctrlTick, 600);

    renderCmds();
    update();
    setInterval(update, 2000);
    setInterval(uiPoll, 700);
  </script>
</body></html>`)
})

/* ===========================
   ERROR HANDLING & SHUTDOWN
=========================== */

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message)
  console.error(err.stack)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection:', reason?.message || reason)
})

let shuttingDown = false
process.on('SIGINT', () => {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n[SYSTEM] Shutting down gracefully...')
  bots.forEach(bot => { try { bot.stop() } catch {} })
  saveBots()
  saveServerConfig()
  console.log('[SYSTEM] Shutdown complete')
  process.exit(0)
})

process.on('SIGTERM', () => {
  process.emit('SIGINT')
})

/* ===========================
   STARTUP
=========================== */

/* ===========================
   KEEP-ALIVE (self ping)
   Hosting ฟรีบางเจ้า (Replit, Render, Railway ฯลฯ) จะ sleep ตัวเอง
   ถ้าไม่มี request เข้ามานานเกินไป — ฟังก์ชันนี้จะยิง request หา
   ตัวเองเป็นระยะเพื่อให้มี traffic ตลอดเวลา

   ตั้งค่า PUBLIC_URL เป็น URL สาธารณะของแอพ (เช่น
   https://your-app.onrender.com) ผ่าน environment variable
   ถ้าไม่ตั้ง จะ ping แค่ localhost ซึ่งช่วยได้เฉพาะบาง provider
=========================== */
const http = require('http')
const https = require('https')
const PORT = process.env.PORT || 3000

function selfPing() {
  const target = (process.env.PUBLIC_URL || 'https://galaxy-hub-1.onrender.com').replace(/\/$/, '') + '/health'

  const lib = target.startsWith('https') ? https : http
  const req = lib.get(target, { timeout: 10000 }, (res) => {
    res.resume()
  })
  req.on('error', (e) => console.error('[KEEPALIVE] Ping failed:', e.message))
  req.on('timeout', () => req.destroy())
}

setInterval(selfPing, 4 * 60 * 1000) // ทุก 4 นาที

loadServerConfig()  // โหลด server config ก่อน
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' +
    '╔════════════════════════════════════════╗\n' +
    '║   🌌 GALAXY AFK HUB v2.1              ║\n' +
    '╚════════════════════════════════════════╝\n')
  console.log('🚀 Server: http://localhost:' + PORT)
  console.log('📦 Config: bots_config.json, server_config.json')
  console.log('💡 Press Ctrl+C to stop\n')
  loadBots()
})
