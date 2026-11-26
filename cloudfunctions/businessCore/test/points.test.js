const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createDatabase, loadFunction, login, failCollectionReads } = require('./helpers')

async function fixture() {
  const state = createDatabase()
  const context = { OPENID: 'inviter', ENV: 'test-env' }
  const main = loadFunction(state, {}, context)
  const inviter = (await login(main, '13812345678')).data.userProfile.id
  const code = (await main({ action: 'getPointsViewData' })).data.inviteCode
  context.OPENID = 'new-user'
  const member = (await login(main, '13912345678')).data.userProfile.id
  return { state, context, main, inviter, member, code }
}

test('积分仅本人可读，未登录不能查询或绑定，客户端不能伪造归属', async () => {
  const { main, context, member, inviter, state, code } = await fixture()
  state.collections.get('app_user').get(inviter).point_balance = 600
  const result = await main({ action: 'getPointsViewData', payload: { userId: inviter, operatorId: inviter } })
  assert.equal(result.data.balance, 0)
  await main({ action: 'bindInviteCode', payload: { inviteCode: code, userId: inviter, operatorId: inviter, amount: 9999 } })
  assert.equal(state.collections.get('app_user').get(member).point_balance || 0, 0)
  assert.equal(state.collections.get('app_user').get(inviter).point_balance, 600)
  context.OPENID = 'guest'
  for (const action of ['getPointsViewData', 'bindInviteCode']) assert.equal((await main({ action })).code, 'LOGIN_REQUIRED')
})

test('绑定不赠分，大小写空格兼容，原码重试不重复绑定', async () => {
  const { state, main, context, inviter, member, code } = await fixture()
  state.transactionEnvelope = true
  const result = await main({ action: 'bindInviteCode', payload: { inviteCode: ' ' + code.toLowerCase() + ' ' } })
  assert.equal(result.success, true)
  assert.equal(result.data.balance, 0)
  assert.equal((await main({ action: 'bindInviteCode', payload: { inviteCode: code } })).data.repeated, true)
  assert.equal(state.collections.get('user_point_log').size, 0)
  assert.equal(state.collections.get('app_user').get(member).point_balance || 0, 0)
  assert.equal(state.collections.get('app_user').get(inviter).point_balance || 0, 0)
  let view = (await main({ action: 'getPointsViewData' })).data
  assert.equal(view.bound, true)
  assert.equal(view.boundCode, code)
  assert.equal(view.records.length, 0)
  context.OPENID = 'inviter'
  view = (await main({ action: 'getPointsViewData' })).data
  assert.equal(view.inviteCode, code)
  assert.equal(view.records.length, 0)
})

test('格式错误、不存在、自邀、已绑定和停用邀请人都有具体失败原因', async () => {
  const { state, main, context, inviter, code } = await fixture()
  const bind = inviteCode => main({ action: 'bindInviteCode', payload: { inviteCode } })
  assert.match((await bind('123')).message, /格式不正确/)
  assert.match((await bind('ON000000000000')).message, /不存在/)
  const selfCode = (await main({ action: 'getPointsViewData' })).data.inviteCode
  assert.match((await bind(selfCode)).message, /自己的/)
  state.collections.get('app_user').get(inviter).status = 0
  assert.match((await bind(code)).message, /停用/)
  state.collections.get('app_user').get(inviter).status = 1
  await bind(code)
  assert.match((await bind(selfCode)).message, /已绑定/)
  context.OPENID = 'inviter'
  state.collections.get('app_user').get(inviter).status = 0
  assert.equal((await main({ action: 'getPointsViewData' })).code, 'LOGIN_REQUIRED')
})

test('积分明细读取失败不显示伪造的零余额或泄露底层报错', async () => {
  const { main, state } = await fixture()
  const restore = failCollectionReads(state, 'user_point_log', 'collection.get:fail permission denied')
  const result = await main({ action: 'getPointsViewData' })
  assert.equal(result.success, false)
  assert.doesNotMatch(result.message, /collection|数据库|permission/)
  restore()
  assert.equal((await main({ action: 'getPointsViewData' })).success, true)
})
