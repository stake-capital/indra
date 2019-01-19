import { default as Config } from '../Config'
import { convertWithdrawalParameters } from '../vendor/client/types'
import { UpdateRequest } from '../vendor/client/types'
import * as express from 'express'
import { ApiService } from './ApiService'
import log from '../util/log'
import ChannelsService from '../ChannelsService'
import { default as ChannelsDao } from '../dao/ChannelsDao'
import { Big } from '../util/bigNumber'
import { prettySafeJson } from '../util'
import { Role } from '../Role'

const LOG = log('ChannelsApiService')

export default class ChannelsApiService extends ApiService<
  ChannelsApiServiceHandler
  > {
  namespace = 'channel'
  routes = {
    'POST /:user/request-deposit': 'doRequestDeposit',
    'POST /:user/request-collateralization': 'doRequestCollateral',
    'POST /:user/update': 'doUpdate',
    'POST /:user/request-exchange': 'doRequestExchange',
    'POST /:user/request-withdrawal': 'doRequestWithdrawal',
    'GET /:user/sync': 'doSync', // params: lastChanTx=1&lastThreadUpdateId=2
    'GET /:user/debug': 'doGetChannelDebug',
    'GET /:user': 'doGetChannelByUser',
  }
  handler = ChannelsApiServiceHandler
  dependencies = {
    channelsService: 'ChannelsService',
    dao: 'ChannelsDao',
    config: 'Config',
  }
}

export class ChannelsApiServiceHandler {
  channelsService: ChannelsService
  dao: ChannelsDao
  config: Config

  private getUser(req: express.Request) {
    const { user } = req.params
    const hasAccess = (
      (user && user == req.session!.address) ||
      req.session!.roles.has(Role.ADMIN) ||
      req.session!.roles.has(Role.SERVICE)
    )

    if (!hasAccess) {
      throw new Error(
        `Current user '${req.session!.address}' with roles ` +
        `'${JSON.stringify(Array.from(req.session!.roles))}' is not ` +
        `authorized to act on behalf of requested user '${user}'.`
      )
    }
    return user
  }

  async doUpdate(req: express.Request, res: express.Response) {
    const user = this.getUser(req)
    const { updates, lastThreadUpdateId } = req.body as {
      updates: UpdateRequest[]
      lastThreadUpdateId: number
    }
    if (!updates || !user || !Number.isInteger(lastThreadUpdateId)) {
      LOG.warn(
        'Received invalid update state request. Aborting. Body received: {body}, Params received: {params}',
        {
          body: JSON.stringify(req.body),
          params: JSON.stringify(req.params),
        },
      )
      return res.sendStatus(400)
    }

    if (!updates.length) {
      res.send({
        error: null,
        updates: [],
        msg: 'Did not recieve any updates.',
      })
      return
    }

    const sortedUpdates = updates
      .concat()
      .sort((a, b) => a.txCount - b.txCount)

    let err = null

    try {
      await this.channelsService.doUpdates(user, sortedUpdates)
    } catch (e) {
      LOG.error(`Error in doUpdate('${user}', ${prettySafeJson(updates)}): ${e}\n${e.stack}`)
      err = e
    }

    const syncUpdates = await this.channelsService.getChannelAndThreadUpdatesForSync(
      user,
      sortedUpdates[0].txCount - 1,
      lastThreadUpdateId,
    )

    res.send({
      error: err ? '' + err + (this.config.isDev ? '\n' + err.stack : '') : null,
      updates: syncUpdates,
    })
  }

  async doRequestDeposit(req: express.Request, res: express.Response) {
    const user = this.getUser(req)
    let { depositWei, depositToken, lastChanTx, lastThreadUpdateId, sigUser } = req.body
    if (!depositWei || !depositToken || !user || !sigUser || !Number.isInteger(lastChanTx) || !Number.isInteger(lastThreadUpdateId)) {
      LOG.warn(
        'Received invalid user deposit request. Aborting. Body received: {body}, Params received: {params}',
        {
          body: JSON.stringify(req.body),
          params: JSON.stringify(req.params),
        },
      )
      return res.sendStatus(400)
    }

    const err = await this.channelsService.doRequestDeposit(
      user,
      Big(depositWei),
      Big(depositToken),
      sigUser,
    )
    if (err) {
      res.status(400)
      res.send({ error: err })
      return
    }

    const updates = await this.channelsService.getChannelAndThreadUpdatesForSync(
      user,
      lastChanTx,
      0,
    )
    res.send(updates)
  }

  async doRequestCollateral(req: express.Request, res: express.Response) {
    const { user } = req.params
    const { lastChanTx } = req.body


    if (!user) {
      LOG.warn(
        'Received invalid collateral request. Aborting. Body received: {body}, Params received: {params}',
        {
          body: JSON.stringify(req.body),
          params: JSON.stringify(req.params),
        },
      )
      return res.sendStatus(400)
    }

    await this.channelsService.doCollateralizeIfNecessary(user)
    const updates = await this.channelsService.getChannelAndThreadUpdatesForSync(
      user,
      lastChanTx,
      0,
    )
    res.send(updates)
  }

  async doRequestExchange(req: express.Request, res: express.Response) {
    const { user } = req.params
    let { weiToSell, tokensToSell, lastChanTx } = req.body


    if (!user || !weiToSell || !tokensToSell) {
      LOG.warn(
        'Received invalid exchange request. Aborting. Body received: {body}, Params received: {params}',
        {
          body: JSON.stringify(req.body),
          params: JSON.stringify(req.params),
        },
      )
      return res.sendStatus(400)
    }

    await this.channelsService.doRequestExchange(
      user,
      Big(weiToSell),
      Big(tokensToSell),
    )
    const updates = await this.channelsService.getChannelAndThreadUpdatesForSync(
      user,
      lastChanTx,
      0,
    )
    res.send(updates)
  }

  async doRequestWithdrawal(req: express.Request, res: express.Response) {
    const { user } = req.params
    const { tokensToSell, weiToSell, recipient, withdrawalWeiUser, withdrawalTokenUser, lastChanTx } = req.body

    if (!user || !withdrawalWeiUser || !recipient || !tokensToSell) {
      LOG.warn(
        'Received invalid withdrawal request. Aborting. Body received: {body}, Params received: {params}',
        {
          body: JSON.stringify(req.body),
          params: JSON.stringify(req.params),
        },
      )
      return res.sendStatus(400)
    }

    await this.channelsService.doRequestWithdrawal(
      user,
      convertWithdrawalParameters("bignumber", req.body)
    )
    const updates = await this.channelsService.getChannelAndThreadUpdatesForSync(
      user,
      lastChanTx,
      0,
    )
    res.send(updates)
  }

  async doSync(req: express.Request, res: express.Response) {
    let { lastChanTx, lastThreadUpdateId } = req.query
    let { user } = req.params

    if (
      !user ||
      !Number.isInteger(parseInt(lastChanTx)) ||
      !Number.isInteger(parseInt(lastThreadUpdateId))
    ) {
      LOG.warn(
        'Received invalid sync request. Aborting. Params received: {params}, Query received: {query}',
        {
          params: JSON.stringify(req.params),
          query: JSON.stringify(req.query),
        },
      )
      return res.sendStatus(400)
    }

    let syncUpdates = await this.channelsService.getChannelAndThreadUpdatesForSync(
      user,
      parseInt(lastChanTx),
      parseInt(lastThreadUpdateId),
    )

    res.send(syncUpdates)
  }

  async doGetChannelByUser(req: express.Request, res: express.Response) {
    const user = this.getUser(req)
    if (!user) {
      LOG.warn(
        'Receiver invalid get channel request. Aborting. Params received: {params}',
        {
          params: JSON.stringify(req.params),
        },
      )
      return res.sendStatus(400)
    }

    const channel = await this.channelsService.getChannel(user)
    if (!channel) {
      return res.sendStatus(404)
    }

    res.send(channel)
  }

  async doGetChannelDebug(req: express.Request, res: express.Response) {
    const user = this.getUser(req)
    const channel = await this.dao.getChannelOrInitialState(user)
    const { updates: recentUpdates } = await this.channelsService.getChannelAndThreadUpdatesForSync(
      user,
      Math.max(0, channel.state.txCountGlobal - 10),
      0, // TODO REB-36: enable threads
    )
    res.send({
      channel,
      recentUpdates: recentUpdates.reverse(),
    })
  }
}
