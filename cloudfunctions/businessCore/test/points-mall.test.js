const {test}=require('node:test')
const assert=require('node:assert/strict')
const {createDatabase,loadFunction,login,failCollectionReads}=require('./helpers')
const {enableOptimisticTransactions}=require('./optimistic-transactions')
async function fixture(){
 const state=createDatabase(),ctx={OPENID:'admin',ENV:'test-env'},main=loadFunction(state,{},ctx)
 const admin=(await login(main,'13812345678')).data.userProfile.id
 state.collections.get('app_user').get(admin).role=3
 ctx.OPENID='inviter';const inviter=(await login(main,'13912345678')).data.userProfile.id
 const code=(await main({action:'getPointsViewData'})).data.inviteCode
 ctx.OPENID='buyer';const buyer=(await login(main,'13712345678')).data.userProfile.id
 assert.equal((await main({action:'bindInviteCode',payload:{inviteCode:code}})).success,true)
 const call=(action,payload={})=>main({action,payload})
 const adminCall=(action,payload={})=>{ctx.OPENID='admin';return call(action,payload)}
 const buyerCall=(action,payload={})=>{ctx.OPENID='buyer';return call(action,payload)}
 const pack=[...state.collections.get('biz_package').values()].find(p=>p.asset_type===1)
 const pay=(amount,id)=>adminCall('distributeAsset',{userId:buyer,packageId:pack._id,storeId:'gaoxin',expiryDate:'2099-01-01',offlineAmount:amount,payType:'现金',requestId:id||'pay_request_'+Math.random().toString(36).slice(2)})
 const gift=async(stock=2,cost=5)=>{const r=await adminCall('savePointGift',{name:'训练毛巾',description:'到店领取',cost,stock,status:1,version:0,requestId:'gift_request_001'});assert.equal(r.success,true);return state.collections.get('point_gift').get(r.data.id)}
 const points=()=>Number(state.collections.get('app_user').get(inviter).point_balance||0)
 return {state,ctx,main,admin,inviter,buyer,adminCall,buyerCall,call,pay,gift,points}
}
test('绑定不赠分，实收100返5分，赠课不返分，重复消费请求只记一次',async()=>{
 const f=await fixture();assert.equal(f.points(),0)
 assert.equal((await f.pay(100,'same_payment_001')).success,true);assert.equal(f.points(),5)
 assert.equal((await f.pay(100,'same_payment_001')).data.repeated,true);assert.equal(f.points(),5)
 assert.equal((await f.pay(0)).success,true);assert.equal(f.points(),5)
 assert.equal((await f.pay(19.99)).success,true);assert.equal(f.points(),5)
 assert.equal((await f.pay(100.99)).success,true);assert.equal(f.points(),10)
 const logs=[...f.state.collections.get('user_point_log').values()];assert.equal(logs.length,2);assert.equal(logs[0].reward_rate,5)
})
test('管理员设置百分比含小数，未来生效，每笔向下取整，陈旧配置与客户修改被拒绝',async()=>{
 const f=await fixture();await f.pay(100);assert.equal(f.points(),5)
 assert.equal((await f.adminCall('savePointsRule',{rate:7.25,version:0})).success,true)
 await f.pay(100);assert.equal(f.points(),12)
 await f.pay(13.79);assert.equal(f.points(),12)
 assert.equal((await f.adminCall('savePointsRule',{rate:20,version:0})).success,false)
 assert.equal((await f.buyerCall('savePointsRule',{rate:100,version:1})).code,'FORBIDDEN')
 assert.equal((await f.adminCall('savePointsRule',{rate:0,version:1})).success,true);await f.pay(100);assert.equal(f.points(),12)
 for(const rate of [-1,101,0.001,NaN])assert.equal((await f.adminCall('savePointsRule',{rate,version:2})).success,false)
})
test('撤销消费按原返积分冲正，修改比例不改变已记账分，重复撤销不重复扣分',async()=>{
 const f=await fixture();await f.pay(100)
 const log=[...f.state.collections.get('user_asset_log').values()].find(l=>l.operate_type===1)
 await f.adminCall('savePointsRule',{rate:50,version:0})
 f.state.collections.get('app_user').get(f.inviter).point_balance=0
 const p={id:log._id,kind:'distribution',version:0,reason:'收款录错'}
 assert.equal((await f.adminCall('reverseOperation',p)).success,true);assert.equal(f.points(),-5)
 assert.equal((await f.adminCall('reverseOperation',p)).data.repeated,true);assert.equal(f.points(),-5)
 const logs=[...f.state.collections.get('user_point_log').values()];assert.equal(logs.at(-1).amount,-5)
})
test('兑换价格由服务端决定，扣积分减库存，重试不重复扣减，记录仅本人可见',async()=>{
 const f=await fixture(),g=await f.gift();f.state.collections.get('app_user').get(f.buyer).point_balance=20
 const p={giftId:g._id,version:1,requestId:'redeem_request_001',cost:0,userId:f.inviter}
 const r=await f.buyerCall('redeemPointGift',p);assert.equal(r.success,true)
 assert.equal(r.data.balance,15)
 assert.equal(r.data.gift.stock,1)
 assert.equal(r.data.gift.version,2)
 assert.equal(r.data.record.id,r.data.id)
 assert.equal(r.data.record.status,'pending')
 assert.equal((await f.buyerCall('redeemPointGift',p)).data.repeated,true)
 assert.equal(f.state.collections.get('app_user').get(f.buyer).point_balance,15)
 assert.equal(f.state.collections.get('point_gift').get(g._id).stock,1)
 assert.equal((await f.buyerCall('getPointsMallData')).data.records.length,1)
 f.ctx.OPENID='inviter';assert.equal((await f.call('getPointsMallData',{userId:f.buyer})).data.records.length,0)
})
test('管理员取消兑换须写原因且只返还一次，确认领取后不能取消',async()=>{
 const f=await fixture(),g=await f.gift();f.state.collections.get('app_user').get(f.buyer).point_balance=20
 const r=await f.buyerCall('redeemPointGift',{giftId:g._id,version:1,requestId:'redeem_request_001'})
 assert.equal((await f.adminCall('handleGiftRedemption',{id:r.data.id,status:'cancelled'})).success,false)
 const p={id:r.data.id,status:'cancelled',reason:'客户取消'}
 assert.equal((await f.adminCall('handleGiftRedemption',p)).success,true)
 assert.equal((await f.adminCall('handleGiftRedemption',p)).data.repeated,true)
 assert.equal(f.state.collections.get('app_user').get(f.buyer).point_balance,20)
 assert.equal(f.state.collections.get('point_gift').get(g._id).stock,2)
 const r2=await f.buyerCall('redeemPointGift',{giftId:g._id,version:3,requestId:'redeem_request_002'})
 assert.equal((await f.adminCall('handleGiftRedemption',{id:r2.data.id,status:'fulfilled'})).success,true)
 assert.equal((await f.adminCall('handleGiftRedemption',{...p,id:r2.data.id})).success,false)
})
test('积分不足、库存用尽、下架与陈旧库存均有具体失败原因',async()=>{
 const f=await fixture(),g=await f.gift(1)
 const p={giftId:g._id,version:1,requestId:'redeem_request_001'}
 assert.match((await f.buyerCall('redeemPointGift',p)).message,/积分不足/)
 f.state.collections.get('app_user').get(f.buyer).point_balance=20
 assert.equal((await f.buyerCall('redeemPointGift',p)).success,true)
 assert.match((await f.buyerCall('redeemPointGift',{...p,requestId:'redeem_request_002'})).message,/已变化/)
 assert.match((await f.buyerCall('redeemPointGift',{...p,version:2,requestId:'redeem_request_003'})).message,/已兑完/)
 f.state.collections.get('point_gift').get(g._id).status=0
 assert.match((await f.buyerCall('redeemPointGift',{...p,version:2,requestId:'redeem_request_004'})).message,/已下架/)
})
test('客户不能管理礼品和领取，未登录不可查商城，新设置不混入礼品',async()=>{
 const f=await fixture();for(const a of ['getGiftManageData','savePointGift','handleGiftRedemption'])assert.equal((await f.buyerCall(a)).code,'FORBIDDEN')
 await f.adminCall('savePointsRule',{rate:5,version:0})
 assert.equal((await f.adminCall('getGiftManageData')).data.gifts.length,0)
 f.ctx.OPENID='guest';for(const a of ['getPointsMallData','redeemPointGift'])assert.equal((await f.call(a)).code,'LOGIN_REQUIRED')
})
test('最后一件礼品两人并发抢兑只成功一人，积分和库存不为负',async()=>{
 const f=await fixture(),g=await f.gift(1)
 for(const id of [f.buyer,f.inviter])f.state.collections.get('app_user').get(id).point_balance=20
 const main2=loadFunction(f.state,{}, {OPENID:'inviter',ENV:'test-env'})
 f.ctx.OPENID='buyer';enableOptimisticTransactions(f.state)
 const payload={giftId:g._id,version:1,requestId:'redeem_concurrent_1'}
 const results=await Promise.all([f.call('redeemPointGift',payload),main2({action:'redeemPointGift',payload})])
 assert.equal(results.filter(r=>r.success).length,1);assert.equal(f.state.collections.get('point_gift').get(g._id).stock,0)
 assert.equal(f.state.collections.get('point_redemption').size,1)
 assert.equal(f.state.collections.get('app_user').get(f.buyer).point_balance+f.points(),35)
})
test('兑换写明细失败原子回滚积分、库存与兑换记录，内部报错不显示',async()=>{
 const f=await fixture(),g=await f.gift();f.state.collections.get('app_user').get(f.buyer).point_balance=20
 const native=f.state.db.collection;f.state.db.collection=name=>{const q=native(name);if(name!=='user_point_log')return q;return {...q,doc(id){return {...q.doc(id),set:async()=>{throw Error('database write failed')}}}}}
 const r=await f.buyerCall('redeemPointGift',{giftId:g._id,version:1,requestId:'redeem_request_001'})
 assert.equal(r.success,false);assert.doesNotMatch(r.message,/database|数据库/)
 assert.equal(f.state.collections.get('app_user').get(f.buyer).point_balance,20);assert.equal(f.state.collections.get('point_gift').get(g._id).stock,2);assert.equal(f.state.collections.get('point_redemption').size,0)
})
test('编辑礼品库存用版本避免覆盖已兑换变化，保存重试不重复新增',async()=>{
 const f=await fixture(),g=await f.gift()
 const p={id:g._id,name:g.name,description:g.description,cost:5,stock:8,status:1,version:1,requestId:'edit_request_001'}
 f.state.collections.get('app_user').get(f.buyer).point_balance=20
 await f.buyerCall('redeemPointGift',{giftId:g._id,version:1,requestId:'redeem_request_001'})
 assert.equal((await f.adminCall('savePointGift',p)).success,false)
 p.version=2;assert.equal((await f.adminCall('savePointGift',p)).success,true)
 assert.equal((await f.adminCall('savePointGift',p)).data.repeated,true);assert.equal(f.state.collections.get('point_gift').size,1)
})

test('派发成功后套餐下架仍可核对原请求，不额外派发或返积分',async()=>{
 const f=await fixture();assert.equal((await f.pay(100,'known_payment_001')).success,true)
 for(const p of f.state.collections.get('biz_package').values())p.status=0
 assert.equal((await f.pay(100,'known_payment_001')).data.repeated,true);assert.equal(f.points(),5)
})
test('同一消费请求并发只入账一次，不同消费并发不丢失积分',async()=>{
 const f=await fixture();enableOptimisticTransactions(f.state)
 const results=await Promise.all([f.pay(100,'parallel_payment_001'),f.pay(100,'parallel_payment_001')])
 assert.equal(results.every(r=>r.success),true);assert.equal(f.points(),5)
 await Promise.all([f.pay(100,'parallel_payment_002'),f.pay(100,'parallel_payment_003')]);assert.equal(f.points(),15)
})
test('同一兑换请求并发仅扣一次，发放与取消并发只能执行其中一个',async()=>{
 const f=await fixture(),g=await f.gift();f.state.collections.get('app_user').get(f.buyer).point_balance=20;enableOptimisticTransactions(f.state)
 const p={giftId:g._id,version:1,requestId:'parallel_redeem_001'}
 const results=await Promise.all([f.buyerCall('redeemPointGift',p),f.buyerCall('redeemPointGift',p)])
 assert.equal(results.every(r=>r.success),true);assert.equal(f.state.collections.get('app_user').get(f.buyer).point_balance,15)
 const id=results[0].data.id
 const handled=await Promise.all([f.adminCall('handleGiftRedemption',{id,status:'fulfilled'}),f.adminCall('handleGiftRedemption',{id,status:'cancelled',reason:'取消领取'})])
 assert.equal(handled.filter(r=>r.success).length,1)
 const record=f.state.collections.get('point_redemption').get(id)
 assert.equal(f.state.collections.get('app_user').get(f.buyer).point_balance,record.status==='cancelled'?20:15)
 assert.equal(f.state.collections.get('point_gift').get(g._id).stock,record.status==='cancelled'?2:1)
})

test('管理员可分页查看超过100条待领取记录，不会永久隐藏后续客户',async()=>{
 const f=await fixture()
 for(let i=0;i<151;i++)f.state.collections.get('point_redemption').set('r'+i,{_id:'r'+i,status:'pending',user_id:f.buyer,gift_name:'毛巾',cost:5,created_at:new Date(1700000000000+i*1000),updated_at:new Date(1700000000000+i*1000)})
 const ids=new Set();let offset=0,more=true
 while(more){const r=await f.adminCall('getGiftManageData',{offset});assert.equal(r.success,true);r.data.records.forEach(row=>ids.add(row.id));offset=r.data.nextOffset;more=r.data.hasMore}
 assert.equal(ids.size,151)
})

const {mediaPrefix}=require('../coach-profile')
const giftImage=(f,name='gift_cover',owner=f.admin)=>'cloud://test-env.bucket/'+mediaPrefix(owner)+name+'.jpg'
const photoPayload=(f,extra={})=>({name:'训练毛巾',description:'到店领取',cost:5,stock:2,status:1,version:0,requestId:'photo_gift_request_001',imageUrl:giftImage(f),...extra})
test('礼品图片保存后在管理员和客户商城展示，重复保存不改库存版本',async()=>{
 const f=await fixture(),p=photoPayload(f)
 const result=await f.adminCall('savePointGift',p);assert.equal(result.success,true)
 const stored=f.state.collections.get('point_gift').get(result.data.id);assert.equal(stored.image_url,p.imageUrl)
 assert.equal((await f.adminCall('getGiftManageData')).data.gifts[0].imageUrl,p.imageUrl)
 assert.equal((await f.buyerCall('getPointsMallData')).data.gifts[0].imageUrl,p.imageUrl)
 f.state.fileError=true
 assert.equal((await f.adminCall('savePointGift',p)).data.repeated,true)
 assert.equal(f.state.collections.get('point_gift').get(result.data.id).version,1)
 assert.equal((await f.adminCall('savePointGift',{...p,imageUrl:giftImage(f,'another')})).success,false)
})
test('拒绝外链、其他账号新图片、错误环境与失效图片，失败不新增礼品',async()=>{
 const f=await fixture()
 for(const imageUrl of ['https://example.test/photo.jpg','/photo.jpg',giftImage(f,'gift_foreign',f.buyer),giftImage(f).replace('test-env.bucket','foreign-env.bucket'),{url:giftImage(f)}]){
  const r=await f.adminCall('savePointGift',photoPayload(f,{imageUrl}));assert.equal(r.success,false);assert.equal(r.code,'INVALID_GIFT_IMAGE')
 }
 f.state.fileError=true;const r=await f.adminCall('savePointGift',photoPayload(f));assert.match(r.message,/已失效/)
 assert.equal(f.state.collections.get('point_gift').size,0)
})
test('另一管理员能保留已有图片编辑礼品，替换须是本人上传，移除兼容历史无图片礼品',async()=>{
 const f=await fixture(),first=photoPayload(f);const created=await f.adminCall('savePointGift',first)
 f.state.collections.get('app_user').get(f.buyer).role=3
 const p={...first,id:created.data.id,stock:3,version:1,requestId:'photo_gift_request_002'}
 assert.equal((await f.buyerCall('savePointGift',p)).success,true)
 assert.equal((await f.buyerCall('savePointGift',{...p,imageUrl:giftImage(f,'foreign_new'),version:2,requestId:'photo_gift_request_003'})).success,false)
 const newImage=giftImage(f,'new_cover',f.buyer)
 assert.equal((await f.buyerCall('savePointGift',{...p,imageUrl:newImage,version:2,requestId:'photo_gift_request_004'})).success,true)
 const legacy={...p,version:3,requestId:'photo_gift_request_005'};delete legacy.imageUrl
 assert.equal((await f.buyerCall('savePointGift',legacy)).success,true)
 assert.equal(f.state.collections.get('point_gift').get(p.id).image_url,newImage)
 assert.equal((await f.buyerCall('savePointGift',{...p,imageUrl:'',version:4,requestId:'photo_gift_request_006'})).success,true)
 assert.equal((await f.buyerCall('getPointsMallData')).data.gifts[0].imageUrl,'')
})
