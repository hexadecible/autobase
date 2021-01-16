const p = require('path')
const test = require('tape')
const ram = require('random-access-memory')
const Corestore = require('corestore')
const Omega = require('omega')
const Sandbox = require('module-sandbox')
const Hyperbee = require('hyperbee')
const LatencyStream = require('latency-stream')
const { toPromises } = require('hypercore-promisifier')
const { NanoresourcePromise: Nanoresource } = require('nanoresource-promise/emitter')

const { IndexNode } = require('../lib/nodes')
const Autobase = require('..')

const INDEXER_MACHINE_DIR = p.join(__dirname, 'machines', 'indexer')
const { Op } = require(p.join(INDEXER_MACHINE_DIR, 'messages.js'))

class ReducerMachine extends Nanoresource {
  constructor (output, codePath, opts = {}) {
    super()
    this.output = output
    this.machine = new Sandbox(codePath, {
      ...opts,
      hostcalls: this._generateHostcalls()
    })
    this.extensions = new Map()
    this.peers = new Map()
    this.peersById = new Map()
    this.ready = this.open.bind(this)

    this._peerCount = 0
    this._listeners = new Map([
      ['peer-add', this.onpeeradd.bind(this)],
      ['peer-remove', this.onpeerremove.bind(this)]
    ])
  }

  // Nanoresource Methods

  async _open () {
    await this.machine.ready()
    await this.machine.rpc.init()
    for (const [name, func] of this._listeners) this.output.on(name, func)
  }

  async _close () {
    await this.machine.close()
    for (const [name, func] of this._listeners) this.output.removeListener(name, func)
  }

  // Output Listeners

  onpeeradd (peer) {
    this._peerCount++
    const id = this._generatePeerId(peer)
    this.peers.set(peer, id)
    this.peersById.set(id, peer)
    this.machine.rpc.onpeeradd(id)
  }

  onpeerremove (peer) {
    const id = this._generatePeerId(peer)
    this.peers.delete(peer)
    this.peersById.delete(id)
    this.machine.rpc.onpeerremove(id)
  }

  // Private Methods

  _generatePeerId (peer) {
    // TODO: Need to have a unique identifier per peer.
    return this._peerCount
  }

  _generateHostcalls () {
    const get = async (_, idx) => {
      const node = await this.output.get(idx)
      return IndexNode.decode(node).value
    }
    const registerExtension = (_, name) => {
      if (this.extensions.has(name)) throw new Error('Extension already registered with that name.')
      this.extensions.set(name, this.output.registerExtension(name, {
        onmessage: (msg, peer) => {
          const peerId = this.peers.get(peer)
          if (!peerId) return
          this.machine.rpc.onextension(name, msg, peerId)
        }
      }))
    }
    const sendExtension = (_, name, msg, peer) => {
      msg = Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength)
      const ext = this.extensions.get(name)
      if (!ext) return
      return ext.send(msg, this.peersById.get(peer))
    }
    const broadcastExtension = (_, name, msg) => {
      msg = Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength)
      const ext = this.extensions.get(name)
      if (!ext) return
      return ext.broadcast(msg)
    }
    const destroyExtension = (_, name) => {
      const ext = this.extensions.get(name)
      if (!ext) return
      ext.destroy()
      this.extensions.delete(name)
    }
    return {
      get,
      registerExtension,
      sendExtension,
      broadcastExtension,
      destroyExtension
    }
  }

  // Public API

  async ready () {
    if (this._ready) return
    this._ready = true
    await this.machine.ready()
    await this.machine.rpc.init()
  }

  async reduce (node) {
    const indexState = {
      length: this.output.length,
      byteLength: this.output.byteLength
    }
    const blocks = await this.machine.rpc.reduce(indexState, node)
    return blocks.map(b => Buffer.from(b.buffer, b.byteOffset, b.byteLength))
  }
}

test('hyperbee indexer example', async t => {
  const store = new Corestore(ram)
  const output = new Omega(ram)
  const writerA = toPromises(store.get({ name: 'writer-a' }))
  const writerB = toPromises(store.get({ name: 'writer-b' }))
  const base = new Autobase([writerA, writerB])

  const db = new Hyperbee(createReadProxy(output), {
    keyEncoding: 'utf-8',
    extension: false,
    readonly: true
  })
  await db.ready()

  await base.append(writerA, Op.encode({
    type: Op.Type.Put,
    key: 'hello',
    value: 'world'
  }))

  await base.append(writerB, Op.encode({
    type: Op.Type.Put,
    key: 'another',
    value: 'other'
  }))

  // This put will be causally-dependent on writerA's first put to 'hello'
  // So the final kv-pair should be 'hello' -> 'other'
  await base.append(writerB, Op.encode({
    type: Op.Type.Put,
    key: 'hello',
    value: 'other'
  }), await base.latest())

  const reducer = new ReducerMachine(output, p.join(INDEXER_MACHINE_DIR, 'index.js'))
  await reducer.ready()
  await base.localRebase(output, {
    map: reducer.reduce.bind(reducer)
  })

  console.log('\n ========== \n')
  console.log('All Hyperbee Nodes:\n')

  for await (const { key, value } of db.createReadStream()) {
    console.log(`${key} -> ${value}`)
  }

  await reducer.close()
  t.end()
})

test('hyperbee indexer with extension', async t => {
  const store = new Corestore(ram)
  const output1 = new Omega(ram)
  const writerA = toPromises(store.get({ name: 'writer-a' }))
  const writerB = toPromises(store.get({ name: 'writer-b' }))
  const base = new Autobase([writerA, writerB])

  await base.append(writerA, Op.encode({
    type: Op.Type.Put,
    key: 'hello',
    value: 'world'
  }))

  await base.append(writerB, Op.encode({
    type: Op.Type.Put,
    key: 'another',
    value: 'other'
  }))

  // Let's fill up the Hyperbee with many messages
  for (let i = 0; i < 100; i++) {
    await base.append(writerB, Op.encode({
      type: Op.Type.Put,
      key: `${i}-hello`,
      value: `${i}-other`
    }), await base.latest())
  }

  const reducer = new ReducerMachine(output1, p.join(INDEXER_MACHINE_DIR, 'index.js'))
  await reducer.ready()
  await base.localRebase(output1, {
    map: reducer.reduce.bind(reducer)
  })

  // This reader will simulate request latency, and will not have the extension enabled.
  {
    const output2 = new Omega(ram, output1.key)
    const s1 = output2.replicate()
    s1.pipe(new LatencyStream(50)).pipe(output1.replicate()).pipe(s1)

    // Now this "remote" Hyperbee should swarm
    const db = new Hyperbee(createReadProxy(output2), {
      keyEncoding: 'utf-8',
      readonly: true,
      extension: false
    })
    await db.ready()

    console.time('no-extension')
    await drain(db.createReadStream())
    console.timeEnd('no-extension')
  }

  // This reader will simulate request latency, and will have the extension enabled.
  {
    const output2 = new Omega(ram, output1.key)
    const s1 = output2.replicate()
    s1.pipe(new LatencyStream(50)).pipe(output1.replicate()).pipe(s1)

    // Now this "remote" Hyperbee should swarm
    const db = new Hyperbee(createReadProxy(output2), {
      keyEncoding: 'utf-8',
      readonly: true
    })
    await db.ready()

    console.time('with-extension')
    await drain(db.createReadStream())
    console.timeEnd('with-extension')
  }

  console.log()

  await reducer.close()
  t.end()
})

// TODO: This is a temporary hack.
function createReadProxy (output) {
  return new Proxy(output, {
    get (target, prop) {
      if (prop !== 'get') return target[prop]
      return async (idx, opts) => {
        const block = await target.get(idx, opts)
        let val = IndexNode.decode(block).value
        if (opts.valueEncoding) val = opts.valueEncoding.decode(val)
        return val
      }
    }
  })
}

async function drain (stream) {
  return new Promise(resolve => {
    stream.on('data', () => { })
    stream.on('end', resolve)
  })
}