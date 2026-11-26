const crypto = require('crypto')
const { validateFile } = require('./coach-profile')
const { businessDate } = require('./request-policy')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
module.exports = function({db,cloud,collections:C,getDocById,listAllCollection:list,runBusinessTransaction:run,buildSuccess,buildFail}) {
  const doc=async(name,id,tx=db)=>(await getDocById(name,id,tx)).data
  const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max
  const active=user=>user&&!user.is_deleted&&Number(user.status)===1
  const giftView=g=>({id:g._id,name:g.name,description:g.description||'',imageUrl:g.image_url||'',cost:g.cost,stock:g.stock,status:g.status,version:Number(g.version||0)})
  const recordView=r=>({id:r._id,giftName:r.gift_name,cost:r.cost,status:r.status,userName:r.user_name||'',phone:r.phone||'',date:businessDate(r.created_at)})
  async function rule(tx=db) {
    const value=await doc(C.POINT_GIFT,'_points_settings',tx)
    return {rate:value?value.rate:5,version:Number(value?.version||0)}
  }
  async function savePointsRule(event) {
    const p=event.payload||{}
    if(!Number.isFinite(p.rate)||p.rate<0||p.rate>100||Math.abs(p.rate*100-Math.round(p.rate*100))>0.000001||!integer(p.version,0,Number.MAX_SAFE_INTEGER))return buildFail('返积分比例须为0至100，最多两位小数','INVALID_POINTS_RULE')
    try {
      await run(async tx=>{
        const current=await rule(tx)
        if(current.version!==p.version)throw Error('返积分比例已变化，请刷新')
        await tx.collection(C.POINT_GIFT).doc('_points_settings').set({data:{rate:p.rate,version:current.version+1,is_deleted:true,updated_by:event.operator._id,updated_at:db.serverDate()}})
      })
      return buildSuccess({message:'返积分比例已保存'})
    }catch(e){return buildFail(e.message,'SAVE_POINTS_RULE_ERROR')}
  }
  async function consumption(tx,id,userId,amount,operatorId) {
    const config=await rule(tx)
    const buyer=await doc(C.USER,userId,tx),points=Math.floor(Math.round(Number(amount)*100)*Math.round(config.rate*100)/1000000)
    if(!buyer?.invited_by||points<1)return {}
    const inviter=await doc(C.USER,buyer.invited_by,tx)
    if(!inviter||inviter.is_deleted)return {}
    const logId='consumption_'+hash(id),before=Number(inviter.point_balance||0)
    if(!Number.isSafeInteger(before)||!Number.isSafeInteger(before+points))throw Error('积分余额异常，请联系管理员')
    await tx.collection(C.USER).doc(inviter._id).update({data:{point_balance:db.command.inc(points)}})
    await tx.collection(C.POINT_LOG).doc(logId).set({data:{user_id:inviter._id,reason:'CONSUMPTION',operator_id:operatorId,amount:points,before_balance:before,after_balance:before+points,related_user_id:userId,distribution_id:id,consumption_amount:amount,reward_rate:config.rate,created_at:db.serverDate()}})
    return {referral_user_id:inviter._id,referral_points:points,referral_point_log_id:logId}
  }
  async function reverseConsumption(tx,distribution,receiptId,operatorId) {
    if(!distribution.referral_user_id||!distribution.referral_points)return
    const user=await doc(C.USER,distribution.referral_user_id,tx)
    if(!user)throw Error('邀请人积分档案不存在，请联系管理员')
    const points=Number(distribution.referral_points),before=Number(user.point_balance||0)
    if(!Number.isSafeInteger(before)||!integer(points,1,Number.MAX_SAFE_INTEGER))throw Error('积分余额异常，请联系管理员')
    // 已兑换积分不足时允许冲正产生负余额，未来积分先抵扣；不能阻止纠正实际消费。
    await tx.collection(C.USER).doc(user._id).update({data:{point_balance:db.command.inc(-points)}})
    await tx.collection(C.POINT_LOG).doc('reverse_'+hash(receiptId)).set({data:{user_id:user._id,reason:'REVERSAL',operator_id:operatorId,correction_id:receiptId,amount:-points,before_balance:before,after_balance:before-points,distribution_id:distribution._id,related_user_id:distribution.user_id,created_at:db.serverDate()}})
  }
  async function getPointsMallData(event) {
    try {
      const [user, gifts, history] = await Promise.all([
        doc(C.USER, event.operator._id),
        list(C.POINT_GIFT, { is_deleted: false, status: 1 }),
        db.collection(C.POINT_REDEMPTION).where({ user_id: event.operator._id }).orderBy('created_at', 'desc').limit(50).get(),
      ])
      const records = history.data
      return buildSuccess({balance:Number(user.point_balance||0),gifts:gifts.map(giftView),records:records.map(recordView)})
    }catch(e){return buildFail(e.message,'MALL_VIEW_ERROR')}
  }
  async function getGiftManageData(event) {
    const offset=event?.payload?.offset||0
    if(!integer(offset,0,1000000))return buildFail('请刷新后重试','INVALID_GIFT_PAGE')
    try {
      const gifts=await list(C.POINT_GIFT,{is_deleted:false})
      const pending=(await db.collection(C.POINT_REDEMPTION).where({status:'pending'}).orderBy('created_at','asc').skip(offset).limit(21).get()).data
      const recent=(await db.collection(C.POINT_REDEMPTION).orderBy('updated_at','desc').limit(50).get()).data
      const page=pending.slice(0,20),seen=new Set(page.map(r=>r._id))
      return buildSuccess({rule:await rule(),gifts:gifts.map(giftView),hasMore:pending.length>20,nextOffset:offset+page.length,records:page.concat(offset===0?recent.filter(r=>!seen.has(r._id)):[]).map(recordView)})
    }catch(e){return buildFail(e.message,'GIFT_MANAGE_ERROR')}
  }
  async function savePointGift(event) {
    const p=event.payload||{},name=String(p.name||'').trim(),description=String(p.description||'').trim()
    if((p.id&&!/^gift_[a-f0-9]{64}$/.test(p.id))||!name||name.length>60||description.length>300||!integer(p.cost,1,1000000)||!integer(p.stock,0,100000)||![0,1].includes(p.status)||!integer(p.version,0,Number.MAX_SAFE_INTEGER)||!/^\w[\w-]{9,99}$/.test(p.requestId||''))return buildFail('请填写礼品名称、有效积分和库存','INVALID_GIFT')
    try {
      if(p.imageUrl!==undefined&&(typeof p.imageUrl!=='string'||p.imageUrl.length>500))return buildFail('请重新上传本人的图片','INVALID_GIFT_IMAGE')
      const requestedImage=p.imageUrl===undefined?undefined:p.imageUrl.trim()
      const id=p.id||'gift_'+hash(event.operator._id+':'+p.requestId)
      const fields=[name,description,p.cost,p.stock,p.status]
      if(requestedImage!==undefined)fields.push(requestedImage)
      const fingerprint=JSON.stringify(fields)
      const prior=await doc(C.POINT_GIFT,id)
      if(prior?.last_request_id===p.requestId){
        if(prior.last_fingerprint!==fingerprint)throw Error('请求内容已变化，请刷新礼品')
        return buildSuccess({id,repeated:true,message:'礼品已保存'})
      }
      if(requestedImage){
        try { validateFile(requestedImage,event.operator._id,cloud.getWXContext().ENV) }
        catch(error){
          const existing=prior
          if(existing?.image_url!==requestedImage)return buildFail('请重新上传本人的图片','INVALID_GIFT_IMAGE')
        }
        const files=await cloud.getTempFileURL({fileList:[requestedImage]})
        if(!files.fileList||files.fileList.length!==1||files.fileList[0].status!==0||!files.fileList[0].tempFileURL)return buildFail('图片上传未完成或已失效，请重新上传','INVALID_GIFT_IMAGE')
      }
      const result=await run(async tx=>{
        const old=await doc(C.POINT_GIFT,id,tx)
        if(old?.last_request_id===p.requestId){if(old.last_fingerprint!==fingerprint)throw Error('请求内容已变化，请刷新礼品');return {id,repeated:true}}
        if(p.id&&!old)throw Error('礼品不存在，请刷新')
        if(old&&Number(old.version||0)!==p.version)throw Error('礼品或库存已变化，请刷新后编辑')
        const imageUrl=requestedImage===undefined?old?.image_url||'':requestedImage
        if(imageUrl&&imageUrl!==old?.image_url)validateFile(imageUrl,event.operator._id,cloud.getWXContext().ENV)
        await tx.collection(C.POINT_GIFT).doc(id).set({data:{name,description,image_url:imageUrl,cost:p.cost,stock:p.stock,status:p.status,version:Number(old?.version||0)+1,last_request_id:p.requestId,last_fingerprint:fingerprint,updated_by:event.operator._id,created_at:old?.created_at||db.serverDate(),updated_at:db.serverDate(),is_deleted:false}})
        return {id}
      });return buildSuccess({...result,message:'礼品已保存'})
    }catch(e){return buildFail(e.message,'SAVE_GIFT_ERROR')}
  }
  async function redeemPointGift(event) {
    const p=event.payload||{}
    if(!p.giftId||!/^\w[\w-]{9,99}$/.test(p.requestId||'')||!integer(p.version,0,Number.MAX_SAFE_INTEGER))return buildFail('请选择有效礼品','INVALID_REDEMPTION')
    try {
      const id='redeem_'+hash(event.operator._id+':'+p.requestId)
      const result=await run(async tx=>{
        const old=await doc(C.POINT_REDEMPTION,id,tx)
        if(old){if(old.gift_id!==p.giftId)throw Error('请求内容已变化，请查看兑换记录');return {id,repeated:true,status:old.status}}
        const gift=await doc(C.POINT_GIFT,p.giftId,tx),user=await doc(C.USER,event.operator._id,tx)
        if(!active(user))throw Error('账号不可用，请重新登录')
        if(!gift||gift.is_deleted||gift.status!==1)throw Error('礼品已下架，请选择其他礼品')
        if(Number(gift.version||0)!==p.version)throw Error('礼品或库存已变化，请刷新后兑换')
        if(!integer(gift.stock,1,100000))throw Error('礼品已兑完，请选择其他礼品')
        const balance=Number(user.point_balance||0)
        if(!Number.isSafeInteger(balance)||!integer(gift.cost,1,1000000))throw Error('积分余额异常，请联系管理员')
        if(balance<gift.cost)throw Error('积分不足，无法兑换此礼品')
        await tx.collection(C.USER).doc(user._id).update({data:{point_balance:db.command.inc(-gift.cost)}})
        await tx.collection(C.POINT_GIFT).doc(gift._id).update({data:{stock:db.command.inc(-1),version:db.command.inc(1),updated_at:db.serverDate()}})
        await tx.collection(C.POINT_REDEMPTION).doc(id).set({data:{user_id:user._id,user_name:user.real_name||user.phone,phone:user.phone||'',gift_id:gift._id,gift_name:gift.name,cost:gift.cost,status:'pending',created_at:db.serverDate(),updated_at:db.serverDate()}})
        await tx.collection(C.POINT_LOG).doc(id).set({data:{user_id:user._id,reason:'REDEEM',amount:-gift.cost,before_balance:balance,after_balance:balance-gift.cost,redemption_id:id,created_at:db.serverDate()}})
        return {
          id, status: 'pending', balance: balance - gift.cost,
          gift: giftView({ ...gift, stock: gift.stock - 1, version: Number(gift.version || 0) + 1 }),
          record: recordView({ _id: id, gift_name: gift.name, cost: gift.cost, status: 'pending',
            user_name: user.real_name || user.phone, phone: user.phone, created_at: Date.now() }),
        }
      });return buildSuccess({...result,message:'兑换成功，请到店领取'})
    }catch(e){return buildFail(e.message,'REDEEM_GIFT_ERROR')}
  }
  async function handleGiftRedemption(event) {
    const p=event.payload||{},reason=String(p.reason||'').trim()
    if(!p.id||!['fulfilled','cancelled'].includes(p.status)||(p.status==='cancelled'&&(!reason||reason.length>200)))return buildFail('请选择兑换记录，取消须填写原因','INVALID_GIFT_ACTION')
    try {
      const result=await run(async tx=>{
        const r=await doc(C.POINT_REDEMPTION,p.id,tx)
        if(!r)throw Error('兑换记录不存在，请刷新')
        if(r.status===p.status)return {repeated:true}
        if(r.status!=='pending')throw Error('兑换记录已处理，请刷新')
        if(p.status==='cancelled'){
          const user=await doc(C.USER,r.user_id,tx),gift=await doc(C.POINT_GIFT,r.gift_id,tx)
          if(!user||!gift)throw Error('客户或礼品档案不存在，请联系管理员')
          const before=Number(user.point_balance||0)
          if(!Number.isSafeInteger(before)||!integer(r.cost,1,1000000)||!Number.isSafeInteger(before+r.cost))throw Error('积分余额异常，请联系管理员')
          await tx.collection(C.USER).doc(r.user_id).update({data:{point_balance:db.command.inc(r.cost)}})
          await tx.collection(C.POINT_GIFT).doc(r.gift_id).update({data:{stock:db.command.inc(1),version:db.command.inc(1),updated_at:db.serverDate()}})
          await tx.collection(C.POINT_LOG).doc('cancel_'+r._id).set({data:{user_id:r.user_id,reason:'REDEEM_CANCEL',amount:r.cost,before_balance:before,after_balance:before+r.cost,redemption_id:r._id,operator_id:event.operator._id,remark:reason,created_at:db.serverDate()}})
        }
        await tx.collection(C.POINT_REDEMPTION).doc(r._id).update({data:{status:p.status,reason,operator_id:event.operator._id,updated_at:db.serverDate()}})
        return {}
      });return buildSuccess({...result,message:p.status==='fulfilled'?'已确认发放':'兑换已取消，积分已退回'})
    }catch(e){return buildFail(e.message,'HANDLE_REDEMPTION_ERROR')}
  }
  return {rule,savePointsRule,consumption,reverseConsumption,getPointsMallData,getGiftManageData,savePointGift,redeemPointGift,handleGiftRedemption}
}
