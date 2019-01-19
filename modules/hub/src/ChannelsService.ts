import { convertWithdrawal } from './vendor/client/types'
import { hasPendingOps } from './vendor/client/hasPendingOps'
import log from './util/log'
import ChannelsDao from './dao/ChannelsDao'
import Config from './Config'
import ThreadsDao from './dao/ThreadsDao'
import { BigNumber } from 'bignumber.js'
import {
  channelStateUpdateRowBigNumToString,
  channelRowBigNumToString,
  ChannelRow,
  ChannelStateUpdateRowBigNum,
} from './domain/Channel'
import { Validator } from './vendor/client/validator'
import ExchangeRateDao from './dao/ExchangeRateDao'
import { Big, toWeiBigNum } from './util/bigNumber'
import { ThreadStateUpdateRow } from './domain/Thread'
import { RedisClient } from './RedisClient'
import { ChannelManager } from './ChannelManager'
import {
  ChannelStateUpdate,
  UnsignedChannelState,
  DepositArgs,
  WithdrawalArgs,
  ExchangeArgs,
  convertChannelState,
  convertThreadState,
  ThreadState,
  convertPayment,
  PaymentArgs,
  UpdateRequestBigNumber,
  UpdateRequest,
  ChannelStateBigNumber,
  SyncResult,
  WithdrawalParametersBigNumber,
  ChannelStateBN,
  InvalidationArgs,
  Sync
} from './vendor/client/types'
import { prettySafeJson, Omit } from './util'
import { OnchainTransactionService } from './OnchainTransactionService';
import DBEngine from './DBEngine';
import ThreadsService from './ThreadsService';
import { SignerService } from './SignerService';
import { OnchainTransactionRow } from './domain/OnchainTransaction';
import ChannelDisputesDao from './dao/ChannelDisputesDao';
import { assertUnreachable } from './util/assertUnreachable';
import { StateGenerator } from './vendor/client/StateGenerator';

const LOG = log('ChannelsService') as any

export type RedisUnsignedUpdate = {
  update: Omit<ChannelStateUpdate, 'state'>
  timestamp: number
}


export default class ChannelsService {
  constructor(
    private onchainTxService: OnchainTransactionService,
    private threadsService: ThreadsService,
    private signerService: SignerService,
    private channelsDao: ChannelsDao,
    private threadsDao: ThreadsDao,
    private exchangeRateDao: ExchangeRateDao,
    private channelDisputesDao: ChannelDisputesDao,
    private generator: StateGenerator,
    private validator: Validator,
    private redis: RedisClient,
    private db: DBEngine,
    private config: Config,
    private contract: ChannelManager,
  ) {}

  public async doRequestDeposit(
    user: string,
    depositWei: BigNumber,
    depositToken: BigNumber,
    sigUser: string,
  ): Promise<string | null> {
    const channel = await this.channelsDao.getChannelOrInitialState(user)
    const channelStateStr = convertChannelState("str", channel.state)

    // channel checks
    if (channel.status !== 'CS_OPEN') {
      throw new Error(
        `doRequestDeposit: cannot deposit into a non-open channel: ${prettySafeJson(
          channel,
        )}`,
      )
    }

    // assert user signed parameters
    this.validator.assertDepositRequestSigner({
      amountToken: depositToken.toString(),
      amountWei: depositWei.toString(),
      sigUser,
    }, user)

    if (hasPendingOps(channelStateStr)) {
      LOG.info(
        `User requested a deposit while state already has pending operations ` +
        `(user: ${user}; current state: ${JSON.stringify(channelStateStr)})`
      )
      return 'current state has pending fields'
    }

    const nowSeconds = Math.floor(Date.now() / 1000)

    // if the last update has a timeout that expired, that means it wasn't confirmed on chain
    // TODO REB-12: This is incorrect; the timeout needs to be compared to
    // the latest block timestamp, not Date.now()
    if (channel.state.timeout && nowSeconds <= channel.state.timeout) {
      LOG.info('Pending update has not expired yet: {channel}, doing nothing', {
        channel,
      })
      return
    }

    // TEST: do a user deposit, user posts to chain without sending hub proposepending update siguser
    // TODO: check contract balance? what to do if its low?
    const currentExchangeRate = await this.exchangeRateDao.latest()
    if (currentExchangeRate.retrievedAt < Date.now() - 1000 * 60 * 60 * 24) {
      throw new Error(
        `Hub's latest exchange rate (${prettySafeJson(currentExchangeRate)}) ` +
        `is more than 24 hours old; refusing to use it.`,
      )
    }
    const currentExchangeRateBigNum = currentExchangeRate.rates['USD']

    // equivalent token amount to deposit based on booty amount
    const bootyRequestToDeposit = currentExchangeRateBigNum
      .times(depositWei)
      .floor()

    const userBootyCurrentlyInChannel = await this.channelsDao.getTotalChannelTokensPlusThreadBonds(
      user,
    )

    const totalChannelRequestedBooty = bootyRequestToDeposit
      .plus(userBootyCurrentlyInChannel)
      .plus(channel.state.balanceTokenHub)

    const hubBootyDeposit = BigNumber.max(0, (
      bootyRequestToDeposit.isLessThanOrEqualTo(channel.state.balanceTokenHub) ?
        // if we already have enough booty to collateralize the user channel, dont deposit
        Big(0) :

      totalChannelRequestedBooty.isGreaterThan(this.config.channelBeiDeposit) ?
        // if total channel booty plus new additions exceeds limit, only fund up to the limit
        this.config.channelBeiDeposit
          .minus(userBootyCurrentlyInChannel)
          .minus(channel.state.balanceTokenHub) :
          // fund the up to the amount the user put in
          bootyRequestToDeposit.minus(channel.state.balanceTokenHub)
    ))

    const depositArgs: DepositArgs = {
      depositWeiHub: '0',
      depositWeiUser: depositWei.toFixed(),
      depositTokenHub: hubBootyDeposit.toFixed(),
      depositTokenUser: depositToken.toFixed(),
      timeout: Math.floor(Date.now() / 1000) + 5 * 60,
      sigUser,
    }

    const channelStateWithDeposits = this.validator.generateProposePendingDeposit(
      channelStateStr,
      depositArgs
    )

    const signedChannelStateWithDeposits = await this.signerService.signChannelState(channelStateWithDeposits)

    // save to db (create if doesnt exist)
    await this.channelsDao.applyUpdateByUser(
      user,
      'ProposePendingDeposit',
      user,
      signedChannelStateWithDeposits,
      depositArgs
    )

    // wallet is expected to request exchange after submitting and confirming this deposit on chain
  }

  /**
   * Returns two numbers `minAmount` and `maxAmount`. If the hub's BOOTY
   * balance falls under the `minAmount`, then it should be brought up to
   * `maxAmount` to ensure there is sufficient collateral.
   */
  public async calculateCollateralizationTargets(state: ChannelStateBigNumber) {
    const numTippers = await this.channelsDao.getRecentTippers(state.user)
    const baseTarget = Big(numTippers).times(this.config.threadBeiLimit)
    const baseMin = numTippers > 0 ?
      this.config.beiMinCollateralization :
      toWeiBigNum(10)

    return {
      minAmount: BigNumber.max(baseMin, baseTarget).times(0.5),

      maxAmount: BigNumber.min(
        this.config.beiMaxCollateralization,

        BigNumber.max(
          baseMin,
          baseTarget.times(2.5),
        ),
      ),

      hasRecentPayments: numTippers > 0,
    }
  }

  public async doCollateralizeIfNecessary(
    user: string
  ): Promise<DepositArgs | null> {
    const channel = await this.channelsDao.getChannelOrInitialState(user)

    // channel checks
    if (channel.status !== 'CS_OPEN') {
      LOG.error(`channel: ${channel}`)
      throw new Error('Channel is not open')
    }

    if (
      !channel.state.pendingDepositWeiHub.isZero() ||
      !channel.state.pendingDepositWeiUser.isZero() ||
      !channel.state.pendingDepositTokenUser.isZero() ||
      !channel.state.pendingDepositTokenHub.isZero() ||
      !channel.state.pendingWithdrawalWeiHub.isZero() ||
      !channel.state.pendingWithdrawalWeiUser.isZero() ||
      !channel.state.pendingWithdrawalTokenHub.isZero() ||
      !channel.state.pendingWithdrawalTokenUser.isZero()
    ) {
      LOG.info(`Pending operation exists, will not recollateralize, channel: ${prettySafeJson(channel)}`)
      return null
    }

    const currentPendingRedis = await this.redisGetUnsignedState(user)
    if (currentPendingRedis) {
      const age = (Date.now() - currentPendingRedis.timestamp) / 1000
      if (age < 60) {
        LOG.info(
          `Current pending recollateralization or withdrawal is only ` +
          `${age.toFixed()}s old; will not recollateralize until that's ` +
          `more than 60s old.`
        )
        return
      }
    }

    const targets = await this.calculateCollateralizationTargets(channel.state)

    // 1. If there is more booty in the channel than the maxAmount, then
    // withdraw down to that.
    if (channel.state.balanceTokenHub.isGreaterThan(targets.maxAmount)) {
      // NOTE: Since we don't have a way to do non-blocking withdrawals, do
      // nothing now... but in the future this should withdraw.
      return null
    }

    // 2. If the amount is between the minAmount and the maxAmount, do nothing.
    if (channel.state.balanceTokenHub.isGreaterThan(targets.minAmount)) {
      return null
    }

    // 3. Otherwise, deposit the appropriate amount
    const amountToCollateralize = targets.maxAmount.minus(channel.state.balanceTokenHub)

    LOG.info('Recollateralizing {user} with {amountToCollateralize} BOOTY', {
      user,
      amountToCollateralize: amountToCollateralize.div('1e18').toFixed(),
    })

    const depositArgs: DepositArgs = {
      depositWeiHub: '0',
      depositWeiUser: '0',
      depositTokenHub: amountToCollateralize.toFixed(),
      depositTokenUser: '0',
      timeout: 0,
      sigUser: null,
    }

    await this.redisSaveUnsignedState(user, {
      args: depositArgs,
      reason: 'ProposePendingDeposit'
    })
    return depositArgs
  }

  public async doRequestWithdrawal(
    user: string,
    params: WithdrawalParametersBigNumber,
  ): Promise<WithdrawalArgs | null> {
    const channel = await this.channelsDao.getChannelByUser(user)
    if (!channel || channel.status !== 'CS_OPEN') {
      throw new Error(
        `withdraw: Channel is not in the correct state: ` +
        `${prettySafeJson(channel)}`,
      )
    }

    params = {
      ...params,
      weiToSell: params.weiToSell || new BigNumber(0),
      withdrawalTokenUser: params.withdrawalTokenUser || new BigNumber(0),
    }

    if (!params.weiToSell.isZero() || !params.withdrawalTokenUser.isZero()) {
      throw new Error(
        `Hub is not able to facilitate user exchanging wei for tokens, or withdrawing tokens.`
      )
    }

    // get exchange rate
    const currentExchangeRate = await this.exchangeRateDao.latest()
    if (currentExchangeRate.retrievedAt < Date.now() - 1000 * 60 * 60 * 24) {
      throw new Error(
        `Hub's latest exchange rate (${prettySafeJson(currentExchangeRate)}) ` +
        `is more than 24 hours old; refusing to use it.`,
      )
    }
    const currentExchangeRateBigNum = currentExchangeRate.rates['USD']
    const proposedExchangeRateBigNum = new BigNumber(params.exchangeRate)
    const exchangeRateDelta = currentExchangeRateBigNum.minus(proposedExchangeRateBigNum).abs()
    const allowableDelta = currentExchangeRateBigNum.times(0.02)
    if (exchangeRateDelta.gt(allowableDelta)) {
      throw new Error(
        `Proposed exchange rate (${params.exchangeRate}) differs from current ` +
        `rate (${currentExchangeRateBigNum.toFixed()}) by ${exchangeRateDelta.toString()} ` +
        `which is more than the allowable delta of ${allowableDelta.toString()}`
      )
    }

    // if user is leaving some wei in the channel, leave an equivalent amount of booty
    const newBalanceWeiUser = channel.state.balanceWeiUser.minus(params.withdrawalWeiUser)
    const hubBootyTargetForExchange = BigNumber.min(
      newBalanceWeiUser.times(proposedExchangeRateBigNum).floor(),
      this.config.channelBeiLimit,
    )

    // If the user has recent payments in the channel, make sure they are
    // collateralized up to their maximum amount.
    const collatTargets = await this.calculateCollateralizationTargets(channel.state)
    const hubBootyTargetForCollat = (
      collatTargets.hasRecentPayments ?
        collatTargets.maxAmount :
        Big(0)
    )

    const hubBootyTarget = BigNumber.max(
      hubBootyTargetForExchange,
      hubBootyTargetForCollat,
    )

    const withdrawalArgs: WithdrawalArgs = {
      seller: 'user',
      exchangeRate: proposedExchangeRateBigNum.toFixed(),
      tokensToSell: params.tokensToSell.toFixed(),
      weiToSell: '0',

      recipient: params.recipient,

      targetWeiUser: channel.state.balanceWeiUser
        .minus(params.withdrawalWeiUser)
        .minus(params.weiToSell)
        .toFixed(),

      targetTokenUser: channel.state.balanceTokenUser
        .minus(params.withdrawalTokenUser)
        .minus(params.tokensToSell)
        .toFixed(),

      targetWeiHub: '0',
      targetTokenHub: hubBootyTarget.toFixed(),

      additionalWeiHubToUser: '0',
      additionalTokenHubToUser: '0',

      timeout: Math.floor(Date.now() / 1000) + (5 * 60),
    }

    const state = this.generator.proposePendingWithdrawal(
      convertChannelState('bn', channel.state),
      convertWithdrawal('bn', withdrawalArgs),
    )
    const minWithdrawalAmount = Big('1e13')
    const sufficientPendingArgs = (
      Object.entries(state).filter(([key, val]: [string, string]) => {
        if (!key.startsWith('pending'))
          return false
        return minWithdrawalAmount.isLessThan(val)
      })
    )
    if (sufficientPendingArgs.length == 0) {
      LOG.info(
        `All pending values in withdrawal are below minimum withdrawal ` +
        `threshold (${minWithdrawalAmount.toFixed}): ` +
        `params: ${params}; ` +
        `new state: ${JSON.stringify(state)} ` +
        `(withdrawal will be ignored)`
      )
      return null
    }

    await this.redisSaveUnsignedState(user, {
      reason: 'ProposePendingWithdrawal',
      args: withdrawalArgs,
    })

    return withdrawalArgs
  }

  protected adjustExchangeAmount(
    reqAmount: BigNumber,
    exchangeRate: BigNumber,
    hubBalance: BigNumber,
    otherLimit?: BigNumber,
  ) {
    let limit = hubBalance
    if (otherLimit)
      limit = BigNumber.min(limit, otherLimit)

    const exchangeLimit = limit.div(exchangeRate).floor()
    return BigNumber.min(reqAmount, exchangeLimit).toFixed()
  }

  public async doRequestExchange(
    user: string,
    weiToSell: BigNumber,
    tokensToSell: BigNumber,
  ): Promise<ExchangeArgs | null> {
    const channel = await this.channelsDao.getChannelOrInitialState(user)

    // channel checks
    if (!channel || channel.status !== 'CS_OPEN') {
      LOG.error(`channel: ${channel}`)
      throw new Error('Channel does not exist or is not open')
    }

    // check if we already have an unsigned request pending
    const res = await this.redisGetUnsignedState(user)
    let existingUnsigned = res && res.update
    if (existingUnsigned) {
      throw new Error(
        `Pending unsigned request already exists, please sync to receive unsigned state: ${existingUnsigned}`,
      )
    }

    // get latest exchange rate
    const currentExchangeRate = await this.exchangeRateDao.latest()
    if (currentExchangeRate.retrievedAt < Date.now() - 1000 * 60 * 60 * 24) {
      throw new Error(
        `Hub's latest exchange rate (${prettySafeJson(currentExchangeRate)}) ` +
        `is more than 24 hours old; refusing to use it.`,
      )
    }
    const currentExchangeRateBigNum = currentExchangeRate.rates['USD']

    const bootyLimit = BigNumber.min(
      BigNumber.max(0, channel.state.balanceTokenHub.minus(currentExchangeRateBigNum.floor())),
    )
    const weiToBootyLimit = (
      bootyLimit
        .div(currentExchangeRateBigNum)
        .ceil()
    )
    const adjustedWeiToSell = BigNumber.min(weiToSell, weiToBootyLimit)

    const exchangeArgs: ExchangeArgs = {
      seller: 'user',
      exchangeRate: currentExchangeRateBigNum.toFixed(),
      weiToSell: this.adjustExchangeAmount(
        weiToSell,
        currentExchangeRateBigNum,
        channel.state.balanceTokenHub,
        BigNumber.max(0, this.config.channelBeiDeposit.minus(channel.state.balanceTokenUser)),
      ),
      tokensToSell: this.adjustExchangeAmount(
        tokensToSell,
        Big(1).div(currentExchangeRateBigNum),
        channel.state.balanceWeiHub,
      ),
    }

    if (exchangeArgs.weiToSell == '0' && exchangeArgs.tokensToSell == '0')
      return null

    await this.redisSaveUnsignedState(user, {
      args: exchangeArgs,
      reason: 'Exchange',
    })

    return exchangeArgs
  }

  public async doUpdates(
    user: string,
    updates: (UpdateRequestBigNumber | null)[],
  ): Promise<ChannelStateUpdateRowBigNum[]> {
    const rows = []
    for (const update of updates) {
      rows.push(await this.db.withTransaction(() => this.doUpdateFromWithinTransaction(user, update)))
    }

    return rows
  }

  public async doUpdateFromWithinTransaction(
    user: string,
    update: UpdateRequestBigNumber
  ): Promise<ChannelStateUpdateRowBigNum | null> {
    const channel = await this.channelsDao.getChannelOrInitialState(user)

    // channel status checks
    if (channel && channel.status !== 'CS_OPEN') {
      throw new Error('Channel is not open, channel: ${channel}')
    }

    let signedChannelStatePrevious = convertChannelState(
      'bn',
      channel.state,
    )

    // need to account for the case where channel does not exist
    // i.e. performer onboarding would be request-collateral =>
    // hub returns unsigned ProposePending update, then user signs and sends
    // back to here. in this case, channel would not exist yet
    // signedChannelStatePrevious would equal the initial state in this case

    // use hub's version of the update to recreate the sig, if we have it
    // we won't have it for unsigned updates, we will have it in redis
    const hubsVersionOfUpdate = await this.channelsDao.getChannelUpdateByTxCount(
      user,
      update.txCount,
    )

    console.log('USER:', user)
    console.log('CM:', this.config.channelManagerAddress)
    console.log('CURRENT:', channel)
    console.log('UPDATE:', update)
    console.log('HUB VER:', hubsVersionOfUpdate)

    if (hubsVersionOfUpdate) {
      if (
        hubsVersionOfUpdate.state.sigHub &&
        hubsVersionOfUpdate.state.sigUser
      ) {
        if (update.sigUser !== hubsVersionOfUpdate.state.sigUser) {
          throw new Error(
            `Hub version of update sigs do not match provided sigs: 
            Hub version of update: ${prettySafeJson(hubsVersionOfUpdate)}, 
            provided update: ${prettySafeJson(update)}}`,
          )
        }
        // we already have a double signed version, do nothing
        return hubsVersionOfUpdate
      }

      // validate user sig against what we think the last update is
      // this will happen in ConfirmPending:
      // chainsaw saves update to db
      // user calls sync -> hub responds with hub-signed ConfirmPending update
      // user countersigns and sends back here

      const signedChannelStateHub = convertChannelState(
        'str',
        hubsVersionOfUpdate.state,
      )

      console.log('HUB SIGNED:', signedChannelStateHub)

      // verify user sig on hub's data
      this.validator.assertChannelSigner({
        ...signedChannelStateHub,
        sigUser: update.sigUser,
      })

      // if hub signed already, save and continue
      if (signedChannelStateHub.sigHub) {
        return (await this.channelsDao.applyUpdateByUser(
          user,
          update.reason,
          user,
          { ...signedChannelStateHub, sigUser: update.sigUser },
          update.args
        ))
      }
    }

    let redisUpdate: ChannelStateUpdate
    let unsignedChannelStateCurrent: UnsignedChannelState
    let sigHub: string

    switch (update.reason) {
      case 'Payment':
        unsignedChannelStateCurrent = this.validator.generateChannelPayment(
          convertChannelState("str", signedChannelStatePrevious),
          convertPayment('str', update.args as PaymentArgs)
        )
        this.validator.assertChannelSigner({
          ...unsignedChannelStateCurrent,
          sigUser: update.sigUser
        })
        sigHub = await this.signerService.getSigForChannelState(unsignedChannelStateCurrent)
        return await this.channelsDao.applyUpdateByUser(
          user,
          update.reason,
          user,
          { ...unsignedChannelStateCurrent, sigUser: update.sigUser, sigHub },
          update.args
        )

      // for the following, the validation is slightly different, since we proposed an update previously,
      // we just need to make sure the unsigned update we proposed is signed by them
      case 'ProposePendingWithdrawal':
      case 'ProposePendingDeposit':
        // HUB AUTHORIZED UPDATE
        // deposit -
        // performer requests collateral -> hub responds with unsigned update
        // performer signs and sends back here, which is where we are now
        // withdrawal -
        // user requests withdrawal -> hub responds with unsigned update
        // user signs and sends back here, which is where we are now
        redisUpdate = await this.loadAndCheckRedisStateSignature(
          user,
          signedChannelStatePrevious,
          update,
        )
        if (!redisUpdate)
          return null

        // dont await so we can do this in the background
        LOG.info(`Calling hubAuthorizedUpdate with: ${JSON.stringify([
          user,
          redisUpdate.state.recipient,
          [redisUpdate.state.balanceWeiHub, redisUpdate.state.balanceWeiUser],
          [redisUpdate.state.balanceTokenHub, redisUpdate.state.balanceTokenUser],
          [
            redisUpdate.state.pendingDepositWeiHub,
            redisUpdate.state.pendingWithdrawalWeiHub,
            redisUpdate.state.pendingDepositWeiUser,
            redisUpdate.state.pendingWithdrawalWeiUser,
          ],
          [
            redisUpdate.state.pendingDepositTokenHub,
            redisUpdate.state.pendingWithdrawalTokenHub,
            redisUpdate.state.pendingDepositTokenUser,
            redisUpdate.state.pendingWithdrawalTokenUser,
          ],
          [redisUpdate.state.txCountGlobal, redisUpdate.state.txCountChain],
          redisUpdate.state.threadRoot,
          redisUpdate.state.threadCount,
          redisUpdate.state.timeout,
          redisUpdate.state.sigUser,
        ])}`)

        let data = this.contract.methods.hubAuthorizedUpdate(
          user,
          redisUpdate.state.recipient,
          [redisUpdate.state.balanceWeiHub, redisUpdate.state.balanceWeiUser],
          [redisUpdate.state.balanceTokenHub, redisUpdate.state.balanceTokenUser],
          [
            redisUpdate.state.pendingDepositWeiHub,
            redisUpdate.state.pendingWithdrawalWeiHub,
            redisUpdate.state.pendingDepositWeiUser,
            redisUpdate.state.pendingWithdrawalWeiUser,
          ],
          [
            redisUpdate.state.pendingDepositTokenHub,
            redisUpdate.state.pendingWithdrawalTokenHub,
            redisUpdate.state.pendingDepositTokenUser,
            redisUpdate.state.pendingWithdrawalTokenUser,
          ],
          [redisUpdate.state.txCountGlobal, redisUpdate.state.txCountChain],
          redisUpdate.state.threadRoot,
          redisUpdate.state.threadCount,
          redisUpdate.state.timeout,
          redisUpdate.state.sigUser,
        ).encodeABI()

        let txn = await this.onchainTxService.sendTransaction(this.db, {
          from: this.config.hotWalletAddress,
          to: this.config.channelManagerAddress,
          data,
          meta: {
            completeCallback: 'ChannelsService.invalidateUpdate',
            args: {
              user,
              lastInvalidTxCount: redisUpdate.state.txCountGlobal
            }
          }
        })

        return await this.saveRedisStateUpdate(
          user,
          redisUpdate,
          update,
          txn.logicalId,
        )

      case 'Exchange':
        // ensure users cant hold exchanges
        redisUpdate = await this.loadAndCheckRedisStateSignature(
          user,
          signedChannelStatePrevious,
          update,
        )
        if (!redisUpdate)
          return null

        return await this.saveRedisStateUpdate(user, redisUpdate, update)

      case 'Invalidation':
        const lastStateNoPendingOps = await this.channelsDao.getLastStateNoPendingOps(user)

        const latestBlock = await this.signerService.getLatestBlock()

        // make sure there is no pending timeout
        if (signedChannelStatePrevious.timeout && latestBlock.timestamp <= signedChannelStatePrevious.timeout) {
          LOG.info('Cannot invalidate update with timeout that hasnt expired, lastStateNoPendingOps: {lastStateNoPendingOps}, block: {latestBlock}', {
            lastStateNoPendingOps,
            latestBlock
          })
          return
        }
        // TODO REB-12: make sure that event has not made it to chain. This
        // is currently being done by the client, but should be moved into
        // the validator so it's part of the validation here too.
        unsignedChannelStateCurrent = this.validator.generateInvalidation(
          convertChannelState('str', lastStateNoPendingOps.state),
          update.args as InvalidationArgs
        )
        this.validator.assertChannelSigner({
          ...unsignedChannelStateCurrent,
          sigUser: update.sigUser
        })
        sigHub = await this.signerService.getSigForChannelState(unsignedChannelStateCurrent)
        const u = await this.channelsDao.applyUpdateByUser(
          user,
          update.reason,
          user,
          { ...unsignedChannelStateCurrent, sigUser: update.sigUser, sigHub },
          update.args
        )
        await this.channelsDao.invalidateUpdates(user, update.args as InvalidationArgs)
        return u

      case 'OpenThread':
        // will store unsigned state in redis for the next sync response
        await this.doCollateralizeIfNecessary((update.args as ThreadState).receiver)
        return await this.threadsService.open(
          convertThreadState('bignumber', update.args as ThreadState),
          update.sigUser
        )

      case 'CloseThread':
        return await this.threadsService.close(
          (update.args as ThreadState).sender,
          (update.args as ThreadState).receiver,
          update.sigUser,
          user === (update.args as ThreadState).sender
        )

      // below cases don't need additional validation and will already be
      // hub signed, so we shouldn't get here
      case 'ConfirmPending':
      default:
        throw new Error(
          `We should never have gotten here.
          update: ${prettySafeJson(update)}`,
        )
    }
  }

  public async getChannelAndThreadUpdatesForSync(
    user: string,
    channelTxCount: number,
    lastThreadUpdateId: number,
  ): Promise<Sync> {
    const channel = await this.channelsDao.getChannelOrInitialState(user)
    console.log('channel: ', channel);
    const channelUpdates = await this.channelsDao.getChannelUpdatesForSync(
      user,
      channelTxCount,
    )

    console.log("RESULT:", JSON.stringify(channelUpdates, null, 2))

    const threadUpdates = await this.threadsDao.getThreadUpdatesForSync(
      user,
      lastThreadUpdateId,
    )

    let curChan = 0
    let curThread = 0

    const res: SyncResult[] = []
    const pushChannel = (update: UpdateRequest) => res.push({ type: 'channel', update })
    const pushThread = (update: ThreadStateUpdateRow) => res.push({ type: 'thread', update })

    while (
      curChan < channelUpdates.length ||
      curThread < threadUpdates.length
    ) {
      const chan = channelUpdates[curChan]
      const thread = threadUpdates[curThread]

      const pushChan =
        chan &&
        (!thread ||
          chan.createdOn < thread.createdOn ||
          (chan.createdOn == thread.createdOn && chan.reason == 'OpenThread'))

      if (pushChan) {
        curChan += 1
        pushChannel({
          args: chan.args,
          reason: chan.reason,
          sigUser: chan.state.sigUser,
          sigHub: chan.state.sigHub,
          txCount: chan.state.txCountGlobal,
          createdOn: chan.createdOn,
          id: chan.id
        })
      } else {
        curThread += 1
        pushThread({
          ...thread,
          state: convertThreadState('str', thread.state),
        })
      }
    }

    // push unsigned state to end of the sync stack, txCount will be ignored when processing
    const unsigned = await this.redisGetUnsignedState(user)
    if (unsigned) {
      pushChannel({
        id: -unsigned.timestamp,
        args: unsigned.update.args,
        reason: unsigned.update.reason,
        txCount: null
      })
    }

    return { status: channel.status, updates: res }
  }

  public async getChannel(user: string): Promise<ChannelRow | null> {
    const res = await this.channelsDao.getChannelByUser(user)

    if (!res) {
      return null
    }

    return channelRowBigNumToString(res)
  }

  public async getChannelUpdateByTxCount(
    user: string,
    txCount: number,
  ): Promise<ChannelStateUpdate> {
    return channelStateUpdateRowBigNumToString(
      await this.channelsDao.getChannelUpdateByTxCount(user, txCount),
    )
  }

  public async redisGetUnsignedState(
    user: string,
  ): Promise<RedisUnsignedUpdate | null> {
    const unsignedUpdate = await this.redis.get(`PendingStateUpdate:${user}`)
    return unsignedUpdate ? JSON.parse(unsignedUpdate) : null
  }

  private async redisSaveUnsignedState(user: string, update: Omit<ChannelStateUpdate, 'state'>) {
    const redis = await this.redis.set(
      `PendingStateUpdate:${user}`,
      JSON.stringify({ update, timestamp: Date.now() }),
      ['EX', 5 * 60],
    )
  }

  // public for tests
  public async redisDeleteUnsignedState(user: string) {
    this.redis.del(`PendingStateUpdate:${user}`)
  }

  private async loadAndCheckRedisStateSignature(
    user: string,
    currentState: ChannelStateBN,
    update: UpdateRequestBigNumber,
  ): Promise<ChannelStateUpdate | null> {
    const fromRedis = await this.redisGetUnsignedState(user)
    if (!fromRedis) {
      LOG.info(
        `Hub could not retrieve the unsigned update, possibly expired or sent twice? ` +
        `user update: ${prettySafeJson(update)}`
      )
      return null
    }

    if (update.txCount != currentState.txCountGlobal + 1) {
      throw new Error(
        `Half-signed ${update.reason} from client has out-of-date txCount ` +
        `(update.txCount: ${update.txCount}, ` +
        `expected: ${currentState.txCountGlobal + 1}); ` +
        `update: ${prettySafeJson(update)}`
      )
    }

    const unsigned = await this.validator.generateChannelStateFromRequest(
      convertChannelState('str', currentState),
      {
        args: fromRedis.update.args,
        reason: fromRedis.update.reason,
        txCount: currentState.txCountGlobal + 1
      }
    )

    const signed = {
      ...unsigned,
      sigUser: update.sigUser,
    }

    // validate that user sig matches our unsigned update that we proposed
    this.validator.assertChannelSigner(signed)

    return {
      ...fromRedis.update,
      state: signed,
    }
  }

  private async saveRedisStateUpdate(
    user: string,
    redisUpdate: ChannelStateUpdate,
    update: UpdateRequestBigNumber,
    txnId?: number,
  ) {
    await this.db.onTransactionCommit(async () => await this.redisDeleteUnsignedState(user))

    const sigHub = await this.signerService.getSigForChannelState(redisUpdate.state)

    return await this.channelsDao.applyUpdateByUser(
      user,
      update.reason,
      user,
      { ...redisUpdate.state, sigUser: update.sigUser, sigHub },
      update.args,
      null,
      txnId
    )
  }

  // callback function for OnchainTransactionService
  private async invalidateUpdate(txn: OnchainTransactionRow): Promise<ChannelStateUpdateRowBigNum> {
    if (txn.state !== 'failed') {
      LOG.info(`Transaction completed, no need to invalidate`)
      return
    }
    LOG.info(`Txn failed, proposing an invalidating update, txn: ${prettySafeJson(txn)}`)
    const { user, lastInvalidTxCount } = txn.meta.args
    const lastValidState = await this.channelsDao.getLastStateNoPendingOps(user)
    const invalidationArgs: InvalidationArgs = {
      lastInvalidTxCount,
      previousValidTxCount: lastValidState.state.txCountGlobal,
      reason: 'CU_INVALID_ERROR',
      message: `Transaction failed: ${prettySafeJson(txn)}`,
    }
    const unsignedState = this.validator.generateInvalidation(
      convertChannelState('str', lastValidState.state),
      invalidationArgs
    )
    const sigHub = await this.signerService.getSigForChannelState(unsignedState)
    return await this.channelsDao.applyUpdateByUser(
      user,
      'Invalidation',
      user,
      { ...unsignedState, sigHub },
      invalidationArgs,
    )
  }
}
