Page({
  data: { src: '' },

  onLoad(query) {
    this.setData({ src: decodeURIComponent(query.src ?? '') })
    if (query.title) wx.setNavigationBarTitle({ title: decodeURIComponent(query.title) })
  },
})
