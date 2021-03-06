const log4js = require('tms-koa/node_modules/@log4js-node/log4js-api')
const logger = log4js.getLogger('tms-koa-plugins')
const Router = require('tms-koa/node_modules/koa-router')
const _ = require('tms-koa/node_modules/lodash')
const jwt = require('tms-koa/node_modules/jsonwebtoken')
const fs = require('fs')
const path = require('path')

const appConfig = loadConfig('app')
const trustedHosts = loadConfig('trusted-hosts') || {}
// const { RequestTransaction } = require('tms-koa/lib/model/transaction')
/**
 * 获得配置数据
 */
function loadConfig(name, defaultConfig) {
  let basepath = path.resolve('config', `${name}.js`)

  let baseConfig
  if (fs.existsSync(basepath)) {
    baseConfig = require(basepath)
    logger.info(`从[${basepath}]加载配置`)
  } else {
    logger.warn(`[${name}]配置文件[${basepath}]不存在`)
  }
  let localpath = path.resolve('config', `${name}.local.js`)
  let localConfig
  if (fs.existsSync(localpath)) {
    localConfig = require(localpath)
    logger.info(`从[${localpath}]加载本地配置`)
  }
  if (defaultConfig || baseConfig || localConfig) {
    return _.merge({}, defaultConfig, baseConfig, localConfig)
  }

  return false
}
/**
 *
 */
function findCtrlClassInControllers(ctrlName, path) {
  // 从控制器路径查找
  let ctrlPath = process.cwd() + `/plugins/${ctrlName}.js`
  if (!fs.existsSync(ctrlPath)) {
    ctrlPath = process.cwd() + `/plugins/${ctrlName}/main.js`
    if (!fs.existsSync(ctrlPath)) {
      let logMsg = `参数错误，请求的控制器不存在(2)`
      logger.isDebugEnabled()
        ? logger.debug(logMsg, path, ctrlPath)
        : logger.error(logMsg)
      throw new Error(logMsg)
    }
  }

  const CtrlClass = require(ctrlPath)

  return CtrlClass
}
/**
 *
 */
function findCtrlClassAndMethodName(ctx) {
  let { path } = ctx.request

  if (prefix) path = path.replace(prefix, '')

  let pieces = path.split('/').filter((p) => p)
  if (pieces.length === 0) {
    let logMsg = '参数错误，请求的控制器不存在(1)'
    logger.isDebugEnabled()
      ? logger.debug(logMsg, path, pieces)
      : logger.error(logMsg)
    throw new Error(logMsg)
  }
  let CtrlClass
  const method = pieces.splice(-1, 1)[0]
  const ctrlName = pieces.length ? pieces.join('/') : 'main'
  const npmCtrls = _.get(appConfig, 'router.plugins.plugins_npm')
  let npmCtrl
  if (Array.isArray(npmCtrls) && npmCtrls.length) {
    npmCtrl = npmCtrls.find((nc) =>
      new RegExp(`${nc.alias}|${nc.id}`).test(ctrlName.split('/')[0])
    )
  }
  if (npmCtrl) {
    try {
      // 先检查是否存在包
      if (ctrlName.split('/')[0] === npmCtrl.alias) {
        CtrlClass = require(ctrlName.replace(npmCtrl.alias, npmCtrl.id))
      } else {
        CtrlClass = require(ctrlName)
      }
    } catch (e) {
      // 从控制器路径查找
      CtrlClass = findCtrlClassInControllers(ctrlName, path)
    }
  } else {
    // 从控制器路径查找
    CtrlClass = findCtrlClassInControllers(ctrlName, path)
  }

  return [ctrlName, CtrlClass, method]
}
/**
 * 获得请求中传递的access_token
 */
function getAccessTokenByRequest(ctx) {
  let access_token
  let { request } = ctx
  let { authorization } = ctx.header
  if (authorization && authorization.indexOf('Bearer') === 0) {
    access_token = authorization.match(/\S+$/)[0]
  } else if (request.query.access_token) {
    access_token = request.query.access_token
  } else {
    return [false, '缺少Authorization头或access_token参数']
  }

  return [true, access_token]
}
/**
 * 根据请求找到对应的控制器并执行
 */
async function fnCtrlWrapper(ctx, next) {
  let { request, response } = ctx
  // 只处理api请求，其它返回找不到
  if (/\./.test(request.path)) {
    response.status = 404
    response.body = 'not found'
    return
  }
  //
  const { ResultFault, AccessTokenFault } = require('tms-koa/lib/response')
  const {
    DbContext,
    MongoContext,
    MongooseContext,
    PushContext,
  } = require('tms-koa').Context
  //
  const [ctrlName, CtrlClass, method] = findCtrlClassAndMethodName(ctx)

  let tmsClient

  if (Object.prototype.hasOwnProperty.call(CtrlClass, 'tmsAuthTrustedHosts')) {
    // 检查是否来源于可信主机
    if (
      !trustedHosts[ctrlName] ||
      !Array.isArray(trustedHosts[ctrlName]) ||
      trustedHosts[ctrlName].length === 0
    ) {
      return (response.body = new ResultFault('没有指定可信任的请求来源主机'))
    }

    if (!request.ip)
      return (response.body = new ResultFault('无法获得请求来源主机的ip地址'))

    const ipv4 = request.ip.split(':').pop()

    const ctrlTrustedHosts = trustedHosts[ctrlName]
    if (
      !ctrlTrustedHosts.some((rule) => {
        const re = new RegExp(rule)
        return re.test(request.ip) || re.test(ipv4)
      })
    ) {
      logger.warn(`未被信任的主机进行请求[${request.ip}]`)
      return (response.body = new ResultFault('请求来源主机不在信任列表中'))
    }
  } else if (
    typeof appConfig.auth === 'object' &&
    appConfig.auth.disabled !== true
  ) {
    // 进行用户鉴权
    let [success, access_token] = getAccessTokenByRequest(ctx)
    if (false === success)
      return (response.body = new ResultFault(access_token))
    if (appConfig.auth.jwt) {
      try {
        let decoded = jwt.verify(access_token, appConfig.auth.jwt.privateKey)
        tmsClient = require('tms-koa/lib/auth/client').createByData(decoded)
      } catch (e) {
        if (e.name === 'TokenExpiredError') {
          response.body = new AccessTokenFault('认证令牌过期')
        } else {
          response.body = new ResultFault(e.message)
        }
        return
      }
    } else if (appConfig.auth.redis) {
      const Token = require('tms-koa/lib/auth/token')
      let aResult = await Token.fetch(access_token)
      if (false === aResult[0]) {
        response.body = new AccessTokenFault(aResult[1])
        return
      }
      tmsClient = aResult[1]
    }
  }

  // 数据库连接
  let dbContext, mongoClient, mongoose, pushContext
  try {
    if (DbContext) {
      dbContext = new DbContext()
    }
    if (MongoContext) {
      mongoClient = await MongoContext.mongoClient()
    }
    if (MongooseContext) {
      mongoose = await MongooseContext.mongoose()
    }
    if (PushContext) pushContext = await PushContext.ins()
    /**
     * 创建控制器实例
     */
    const oCtrl = new CtrlClass(
      ctx,
      tmsClient,
      dbContext,
      mongoClient,
      mongoose,
      pushContext
    )
    /**
     * 检查指定的方法是否存在
     */
    if (oCtrl[method] === undefined && typeof oCtrl[method] !== 'function') {
      let logMsg = '参数错误，请求的控制器不存在(3)'
      logger.isDebugEnabled()
        ? logger.debug(logMsg, oCtrl)
        : logger.error(logMsg)
      throw new Error(logMsg)
    }
    /**
     * 是否需要事物？
     */
    // if (dbContext) {
    //   let moTrans, trans
    //   if (appConfig.tmsTransaction === true) {
    //     if (
    //       oCtrl.tmsRequireTransaction &&
    //       typeof oCtrl.tmsRequireTransaction === 'function'
    //     ) {
    //       let transMethodes = oCtrl.tmsRequireTransaction()
    //       if (transMethodes && transMethodes[method]) {
    //         moTrans = new RequestTransaction(oCtrl, {
    //           db: dbContext.mysql,
    //           userid: tmsClient.id
    //         })
    //         trans = await moTrans.begin()
    //         dbIns.transaction = trans
    //       }
    //     }
    //   }
    // }
    /**
     * 前置操作
     */
    if (oCtrl.tmsBeforeEach && typeof oCtrl.tmsBeforeEach === 'function') {
      const resultBefore = await oCtrl.tmsBeforeEach(method)
      if (resultBefore instanceof ResultFault) {
        response.body = resultBefore
        return
      }
    }
    const result = await oCtrl[method](request)
    /**
     * 结束事物
     */
    //if (moTrans && trans) await moTrans.end(trans.id)

    response.body = result

    next()
  } catch (err) {
    logger.error('控制器执行异常', err)
    let errMsg =
      typeof err === 'string' ? err : err.message ? err.message : err.toString()
    response.body = new ResultFault(errMsg)
  } finally {
    // 关闭数据库连接
    if (dbContext) {
      dbContext.end()
      dbContext = null
    }
  }
}

// 路由前缀必须以反斜杠开头
let prefix = _.get(appConfig, ['router', 'plugins', 'prefix'], '')
if (prefix && !/^\//.test(prefix)) prefix = `/${prefix}`

logger.info(`指定PLUGINS控制器前缀：${prefix}`)

const router = new Router({ prefix })
router.all('/*', fnCtrlWrapper)

module.exports = router
