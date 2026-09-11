const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const express = require('express')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

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
  defaultUsername: 'FGOP'
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
      autoCommands: b.state.autoCommands,
      chestPos: b.state.task ? b.state.task.chestPos : null
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
   AUTO-TASK DATA (mining / chopping / farming)
=========================== */

const ORE_ALIASES = {
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  lapis: ['lapis_ore', 'deepslate_lapis_ore'],
  copper: ['copper_ore', 'deepslate_copper_ore'],
  netherite: ['ancient_debris'],
  quartz: ['nether_quartz_ore']
}
const ALL_ORE_NAMES = Object.values(ORE_ALIASES).flat()

const LOG_NAMES = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'crimson_stem', 'warped_stem']

const CROP_BLOCKS = { wheat: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot: 'beetroots' }
const SEED_ITEMS = { wheat: 'wheat_seeds', carrot: 'carrot', potato: 'potato', beetroot: 'beetroot_seeds' }

const TOOL_PRIORITY = {
  pickaxe: ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'],
  axe: ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe']
}

const KEEP_ON_DEPOSIT = ['pickaxe', 'axe', 'hoe', 'sword', 'shovel', 'helmet', 'chestplate', 'leggings', 'boots', 'shield', 'bow', 'arrow', 'bread', 'cooked_', 'golden_apple']

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function resolveOreNames(target) {
  const key = (target || '').toLowerCase().trim()
  if (!key) return ALL_ORE_NAMES
  if (ORE_ALIASES[key]) return ORE_ALIASES[key]
  return [key]
}

function shouldKeepItem(itemName, extraKeep) {
  const keep = extraKeep && extraKeep.length ? KEEP_ON_DEPOSIT.concat(extraKeep) : KEEP_ON_DEPOSIT
  return keep.some(k => itemName.includes(k))
}

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
  // ✅ ข้อ 9: ลดจำนวน log สูงสุดเหลือ 100 บรรทัด
  if (state.logs.length > 100) state.logs.length = 100
}

/* ===========================
   BOT MANAGER CORE
=========================== */

function createManagedBot({ username, accountType, theme, autoLogin, loginPassword, autoCommands, chestPos }) {
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
    autoCommands: Array.isArray(autoCommands) ? autoCommands : [],
    task: {
      type: 'idle',        // idle | mining | chopping | farming
      target: null,
      running: false,
      startedAt: null,
      stats: { collected: 0, deposited: 0 },
      chestPos: chestPos && typeof chestPos.x === 'number' ? chestPos : null
    }
  }

  let bot = null
  let reconnectTimeout = null
  let autoCmdTimers = []
  let reconnectAttempts = 0
  let taskAbort = false
  const MAX_RECONNECT_ATTEMPTS = 100
  const BASE_RECONNECT_DELAY = 5000
  const MAX_RECONNECT_DELAY = 60000
  const STOPPED_STATES = new Set(['stopped', 'auth_failed', 'banned'])

  function cleanupBot() {
    taskAbort = true
    state.task.running = false
    state.task.type = 'idle'
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
      version: false,
      physicsEnabled: true,
      hideErrors: true
    }

    if (state.accountType === 'premium') {
      options.auth = 'microsoft'
    }

    try {
      bot = mineflayer.createBot(options)
      bot.loadPlugin(pathfinder)
    } catch (err) {
      state.status = 'error'
      pushLog(state, `[ERROR] Failed to create bot: ${err.message}`)
      scheduleReconnect()
      return
    }

    const connectionTimeout = setTimeout(() => {
      if (state.status === 'connecting') {
        pushLog(state, 'Connection timed out after 30s')
        cleanupBot()
        state.status = 'error'
        scheduleReconnect()
      }
    }, 30000)

    bot.once('spawn', () => {
      clearTimeout(connectionTimeout)
      state.status = 'online'
      state.connectedAt = Date.now()
      reconnectAttempts = 0
      if (bot.username && bot.username !== state.username) {
        state.username = bot.username
      }
      pushLog(state, 'Connected successfully')

      try {
        const movements = new Movements(bot)
        movements.allowSprinting = true
        movements.canDig = true
        bot.pathfinder.setMovements(movements)
      } catch (e) {
        pushLog(state, `[TASK] pathfinder setup failed: ${e.message}`)
      }
      taskAbort = false

      if (state.autoLogin && state.loginPassword) {
        setTimeout(() => {
          if (bot && state.status === 'online') {
            bot.chat(`/login ${state.loginPassword}`)
            pushLog(state, `[AUTO-LOGIN] /login ****`)
          }
        }, 2000)
      }

      setTimeout(() => {
        runAutoCommands()
      }, 2500)
    })

    bot.on('message', (jsonMsg) => {
      const msgText = stringifyMsg(jsonMsg)
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
    })

    bot.on('error', (err) => {
      clearTimeout(connectionTimeout)
      const msg = err?.message || String(err)
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

  /* ---- Auto-task engine (mining / chopping / farming / deposit) ---- */

  async function equipTool(category) {
    const priority = TOOL_PRIORITY[category]
    if (!priority) return false
    const items = bot.inventory.items()
    for (const name of priority) {
      const it = items.find(i => i.name === name)
      if (it) {
        try { await bot.equip(it, 'hand'); return true } catch { return false }
      }
    }
    return false
  }

  function isInventoryFull() {
    try { return bot.inventory.emptySlotCount() <= 1 } catch { return false }
  }

  function findChest() {
    if (!bot) return null
    if (state.task.chestPos) {
      try {
        const p = state.task.chestPos
        const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
        if (b && /chest|barrel/i.test(b.name)) return b
      } catch {}
    }
    return bot.findBlock({
      matching: b => b && /chest|barrel/i.test(b.name),
      maxDistance: 48
    })
  }

  async function depositAll(extraKeep) {
    const chestBlock = findChest()
    if (!chestBlock) {
      pushLog(state, '[TASK] No chest found nearby. Use "Set Chest Here" while standing next to one.')
      return false
    }
    try {
      pushLog(state, '[TASK] Heading to chest to deposit items...')
      await bot.pathfinder.goto(new goals.GoalGetToBlock(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z))
      if (taskAbort) return false
      const container = await bot.openContainer(chestBlock)
      const items = bot.inventory.items()
      for (const item of items) {
        if (shouldKeepItem(item.name, extraKeep)) continue
        try {
          await container.deposit(item.type, null, item.count)
          state.task.stats.deposited += item.count
        } catch (e) { /* chest full or item mismatch, skip */ }
      }
      container.close()
      pushLog(state, '[TASK] Deposit complete')
      return true
    } catch (err) {
      pushLog(state, `[TASK] Deposit failed: ${err.message}`)
      return false
    }
  }

  async function runGatherLoop(kind, blockMatcher, toolCategory) {
    state.task.type = kind
    state.task.running = true
    state.task.startedAt = Date.now()
    taskAbort = false
    pushLog(state, `[TASK] Started ${kind}`)
    let idleRounds = 0
    while (!taskAbort && bot && state.status === 'online') {
      if (isInventoryFull()) {
        await depositAll()
        if (taskAbort) break
        continue
      }
      let block = null
      try {
        block = bot.findBlock({ matching: b => b && blockMatcher(b), maxDistance: 48 })
      } catch (e) {
        pushLog(state, `[TASK] Scan error: ${e.message}`)
      }
      if (!block) {
        idleRounds++
        if (idleRounds === 1) pushLog(state, '[TASK] No target blocks nearby, waiting...')
        await sleep(5000)
        if (idleRounds > 12) { pushLog(state, '[TASK] Giving up, nothing found for a while'); break }
        continue
      }
      idleRounds = 0
      try {
        await equipTool(toolCategory)
        await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z))
        if (taskAbort) break
        await bot.dig(block)
        state.task.stats.collected++
        pushLog(state, `[TASK] Broke ${block.name} (${state.task.stats.collected} total)`)
        await sleep(350)
      } catch (err) {
        pushLog(state, `[TASK] Error: ${err.message}`)
        await sleep(2000)
      }
    }
    state.task.running = false
    state.task.type = 'idle'
    pushLog(state, `[TASK] Stopped ${kind}`)
  }

  async function runFarmLoop(cropKey) {
    const key = CROP_BLOCKS[cropKey] ? cropKey : 'wheat'
    const cropBlockName = CROP_BLOCKS[key]
    const seedName = SEED_ITEMS[key]
    state.task.type = 'farming'
    state.task.target = key
    state.task.running = true
    state.task.startedAt = Date.now()
    taskAbort = false
    pushLog(state, `[TASK] Started farming (${key})`)
    let idleRounds = 0
    while (!taskAbort && bot && state.status === 'online') {
      let block = null
      try {
        block = bot.findBlock({
          matching: b => {
            if (!b || b.name !== cropBlockName) return false
            try {
              const props = b.getProperties ? b.getProperties() : {}
              return Number(props.age) === 7
            } catch { return false }
          },
          maxDistance: 32
        })
      } catch (e) {
        pushLog(state, `[TASK] Scan error: ${e.message}`)
      }
      if (!block) {
        idleRounds++
        if (idleRounds === 1) pushLog(state, '[TASK] No mature crops right now, waiting for growth...')
        await sleep(8000)
        continue
      }
      idleRounds = 0
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z))
        if (taskAbort) break
        const pos = block.position.clone()
        await bot.dig(block)
        state.task.stats.collected++
        const seedItem = bot.inventory.items().find(i => i.name === seedName)
        const farmland = bot.blockAt(pos.offset(0, -1, 0))
        if (seedItem && farmland) {
          try {
            await bot.equip(seedItem, 'hand')
            await bot.placeBlock(farmland, new Vec3(0, 1, 0))
          } catch (e) { /* spot may already be taken */ }
        }
        pushLog(state, `[TASK] Harvested ${cropBlockName} (${state.task.stats.collected} total)`)
        if (isInventoryFull()) await depositAll([seedName])
        await sleep(400)
      } catch (err) {
        pushLog(state, `[TASK] Error: ${err.message}`)
        await sleep(2000)
      }
    }
    state.task.running = false
    state.task.type = 'idle'
    pushLog(state, '[TASK] Stopped farming')
  }

  const managed = {
    state,
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
    startTask: (type, target) => {
      if (!bot || state.status !== 'online') {
        pushLog(state, '[TASK] Bot offline, cannot start task')
        return { success: false, error: 'Bot offline' }
      }
      if (state.task.running) {
        pushLog(state, '[TASK] A task is already running. Stop it first.')
        return { success: false, error: 'Task already running' }
      }
      state.task.stats = { collected: 0, deposited: 0 }
      state.task.target = target || null
      if (type === 'mine') {
        const names = resolveOreNames(target)
        runGatherLoop('mining', b => names.includes(b.name), 'pickaxe')
          .catch(e => pushLog(state, `[TASK] crashed: ${e.message}`))
        return { success: true, msg: `Mining started: ${target || 'any ore'}` }
      }
      if (type === 'chop') {
        runGatherLoop('chopping', b => LOG_NAMES.includes(b.name), 'axe')
          .catch(e => pushLog(state, `[TASK] crashed: ${e.message}`))
        return { success: true, msg: 'Chopping started' }
      }
      if (type === 'farm') {
        runFarmLoop(target || 'wheat')
          .catch(e => pushLog(state, `[TASK] crashed: ${e.message}`))
        return { success: true, msg: `Farming started: ${target || 'wheat'}` }
      }
      return { success: false, error: 'Unknown task type' }
    },
    stopTask: () => {
      taskAbort = true
      try { bot && bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
      pushLog(state, '[TASK] Stop requested')
      return { success: true }
    },
    setChestHere: () => {
      if (!bot) return { success: false, error: 'Bot offline' }
      const block = bot.findBlock({ matching: b => b && /chest|barrel/i.test(b.name), maxDistance: 6 })
      if (block) {
        state.task.chestPos = { x: block.position.x, y: block.position.y, z: block.position.z }
        pushLog(state, `[TASK] Chest set at ${block.position}`)
        scheduleSaveBots()
        return { success: true }
      }
      pushLog(state, '[TASK] No chest found within 6 blocks of the bot')
      return { success: false, error: 'No chest nearby' }
    },
    depositNow: () => {
      if (!bot || state.status !== 'online') return { success: false, error: 'Bot offline' }
      depositAll().catch(e => pushLog(state, `[TASK] deposit error: ${e.message}`))
      return { success: true }
    },
    get bot() { return bot }
  }

  bots.set(state.id, managed)
  connect()
  scheduleSaveBots()
  return managed
}

/* ===========================
   TASK COMMAND PARSER (!mine, !chop, !farm, !stop, !setchest, !deposit)
=========================== */

function handleTaskCommand(managed, raw) {
  const parts = raw.slice(1).trim().split(/\s+/).filter(Boolean)
  const action = (parts[0] || '').toLowerCase()
  const arg = parts.slice(1).join(' ')
  switch (action) {
    case 'mine': return managed.startTask('mine', arg)
    case 'chop': case 'wood': return managed.startTask('chop')
    case 'farm': return managed.startTask('farm', arg)
    case 'stop': return managed.stopTask()
    case 'setchest': return managed.setChestHere()
    case 'deposit': return managed.depositNow()
    default: return { success: false, error: `Unknown task command: ${action}. Try mine/chop/farm/stop/setchest/deposit` }
  }
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
    health: bot?.health ?? 0,
    food: bot?.food ?? 0,
    inventory,
    autoLogin: state.autoLogin,
    loginPassword: state.loginPassword ? '********' : '',
    autoCommands: state.autoCommands,
    task: {
      type: state.task.type,
      target: state.task.target,
      running: state.task.running,
      stats: state.task.stats,
      chestPos: state.task.chestPos
    }
  })
})

app.post('/bot/:id/command', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' })
  const managed = bots.get(id)
  if (!managed) return res.status(404).json({ error: 'Bot not found' })
  const cmd = req.body.cmd?.trim()
  if (!cmd) return res.status(400).json({ error: 'Empty command' })
  if (cmd.startsWith('!')) {
    const result = handleTaskCommand(managed, cmd)
    return res.json(result)
  }
  managed.sendChat(cmd)
  res.json({ success: true })
})

app.post('/bot/:id/task', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' })
  const managed = bots.get(id)
  if (!managed) return res.status(404).json({ error: 'Bot not found' })
  const { action, target } = req.body
  let result
  if (action === 'mine') result = managed.startTask('mine', target)
  else if (action === 'chop') result = managed.startTask('chop')
  else if (action === 'farm') result = managed.startTask('farm', target)
  else if (action === 'stop') result = managed.stopTask()
  else if (action === 'setchest') result = managed.setChestHere()
  else if (action === 'deposit') result = managed.depositNow()
  else result = { success: false, error: 'Unknown action' }
  res.json(result)
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
  const { autoLogin, loginPassword, autoCommands } = req.body
  managed.state.autoLogin = autoLogin === 'true' || autoLogin === true || autoLogin === '1'
  managed.state.loginPassword = typeof loginPassword === 'string' ? loginPassword : ''
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
  const { host, port, defaultUsername } = req.body
  if (!host || !port) {
    return res.status(400).send('Host and port are required')
  }
  serverConfig.host = String(host).trim()
  serverConfig.port = Number(port) || 25565
  if (defaultUsername) serverConfig.defaultUsername = String(defaultUsername).trim()
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
      <button class="tab-btn" data-tab="chat">💬 Chat</button>
      <button class="tab-btn" data-tab="tasks">🤖 Tasks</button>
      <button class="tab-btn" data-tab="inventory">🎒 Inventory</button>
      <button class="tab-btn" data-tab="settings">⚙️ Settings</button>
    </div>

    <!-- Tab Contents -->
    <div class="tab-content active" id="tab-dashboard">
      <div style="display:flex;flex-direction:column;gap:16px;">
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

    <div class="tab-content" id="tab-tasks">
      <div class="panel" style="margin-bottom:16px;">
        <div class="section-title" style="font-size:13px;">🧠 CURRENT TASK</div>
        <div class="info-stats-row">
          <div class="info-stat">
            <div class="info-stat-label">Status</div>
            <div class="info-stat-value" id="task-status">idle</div>
          </div>
          <div class="info-stat">
            <div class="info-stat-label">Collected</div>
            <div class="info-stat-value" id="task-collected">0</div>
          </div>
          <div class="info-stat">
            <div class="info-stat-label">Deposited</div>
            <div class="info-stat-value" id="task-deposited">0</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:8px;" id="task-chest-info">Chest: not set</div>
        <button class="btn btn-danger btn-block" style="margin-top:12px;" onclick="taskAction('stop')">⏹ STOP TASK</button>
      </div>

      <div class="panel" style="margin-bottom:16px;">
        <div class="section-title" style="font-size:13px;">⛏️ MINE ORE</div>
        <div class="form-group">
          <label>Ore type</label>
          <select class="input select" id="task-mine-target">
            <option value="">Any ore</option>
            <option value="diamond">💎 Diamond</option>
            <option value="iron">🔩 Iron</option>
            <option value="gold">🟡 Gold</option>
            <option value="coal">🪨 Coal</option>
            <option value="redstone">🔴 Redstone</option>
            <option value="emerald">💚 Emerald</option>
            <option value="lapis">🔷 Lapis</option>
            <option value="copper">🟠 Copper</option>
            <option value="quartz">🔷 Quartz (Nether)</option>
            <option value="netherite">🖤 Ancient Debris</option>
          </select>
        </div>
        <button class="btn btn-primary btn-block" onclick="taskAction('mine', document.getElementById('task-mine-target').value)">▶ START MINING</button>
      </div>

      <div class="panel" style="margin-bottom:16px;">
        <div class="section-title" style="font-size:13px;">🪓 CHOP WOOD</div>
        <button class="btn btn-primary btn-block" onclick="taskAction('chop')">▶ START CHOPPING</button>
      </div>

      <div class="panel" style="margin-bottom:16px;">
        <div class="section-title" style="font-size:13px;">🌾 FARM</div>
        <div class="form-group">
          <label>Crop</label>
          <select class="input select" id="task-farm-target">
            <option value="wheat">🌾 Wheat</option>
            <option value="carrot">🥕 Carrot</option>
            <option value="potato">🥔 Potato</option>
            <option value="beetroot">🌱 Beetroot</option>
          </select>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">The bot harvests mature crops and replants automatically. Farmland + existing crops are required.</div>
        <button class="btn btn-primary btn-block" onclick="taskAction('farm', document.getElementById('task-farm-target').value)">▶ START FARMING</button>
      </div>

      <div class="panel">
        <div class="section-title" style="font-size:13px;">📦 STORAGE CHEST</div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">Stand the bot right next to a chest or barrel, then set it as the drop-off point. Mining/chopping/farming will auto-deposit there when the inventory is full.</div>
        <button class="btn btn-warning btn-block" style="margin-bottom:8px;" onclick="taskAction('setchest')">📍 SET CHEST HERE</button>
        <button class="btn btn-warning btn-block" onclick="taskAction('deposit')">📤 DEPOSIT NOW</button>
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
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🔐 Auto Login</div>
          <div class="toggle-wrap" style="margin-bottom:10px;">
            <label class="toggle">
              <input type="checkbox" id="toggle-autologin" ${state.autoLogin ? 'checked' : ''} onchange="onToggleLogin(this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label" id="autologin-label">${state.autoLogin ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div id="login-pass-wrap" style="display:${state.autoLogin ? 'flex' : 'none'};gap:8px;align-items:center;">
            <input class="input input-sm" id="login-password" type="password" placeholder="Login password..." value="${escapedPass}" style="flex:1;" />
            <button class="btn btn-sm btn-primary" onclick="saveSettings()">Save</button>
          </div>
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

    function saveSettings() {
      var password = document.getElementById('login-password').value;
      fetch('/bot/' + STATE.id + '/settings', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({autoLogin:STATE.autoLoginOn,loginPassword:password,autoCommands:STATE.autoCommands})
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

          if (data.task) {
            var statusEl = document.getElementById('task-status');
            var collEl = document.getElementById('task-collected');
            var depEl = document.getElementById('task-deposited');
            var chestEl = document.getElementById('task-chest-info');
            if (statusEl) statusEl.textContent = data.task.running ? (data.task.type + (data.task.target ? ' (' + data.task.target + ')' : '')) : 'idle';
            if (collEl) collEl.textContent = (data.task.stats && data.task.stats.collected) || 0;
            if (depEl) depEl.textContent = (data.task.stats && data.task.stats.deposited) || 0;
            if (chestEl) chestEl.textContent = data.task.chestPos ? ('Chest: ' + data.task.chestPos.x + ', ' + data.task.chestPos.y + ', ' + data.task.chestPos.z) : 'Chest: not set';
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

    function taskAction(action, target) {
      fetch('/bot/' + STATE.id + '/task', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({action: action, target: target || ''})
      }).then(function(r){return r.json();}).then(function(data){
        if (data && data.success === false) {
          showToast('⚠️ ' + (data.error || 'Failed'));
        } else {
          showToast('✅ ' + (data && data.msg ? data.msg : 'Done'));
        }
        setTimeout(update, 300);
      }).catch(function(){ showToast('⚠️ Request failed'); });
    }

    function setTheme(key) {
      fetch('/bot/' + STATE.id + '/theme', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({theme:key})
      }).then(function(){location.reload();});
    }

    renderCmds();
    update();
    setInterval(update, 2000);
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

const PORT = process.env.PORT || 3000
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