import fs from 'fs'
import urllib from 'urllib'
import crypto from 'crypto'
import makeDebug from 'debug'
import Promise from 'bluebird'
import makeBase64 from 'js-base64'
import config from './config'
import Parser from './parser'
import * as util from './util'
import { RESPONSE_MESSAGE, METHOD_TYPES } from './config'

const Base64 = makeBase64.Base64
const debug = makeDebug('alipay-mobile:index')
const isPro = process.env.NODE_ENV === 'production'

export default class Alipay {
  constructor(options = {}) {
    this.privKey = options.appPrivKeyFile;
    this.publicKey = options.alipayPubKeyFile;

    if (!this.privKey || !this.publicKey) {
      throw new Error('Invalid appPrivKeyFile or alipayPubKeyFile')
    }

    if ( !fs.existsSync(this.privKey)) {
      throw new Error("Not Found appPrivKeyFile.")
    }
    if ( !fs.existsSync(this.publicKey)) {
      throw new Error("Not Found alipayPubKeyFile.")
    }
    this.normalizePem()
    const omit = ['appPrivKeyFile', 'alipayPubKeyFile']
    this.options = Object.assign({}, Object.keys(options).reduce((acc, val, index) => {
      if (omit.indexOf(val) === -1) {
        acc[val] = options[val]
      }
      return acc
    }, {}))
  }

  normalizePem () {
    this.publicKey = "-----BEGIN PUBLIC KEY-----\n"
      + fs.readFileSync(this.publicKey, 'utf-8')
      + "\n-----END PUBLIC KEY-----"
    this.privKey = "-----BEGIN RSA PRIVATE KEY-----\n" 
      + fs.readFileSync(this.privKey, 'utf-8')
      + "\n-----END RSA PRIVATE KEY-----"
  }

  buildBasicParams (method, options) {
    const params = Object.assign({}, this.options, { method })
    return Parser.parseBasic(params)
  }

  buildAPIParams (method, options) {
    return Parser.parseAPIParams(method, options)
  }

  buildParams (method, options) {
    return Promise.all([
      this.buildBasicParams(method, options),
      this.buildAPIParams(method, options)
    ])
    .then(result => {
      return Object.assign({}, result[0], { biz_content: JSON.stringify(result[1]) })
    })
    .then(params => {
      params.sign = util.makeSign(this.privKey, params)
      return params
    })
  }

  makeResponse (response) {
    const isSucceed = response => {
      return ['10000'].indexOf(response.code) !== -1    
    }
    const isPermissionDenied = response => {
      return ['40006'].indexOf(response.code) !== -1    
    }
    const parseResponse = response => {
      const metafields = [ 'code', 'msg', 'sub_code', 'sub_msg', 'sign' ]
      const result = Object.keys(response).reduce((acc, cur) => {
        if (response[cur]) {
          const field = metafields.indexOf(cur) !== -1 ? 'metadata' : 'data'
          acc[field] = response[cur]
        }
        return acc
      }, { metadata: {}, data: {} })
      return JSON.parse(JSON.stringify(result))
    }

    const result = parseResponse(response)
    const { metadata, data } = result;

    if (isSucceed(result.metadata)) {
      result.code = '0'
    } else if (isPermissionDenied(result.metadata)) {
      result.code = '-2'
    } else {
      result.code = '-1'
    }
    result.message = RESPONSE_MESSAGE[result.code]

    return result
  }

  makeRequest (params, options = {}) {
    const httpclient = urllib.create()
    const gatway = isPro ? config.ALIPAY_GETWAY : config.ALIPAY_DEV_GETWAY
    return httpclient.request(gatway, Object.assign({}, {
      data: params,
      dataType: 'json',      
      dataAsQueryString: true
    }, options))
    .then(resp => this.makeResponse(resp.data))
  }

  verifyPayment (params) {
    const isSuccess = () => {
      return ['9000'].indexOf(params.resultStatus) !== -1
    }
    const isProcessing = () => {
      return ['8000', '6004'].indexOf(params.resultStatus) !== -1
    }

    return this.buildAPIParams(METHOD_TYPES.VERIFY_PAYMENT, params)
    .then(() => {
      if (isSuccess()) {
        return this.makeResponse(params.result)
      } else {
        const code = isProcessing() ? '1' : '-1'
        return { code, message: RESPONSE_MESSAGE[code] }
      }
    })
    .catch(err => ({ code: '-1', message: err.message }))    
  }

  createOrder (params) {
    let sign;
    return this.buildParams(METHOD_TYPES.CREATE_ORDER, params)
    .then(params => {
      sign = params.sign
      return util.makeSignStr(params)
    })
    .then(signStr => {
      return signStr.split('&').reduce((acc, cur) => {
        const [key, value] = cur.split('=')
        return acc + key + '=' + encodeURIComponent(value) + '&'
      }, "").slice(0, -1)
    })
    .then(data => {
      data = data + '&sign=' + encodeURIComponent(sign)
      return { code: 0, message: RESPONSE_MESSAGE[0], data }
    })
    .catch(err => ({ code: '-1', message: err.message }))    
  }

  // sync query order status
  queryOrder (outTradeNo, tradeNo) {
    return Promise.resolve()
    .then(() => {
      if (!outTradeNo && !tradeNo) {
        throw new Error("outTradeNo and tradeNo can not both omit.")
      }
      const params = {}
      if (outTradeNo) {
        params.out_trade_no = outTradeNo
      }
      if (tradeNo) {
        params.trade_no = tradeNo
      }
      return this.buildParams(METHOD_TYPES.QUERY_ORDER, params)
      .then(params => {
        return this.makeRequest(params)
      })
    })
    .catch(err => ({ code: '-1', message: err.message }))    
  }

  makeNotifyResponse (params) {
    return Promise.resolve()
    .then(() => {
      return this.buildAPIParams(METHOD_TYPES.NOTIFY_RESPONSE, params)
    })
    .then(() => {
      const resp = { sign, 'async_notify_response': params, sign_type: params.sign_type }
      return util.verifySign(this.publicKey, resp, ['sign', 'sign_type'], params)
    })
    .then(valid => {
      const code = valid ? '0' : '-2'
      return { code, message: RESPONSE_MESSAGE[code], data: params }
    })
    .catch(err => ({ code: '-1', message: err.message }))
  }
}