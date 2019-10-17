'use strict'

const log = require('debug')('ipfs:components:init')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const mergeOptions = require('merge-options')
const promisify = require('promisify-es6')
const getDefaultConfig = require('../runtime/config-nodejs.js')
const createRepo = require('../runtime/repo-nodejs')
const Keychain = require('libp2p-keychain')
const NoKeychain = require('../components/no-keychain')
const GCLock = require('../components/pin/gc-lock')
const { DAGNode } = require('ipld-dag-pb')
const UnixFs = require('ipfs-unixfs')
const multicodec = require('multicodec')
const multiaddr = require('multiaddr')
const {
  ERR_ALREADY_INITIALIZING,
  ERR_ALREADY_INITIALIZED,
  ERR_NOT_STARTED
} = require('../../errors')
const BlockService = require('ipfs-block-service')
const Ipld = require('ipld')
const getDefaultIpldOptions = require('../runtime/ipld-nodejs')
const createPreloader = require('./preload')
const { ERR_REPO_NOT_INITIALIZED } = require('ipfs-repo').errors
const IPNS = require('../ipns')
const OfflineDatastore = require('../ipns/routing/offline-datastore')
const initAssets = require('../runtime/init-assets-nodejs')
const Components = require('.')
const PinManager = require('../components/pin/pin-manager')

module.exports = ({
  apiManager,
  print,
  constructorOptions
}) => async function init (options) {
  const { cancel } = apiManager.update({ init: ERR_ALREADY_INITIALIZING })

  try {
    options = mergeOptions({}, options, constructorOptions.init)

    if (constructorOptions.pass) {
      options.pass = constructorOptions.pass
    }

    if (constructorOptions.config) {
      options.config = constructorOptions.config
    }

    const repo = typeof options.repo === 'string' || options.repo == null
      ? createRepo(options.repo)
      : options.repo

    let isInitialized = true

    if (repo.closed) {
      try {
        await repo.open()
      } catch (err) {
        if (err.code === ERR_REPO_NOT_INITIALIZED) {
          isInitialized = false
        } else {
          throw err
        }
      }
    }

    const { peerId, config, keychain } = isInitialized
      ? await initExistingRepo(repo, options)
      : await initNewRepo(repo, options)

    log('peer created')
    const peerInfo = new PeerInfo(peerId)

    if (config.Addresses && config.Addresses.Swarm) {
      config.Addresses.Swarm.forEach(addr => {
        let ma = multiaddr(addr)

        if (ma.getPeerId()) {
          ma = ma.encapsulate(`/p2p/${peerInfo.id.toB58String()}`)
        }

        peerInfo.multiaddrs.add(ma)
      })
    }

    const blockService = new BlockService(repo)
    const ipld = new Ipld(getDefaultIpldOptions(blockService, constructorOptions.ipld, log))

    const preload = createPreloader(constructorOptions.preload)
    await preload.start()

    const gcLock = new GCLock(constructorOptions.repoOwner, {
      // Make sure GCLock is specific to repo, for tests where there are
      // multiple instances of IPFS
      morticeId: repo.path
    })

    const dag = Components.legacy.dag({ _ipld: ipld, _preload: preload })
    const object = Components.legacy.object({ _ipld: ipld, _preload: preload, dag, _gcLock: gcLock })

    const pinManager = new PinManager(repo, dag)
    await pinManager.load()

    const pin = Components.legacy.pin({ _ipld: ipld, _preload: preload, object, _repo: repo, _pinManager: pinManager })
    const add = Components.add({ ipld, dag, preload, pin, gcLock, constructorOptions })

    if (!isInitialized && !options.emptyRepo) {
      // add empty unixfs dir object (go-ipfs assumes this exists)
      const emptyDirCid = await addEmptyDir({ dag })

      log('adding default assets')
      await initAssets({ add, print })

      log('initializing IPNS keyspace')
      // Setup the offline routing for IPNS.
      // This is primarily used for offline ipns modifications, such as the initializeKeyspace feature.
      const offlineDatastore = new OfflineDatastore(repo)
      const ipns = new IPNS(offlineDatastore, repo.datastore, peerInfo, keychain, { pass: options.pass })
      await ipns.initializeKeyspace(peerId.privKey.bytes, emptyDirCid.toString())
    }

    const api = createApi({
      add,
      apiManager,
      constructorOptions,
      blockService,
      gcLock,
      initOptions: options,
      ipld,
      keychain,
      peerInfo,
      pinManager,
      preload,
      print,
      repo
    })

    apiManager.update(api, ERR_NOT_STARTED)
  } catch (err) {
    cancel()
    throw err
  }

  return apiManager.api
}

async function initNewRepo (repo, { privateKey, emptyRepo, bits, profiles, config, pass, print }) {
  emptyRepo = emptyRepo || false
  bits = bits == null ? 2048 : Number(bits)

  config = mergeOptions(getDefaultConfig(), config)
  config = applyProfiles(profiles, config)

  // Verify repo does not exist yet
  const exists = await repo.exists()
  log('repo exists?', exists)

  if (exists === true) {
    throw new Error('repo already exists')
  }

  const peerId = await createPeerId({ privateKey, bits, print })
  let keychain = new NoKeychain()

  log('identity generated')

  config.Identity = {
    PeerID: peerId.toB58String(),
    PrivKey: peerId.privKey.bytes.toString('base64')
  }

  privateKey = peerId.privKey

  config.Keychain = Keychain.generateOptions()

  log('peer identity: %s', config.Identity.PeerID)

  await repo.init(config)
  await repo.open()

  log('repo opened')

  if (pass) {
    log('creating keychain')
    const keychainOptions = { passPhrase: pass, ...config.Keychain }
    keychain = new Keychain(repo.keys, keychainOptions)
    await keychain.importPeer('self', { privKey: privateKey })
  }

  return { peerId, keychain, config }
}

async function initExistingRepo (repo, { config: newConfig, profiles, pass }) {
  let config = await repo.config.get()

  if (newConfig || profiles) {
    if (newConfig) {
      config = mergeOptions(config, newConfig)
    }
    if (profiles) {
      config = applyProfiles(profiles, config)
    }
    await repo.config.set(config)
  }

  let keychain = new NoKeychain()

  if (pass) {
    const keychainOptions = { passPhrase: pass, ...config.Keychain }
    keychain = new Keychain(repo.keys, keychainOptions)
    log('keychain constructed')
  }

  const peerId = await promisify(PeerId.createFromPrivKey)(config.Identity.PrivKey)

  // Import the private key as 'self', if needed.
  if (pass) {
    try {
      await keychain.findKeyByName('self')
    } catch (err) {
      log('Creating "self" key')
      await keychain.importPeer('self', peerId)
    }
  }

  return { peerId, keychain, config }
}

function createPeerId ({ privateKey, bits, print }) {
  if (privateKey) {
    log('using user-supplied private-key')
    return typeof privateKey === 'object'
      ? privateKey
      : promisify(PeerId.createFromPrivKey)(Buffer.from(privateKey, 'base64'))
  } else {
    // Generate peer identity keypair + transform to desired format + add to config.
    print('generating %s-bit RSA keypair...', bits)
    return promisify(PeerId.create)({ bits })
  }
}

async function addEmptyDir ({ dag }) {
  const node = new DAGNode(new UnixFs('directory').marshal())
  return dag.put(node, {
    version: 0,
    format: multicodec.DAG_PB,
    hashAlg: multicodec.SHA2_256
  })
}

// Apply profiles (e.g. ['server', 'lowpower']) to config
function applyProfiles (profiles, config) {
  return (profiles || []).reduce((name, config) => {
    const profile = Components.legacy.config.profiles[name]
    if (!profile) {
      throw new Error(`No profile with name '${name}'`)
    }
    log('applying profile %s', name)
    return profile.transform(config)
  })
}

function createApi ({
  add,
  apiManager,
  constructorOptions,
  blockService,
  gcLock,
  initOptions,
  ipld,
  keychain,
  peerInfo,
  pinManager,
  preload,
  print,
  repo
}) {
  const start = Components.start({
    apiManager,
    constructorOptions,
    blockService,
    gcLock,
    initOptions,
    ipld,
    keychain,
    peerInfo,
    pinManager,
    preload,
    print,
    repo
  })

  const api = {
    add,
    init: ERR_ALREADY_INITIALIZED,
    start
  }

  return api
}