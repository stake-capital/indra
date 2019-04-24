import * as sinon from 'sinon'
import * as uuid from 'uuid'
import { assert } from 'chai'
import { MemoryCRAuthManager } from './CRAuthManager'
import { SinonStub } from 'sinon'

const sandbox = sinon.createSandbox()

describe('MemoryCRAuthManager', () => {
  const ADDRESS = '0x627306090abab3a6e1400e9345bc60c78a8bef57'
  const NONCE = '7c965885-407a-4637-95cb-797dd9a8d8a2'
  const ORIGIN = 'google.com'
  const SIGNATURE = '0x79bb1114e4f4830865887ad145dee447f9c7a948b199ec288486edfd7772e63e71d1feccf68b62557058538be1e8aa1967b386fdbd01c503405f1e9a1df6c2f51c'
  const INVALID_SIGNATURE = '0x8bfc718f6402bc3a40aae4d5d54602d586f7c8c4514ceb6ef78023398943131b76a15459e7406c5562fda0274a48d87c5820af961111ac5fa3e70fbeb31ac4f31c'

  const OLD_ADDRESS = '0x0108d76118d97b88aa40167064cb242fa391effa'
  const OLD_SIGNATURE = '0x01613cc7bc53acf9a8b4bbfd1db267826840c8d7e086b56e302a7ec2bde6202a3295432aaf2a97304b05316d23e1854e8ed4f0eefd8c2f65cdeae15d331404c71c'

  let mcrm: MemoryCRAuthManager

  beforeEach(() => {
    sandbox.stub(Date, 'now').returns(1)
    sandbox.stub(uuid, 'v4').returns(NONCE)
    // no provider needed since we're only using sha3
    mcrm = new MemoryCRAuthManager()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('#checkSignature', () => {
    beforeEach(() => {
      return mcrm.generateNonce()
    })

    // TODO: remove
    it('should return the address for valid challenges (Legacy)', async () => {
      const res = await mcrm.checkSignature(OLD_ADDRESS, NONCE, ORIGIN, OLD_SIGNATURE)
      assert.strictEqual(res, OLD_ADDRESS)
    })

    it('should return the address for valid challenges', async () => {
      const res = await mcrm.checkSignature(ADDRESS, NONCE, ORIGIN, SIGNATURE)
      assert.strictEqual(res, ADDRESS)
    })

    it('should return null for non-existent challenges', async () => {
      const res = await mcrm.checkSignature(
        ADDRESS,
        'nope-nonce',
        ORIGIN,
        SIGNATURE,
      )
      assert.isNull(res)
    })

    it('should return null for invalid signatures', async () => {
      let res = await mcrm.checkSignature(
        ADDRESS,
        NONCE,
        ORIGIN,
        INVALID_SIGNATURE,
      )
      assert.isNull(res)
      res = await mcrm.checkSignature(ADDRESS, NONCE, ORIGIN, 'notsig')
      assert.isNull(res)
    })

    it('should return null for expired nonces', async () => {
      ;(Date.now as SinonStub).returns(Number.MAX_VALUE)
      const res = await mcrm.checkSignature(ADDRESS, NONCE, ORIGIN, SIGNATURE)
      assert.isNull(res)
    })
  })
})
