const withPageState=require('../../utils/page-state')
const api=require('../../utils/business-api')
const media=require('../../utils/profile-media')
const {confirmAction,showFeedback,navigateTo}=require('../../utils/interaction')
const {getUserMessage}=require('../../utils/user-feedback')
const requestId=()=> 'mall_'+Date.now()+'_'+Math.random().toString(36).slice(2)
Page(withPageState({
 data:{runtime:{},pageData:null,tab:'gifts',submitting:false,pending:null},
 onShow(){this.syncPageData()},
 async syncPageData(){
  const id=this._syncRequestId=(this._syncRequestId||0)+1
  const app = getApp()
  this.clearOtherAccount(app.getRuntimeSnapshot())
  const runtime = await app.getRuntimeSnapshotAsync()
  if(id!==this._syncRequestId)return
  this.clearOtherAccount(runtime)
  const owner = runtime.userProfile && runtime.userProfile.id
  this.setData({runtime, pending:owner?wx.getStorageSync('mall-pending:'+owner)||null:null})
  if(!runtime.isAuthenticated)return
  try {
   const pageData = await api.getPointsMallData()
   if (id === this._syncRequestId) this.setData({pageData})
  } catch (error) {
   if (id === this._syncRequestId && error.code === 'LOGIN_REQUIRED') this.clearOtherAccount({})
   throw error
  }
 },
 clearOtherAccount(runtime) {
  const previous = this.data.runtime.userProfile
  if (!runtime.isAuthenticated || !previous || previous.id !== runtime.userProfile.id) {
   this.setData({ runtime, pageData: null, pending: null, tab: 'gifts' })
  }
 },
 onPreviewImage(e){const url=e.currentTarget.dataset.url;if(url)return media.previewPhotos([url],url)},
 goLogin(){navigateTo({url:'/pages/login/index?returnTo=profile'})},
 onTab(e){this.setData({tab:e.currentTarget.dataset.tab})},
 async onRedeem(e){
  if(this._confirming||this.data.submitting||this.data.pageBusy||this.data.pageError||this.data.pending)return
  const gift=this.data.pageData.gifts.find(g=>g.id===e.currentTarget.dataset.id)
  if(!gift||gift.stock<1)return
  this._confirming=true
  const confirmed=await confirmAction({title:'兑换礼品',contentParts:[gift.name,'\n',{text:'使用 {0} 积分，到店领取。',values:[gift.cost]}]})
  this._confirming=false
  if(!confirmed)return
  const pending={giftId:gift.id,version:gift.version,requestId:requestId()}
  await this.submit(pending)
 },
 onRetryRedeem(){if(this.data.pending)return this.submit(this.data.pending)},
 async submit(pending){
  if(this.data.submitting)return
  this.setData({submitting:true})
  const owner=this.data.runtime.userProfile&&this.data.runtime.userProfile.id,key='mall-pending:'+owner
  try{
   const runtime=await getApp().getRuntimeSnapshotAsync({force:true})
   if(!runtime.isAuthenticated||runtime.userProfile.id!==owner)throw Error('账号已变化，请重新登录')
   wx.setStorageSync(key,pending);this.setData({pending})
   const result=await api.redeemPointGift(pending)
   wx.removeStorageSync(key)
   const current = getApp().getRuntimeSnapshot()
   if (!current.isAuthenticated || current.userProfile.id !== owner) {
    this.clearOtherAccount(current)
    return
   }
   this.setData({pending:null,tab:'records'})
   showFeedback({title:result.repeated?'请查看兑换记录':result.message,icon:'success'})
   const data = this.data.pageData
   if (!result.record || !result.gift || !data || !Number.isSafeInteger(result.balance)) {
    await this.syncPageData()
    return
   }
   // An older in-flight list request must not overwrite the committed transaction.
   this._syncRequestId = (this._syncRequestId || 0) + 1
   const records = [result.record, ...data.records.filter(row => row.id !== result.record.id)].slice(0, 50)
   const gifts = data.gifts.map(gift => gift.id === result.gift.id ? result.gift : gift)
   this.setData({pageData: { ...data, balance: result.balance, gifts, records }})
  }catch(error){
   if(error.code==='INVALID_REDEMPTION'||/礼品已下架|礼品已兑完|积分不足|礼品或库存已变化|请选择有效礼品/.test(error.message||'')){wx.removeStorageSync(key);this.setData({pending:null});await this.syncPageData()}
   showFeedback({title:getUserMessage(error),icon:'none'})
  }finally{this.setData({submitting:false})}
 }
}))
