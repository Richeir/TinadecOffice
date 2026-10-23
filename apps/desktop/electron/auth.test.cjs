'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

/**
 * The reported bug: a Desktop launch always asked the user to sign in again. The session lived
 * only in this process, and the Core child that owns it was restarted by the same launch.
 */
let tmpRoot = ''
let encryptionAvailable = true
const openedUrls = []

const Module = require('node:module')
const originalLoad = Module._load

function stubElectron(request) {
  if (request !== 'electron') return undefined
  return {
    app: { getPath: () => tmpRoot },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (buffer) => {
        const text = buffer.toString('utf8')
        if (!text.startsWith('enc:')) throw new Error('cannot decrypt')
        return text.slice(4)
      },
    },
    shell: { openExternal: async (url) => { openedUrls.push(url) } },
  }
}

/** The module keeps per-process state, so every test loads a fresh copy with electron stubbed. */
function loadAuth() {
  Module._load = function (request, parent, isMain) {
    const stub = stubElectron(request)
    return stub ?? originalLoad.call(this, request, parent, isMain)
  }
  try {
    delete require.cache[require.resolve('./auth.cjs')]
    return require('./auth.cjs')
  } finally {
    Module._load = originalLoad
  }
}

function sessionPath() {
  return path.join(tmpRoot, 'auth', 'session.bin')
}

async function writeStoredSession(token, identity) {
  const file = sessionPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const payload = JSON.stringify({ v: 1, token, identity })
  await fs.writeFile(file, Buffer.from(`enc:${payload}`, 'utf8'))
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

test.beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tinadec-auth-'))
  encryptionAvailable = true
  openedUrls.length = 0
  delete globalThis.fetch
})

test.afterEach(async () => {
  delete globalThis.fetch
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('a fresh profile is signed out', () => {
  const auth = loadAuth()
  assert.deepEqual(auth.getAuthState(), { loggedIn: false })
})

test('a stored session is restored on the next launch', async () => {
  await writeStoredSession('token-1', { sub: 'sub-1', nickname: 'Ada', avatar_url: null, email: 'ada@example.com' })
  globalThis.fetch = async () => jsonResponse({ subject: 'sub-1', nickname: 'Ada', avatar_url: null, email: 'ada@example.com' })

  const auth = loadAuth()
  const state = auth.getAuthState()

  assert.equal(state.loggedIn, true)
  assert.equal(state.nickname, 'Ada')
  await auth.__validationForTests()
})

test('a rejected session is cleared from memory and from disk', async () => {
  await writeStoredSession('token-1', { sub: 'sub-1', nickname: 'Ada', avatar_url: null, email: null })
  globalThis.fetch = async () => jsonResponse({ code: 'unauthorized' }, 401)

  const auth = loadAuth()
  assert.equal(auth.getAuthState().loggedIn, true)
  await auth.__validationForTests()

  assert.equal(auth.getAuthState().loggedIn, false)
  await assert.rejects(() => fs.stat(sessionPath()), /ENOENT/)
})

test('a validated session refreshes the cached profile from Core', async () => {
  await writeStoredSession('token-1', { sub: 'sub-1', nickname: 'Ada', avatar_url: null, email: null })
  globalThis.fetch = async () => jsonResponse({ subject: 'sub-1', nickname: 'Ada Lovelace', avatar_url: 'https://a', email: 'ada@example.com' })

  const auth = loadAuth()
  auth.getAuthState()
  await auth.__validationForTests()

  const state = auth.getAuthState()
  assert.equal(state.nickname, 'Ada Lovelace')
  assert.equal(state.avatar_url, 'https://a')
})

test('a gateway that is not listening does not throw the session away', async () => {
  await writeStoredSession('token-1', { sub: 'sub-1', nickname: 'Ada', avatar_url: null, email: null })
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }

  const auth = loadAuth()
  auth.getAuthState()
  await auth.__validationForTests()

  // The cached identity survives; the next launch tries again.
  assert.equal(auth.getAuthState().loggedIn, true)
  const file = await fs.stat(sessionPath())
  assert.ok(file.size > 0)
})

test('logging in persists the session, and logging out removes it', async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith('/auth/begin')) return jsonResponse({ state: 'state-1', authorize_url: 'https://logto.example/authorize' })
    if (url.includes('/auth/check')) return jsonResponse({ status: 'complete', session: 'token-9' })
    if (url.endsWith('/auth/me')) return jsonResponse({ subject: 'sub-9', nickname: 'Grace', avatar_url: null, email: null })
    if (url.endsWith('/auth/logout')) return jsonResponse({}, 204)
    throw new Error(`unexpected ${url}`)
  }

  const auth = loadAuth()
  const identity = await auth.openLogin()

  assert.equal(identity.nickname, 'Grace')
  assert.equal(openedUrls.length, 1)
  await fs.stat(sessionPath())

  await auth.logout()
  assert.equal(auth.getAuthState().loggedIn, false)
  await assert.rejects(() => fs.stat(sessionPath()), /ENOENT/)
})

test('without an OS keyring the session is not written in plaintext', async () => {
  encryptionAvailable = false
  globalThis.fetch = async (url) => {
    if (url.endsWith('/auth/begin')) return jsonResponse({ state: 'state-1', authorize_url: 'https://logto.example/authorize' })
    if (url.includes('/auth/check')) return jsonResponse({ status: 'complete', session: 'token-9' })
    if (url.endsWith('/auth/me')) return jsonResponse({ subject: 'sub-9', nickname: 'Grace', avatar_url: null, email: null })
    throw new Error(`unexpected ${url}`)
  }

  const auth = loadAuth()
  await auth.openLogin()

  assert.equal(auth.getAuthState().loggedIn, true)
  await assert.rejects(() => fs.stat(sessionPath()), /ENOENT/)
})
