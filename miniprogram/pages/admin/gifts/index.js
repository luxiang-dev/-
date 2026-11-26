const withPageState=require('../../../utils/page-state')
const api=require('../../../utils/business-api')
const media=require('../../../utils/profile-media')
const {showFeedback,confirmAction,showModal}=require('../../../utils/interaction')
const {getUserMessage}=require('../../../utils/user-feedback')
const blank=()=>({id:'',name:'',description:'',imageUrl:'',cost:'',stock:'',status:1,version:0})
Page(withPageState({
 data:{runtime:{},hasPermission:false,pageData:null,tab:'gifts',draft:blank(),editing:false,submitting:false,rate:'',pendingSave:false,moreLoading:false,uploading:false,imageError:''},
 onUnload(){this._giftDisposed=true},
 onShow(){this.syncPageData()},
 async syncPageData(){
  if(this.data.uploading)return
  const id = this._syncRequestId = (this._syncRequestId || 0) + 1
  const app = getApp()
  this.clearOtherAdmin(app.getRuntimeSnapshot())
  const runtime = await app.getRuntimeSnapshotAsync()
  if(id!==this._syncRequestId)return
  this.clearOtherAdmin(runtime)
  this.setData({runtime,hasPermission:runtime.isAuthenticated&&runtime.role==='admin'})
  if(!this.data.hasPermission)return
  try {
   const pageData = await api.getGiftManageData()
   if (id === this._syncRequestId) this.setData({ pageData, rate: String(pageData.rule.rate), pendingSave: !!wx.getStorageSync('gift-pending:'+runtime.userProfile.id) })
  } catch (error) {
   if (id === this._syncRequestId && ['FORBIDDEN', 'LOGIN_REQUIRED'].includes(error.code)) this.clearOtherAdmin({})
   throw error
  }
 },
 clearOtherAdmin(runtime) {
  const previous = this.data.runtime.userProfile
  if (!runtime.isAuthenticated || runtime.role !== 'admin' || !previous || previous.id !== runtime.userProfile.id) {
   this.setData({ runtime, hasPermission: false, pageData: null, pendingSave: false, editing: false, draft: blank(), rate: '', tab: 'gifts' })
  }
 },
 async onMoreRecords(){
  if(this.data.moreLoading||this.data.uploading||this.data.submitting||!this.data.pageData.hasMore)return
  this.setData({moreLoading:true})
  const owner=this.data.runtime.userProfile.id,request=this._syncRequestId
  try{const data=await api.getGiftManageData({offset:this.data.pageData.nextOffset});if(this._syncRequestId!==request||this.data.runtime.userProfile.id!==owner)return
   const records=new Map(this.data.pageData.records.map(r=>[r.id,r]));for(const r of data.records)records.set(r.id,r)
   this.setData({pageData:{...this.data.pageData,records:[...records.values()],hasMore:data.hasMore,nextOffset:data.nextOffset}})
  }catch(e){showFeedback({title:getUserMessage(e),icon:'none'})}finally{this.setData({moreLoading:false})}
 },
 async onUploadImage(){
  if(!this.data.hasPermission||!this.data.editing||this.data.submitting||this.data.uploading||this.data.pendingSave||this.data.moreLoading)return
  const owner=this.data.runtime.userProfile.id
  this.setData({uploading:true,imageError:''})
  try{
   const runtime=await media.sameUser(owner)
   if(runtime.role!=='admin')throw Error('此操作需要管理员权限')
   const paths=await media.choosePhotos(1)
   if(!paths.length)return
   const uploaded=await media.uploadPhoto(paths[0],owner,'gift')
   const current=await media.sameUser(owner)
   if(current.role!=='admin')throw Error('此操作需要管理员权限')
   if(!this._giftDisposed&&this.data.editing)this.setData({draft:{...this.data.draft,imageUrl:uploaded.fileId}})
  }catch(e){if(!this._giftDisposed&&!media.cancelled(e))this.setData({imageError:getUserMessage(e,'图片上传未完成，请重新选择图片')})}
  finally{this.setData({uploading:false})}
 },
 onRemoveImage(){if(!this.data.submitting&&!this.data.uploading&&!this.data.pendingSave)this.setData({draft:{...this.data.draft,imageUrl:''},imageError:''})},
 onPreviewImage(e){const url=e.currentTarget.dataset.url;if(url)return media.previewPhotos([url],url)},
 onTab(e){if(!this.data.submitting&&!this.data.uploading&&!this.data.moreLoading)this.setData({tab:e.currentTarget.dataset.tab})},
 onNew(){if(!this.data.submitting&&!this.data.uploading&&!this.data.pendingSave)this.setData({draft:blank(),editing:true,imageError:''})},
 onEdit(e){if(this.data.submitting||this.data.uploading||this.data.pendingSave)return;const g=this.data.pageData.gifts.find(g=>g.id===e.currentTarget.dataset.id);if(g)this.setData({draft:{...g,imageUrl:g.imageUrl||'',cost:String(g.cost),stock:String(g.stock)},editing:true,imageError:''})},
 onClose(){if(!this.data.submitting&&!this.data.uploading)this.setData({editing:false})},
 onField(e){if(!this.data.submitting&&!this.data.uploading&&!this.data.pendingSave)this.setData({['draft.'+e.currentTarget.dataset.field]:e.detail.value})},
 onStatus(e){if(!this.data.submitting&&!this.data.uploading&&!this.data.pendingSave)this.setData({'draft.status':e.detail.value?1:0})},
 onRate(e){if(!this.data.submitting&&!this.data.uploading)this.setData({rate:e.detail.value})},
 async write(action,payload){
  if(this.data.submitting||this.data.uploading||this.data.moreLoading||!this.data.hasPermission)return false
  this.setData({submitting:true})
  try{const owner=this.data.runtime.userProfile.id,runtime=await getApp().getRuntimeSnapshotAsync({force:true});if(!runtime.isAuthenticated||runtime.userProfile.id!==owner||runtime.role!=='admin')throw Error('账号已变化，请重新登录');const result=await api[action](payload);showFeedback({title:result.message,icon:'success'});await this.syncPageData();return true}
  catch(e){if(action==='savePointGift'&&(['INVALID_GIFT','INVALID_GIFT_IMAGE'].includes(e.code)||/礼品或库存已变化|礼品不存在|请求内容已变化/.test(e.message||''))){wx.removeStorageSync('gift-pending:'+this.data.runtime.userProfile.id);this.setData({pendingSave:false});await this.syncPageData()}showFeedback({title:getUserMessage(e),icon:'none'});return false}
  finally{this.setData({submitting:false})}
 },
 async onSave(){
  if(this.data.submitting||this.data.uploading||this.data.moreLoading||!this.data.hasPermission)return
  const d=this.data.draft
  if(!/^\d+$/.test(d.cost)||!/^\d+$/.test(d.stock)){showFeedback({title:'请填写礼品名称、有效积分和库存',icon:'none'});return}
  const owner=this.data.runtime.userProfile.id,key='gift-pending:'+owner
  let pending=wx.getStorageSync(key)
  const payload={...d,cost:Number(d.cost),stock:Number(d.stock)},fp=JSON.stringify(payload)
  if(pending&&pending.fingerprint!==fp){showFeedback({title:'请先核对上次保存的礼品',icon:'none'});return}
  if(!pending){pending={fingerprint:fp,payload:{...payload,requestId:'gift_'+Date.now()+'_'+Math.random().toString(36).slice(2)}};try{wx.setStorageSync(key,pending);this.setData({pendingSave:true})}catch(e){showFeedback({title:getUserMessage(e),icon:'none'});return}}
  if(await this.write('savePointGift',pending.payload)){wx.removeStorageSync(key);this.setData({editing:false,pendingSave:false})}
 },
 async onRetrySave(){const key='gift-pending:'+this.data.runtime.userProfile.id,p=wx.getStorageSync(key);if(p&&await this.write('savePointGift',p.payload)){wx.removeStorageSync(key);this.setData({editing:false,pendingSave:false})}},
 onSaveRule(){if(this.data.rate.trim()==='')return;return this.write('savePointsRule',{rate:Number(this.data.rate),version:this.data.pageData.rule.version})},
 async onFulfill(e){if(await confirmAction({title:'确认发放',content:'请确认客户已领取礼品。'}))return this.write('handleGiftRedemption',{id:e.currentTarget.dataset.id,status:'fulfilled'})},
 async onCancel(e){const result=await new Promise(resolve=>showModal({title:'取消兑换',editable:true,placeholderText:'填写取消原因',success:resolve,fail:()=>resolve({confirm:false})}));if(result.confirm)return this.write('handleGiftRedemption',{id:e.currentTarget.dataset.id,status:'cancelled',reason:result.content||''})}
}))
